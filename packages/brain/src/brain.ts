import { randomUUID } from "node:crypto";
import type { BrainInput, BrainMessage, BrainProviders, HistoryItem, HubToBrain, Prepared, Provider, RunningTurn } from "@super-agent2/protocol";
import type { Clock } from "@super-agent2/programs";
import type { ProgramAdapter, ProgramEvent, ProgramHandle } from "@super-agent2/programs";
import { continuationPrompt, defaultAttachmentsFolder, promptImages, steerPrompt, turnPrompt } from "./prompt.js";
import { createProviderChoice, type ProviderChoice } from "./providers.js";
import { createRouter } from "./router.js";

export interface PrepareCall {
  readonly conversation: string;
  readonly provider: Provider;
  readonly exclude: readonly string[];
  readonly fresh: boolean;
}

export interface BrainTransport {
  send(message: BrainMessage): void;
  prepare(call: PrepareCall): Promise<Prepared>;
}

export interface BrainOptions {
  readonly adapters: ReadonlyMap<Provider, ProgramAdapter>;
  readonly order: readonly Provider[];
  readonly transport: BrainTransport;
  readonly clock: Clock;
  readonly tools: { readonly url: string; readonly token: string };
  readonly workspace: string;
  readonly attachments?: string;
  readonly maximumOpen?: number;
  readonly newId?: () => string;
  readonly router?: { readonly adapters: ReadonlyMap<Provider, ProgramAdapter>; readonly workspace: string };
}

export interface Brain {
  receive(message: HubToBrain): void;
  running(): RunningTurn[];
  status(): BrainProviders;
  readonly providers: ProviderChoice;
  maintenance(action: () => Promise<void>): Promise<void>;
  settled(): Promise<void>;
  close(): Promise<void>;
}

type Mode = "fresh" | "continue";

interface Attempt {
  readonly turn: TurnRun;
  readonly token: number;
  readonly provider: Provider;
  readonly mode: Mode;
  readonly freshSession: boolean;
}

interface Live {
  readonly provider: Provider;
  readonly turn: string;
  readonly handle: ProgramHandle;
  session: string | null;
  attempt: Attempt | undefined;
  closed: boolean;
}

interface TurnRun {
  readonly id: string;
  readonly inputs: BrainInput[];
  readonly tried: Set<Provider>;
  provider: Provider;
  tokens: number;
  current: Attempt | undefined;
  started: boolean;
  interrupting: boolean;
}

interface State {
  readonly id: string;
  live: Live | undefined;
  turn: TurnRun | undefined;
  readonly queue: BrainInput[];
  readonly handled: Set<string>;
  chain: Promise<void>;
  used: number;
}

function lastOwner(history: readonly HistoryItem[]): Pick<BrainInput, "attachments">[] {
  const owner = history.findLast((item) => item.kind === "owner");
  return owner?.kind === "owner" ? [owner] : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBrain(options: BrainOptions): Brain {
  const { transport, adapters } = options;
  const newId = options.newId ?? randomUUID;
  const maximumOpen = options.maximumOpen ?? 4;
  const attachments = options.attachments ?? defaultAttachmentsFolder;
  const choice = createProviderChoice(options.order.filter((provider) => adapters.has(provider)), options.clock);
  const status = (): BrainProviders => ({
    type: "providers",
    order: choice.order(),
    providers: choice.order().flatMap((provider) => {
      const adapter = adapters.get(provider);
      if (adapter === undefined) {
        return [];
      }
      const state = choice.reasons().get(provider);
      const now = options.clock.now();
      const available = state === undefined || (state.until !== null && state.until <= now);
      return [{ provider, model: adapter.model, effort: adapter.effort, available, until: available ? null : (state?.until ?? null) }];
    }),
  });
  let told = "";
  const tell = () => {
    const current = status();
    const key = JSON.stringify(current);
    if (key !== told) {
      told = key;
      transport.send(current);
    }
  };
  const providers: ProviderChoice = {
    ...choice,
    setOrder: (order) => {
      const changed = choice.setOrder(order.filter((provider) => adapters.has(provider)));
      tell();
      return changed;
    },
    markUnavailable: (provider, reason, until) => {
      choice.markUnavailable(provider, reason, until);
      tell();
    },
    markAvailable: (provider) => {
      choice.markAvailable(provider);
      tell();
    },
  };
  const router = options.router === undefined ? undefined : createRouter(options.router.adapters, providers.candidates, options.router.workspace);
  router?.warm();
  const states = new Map<string, State>();
  const work = new Set<Promise<void>>();
  let uses = 0;
  let closing = false;
  let maintenance: { action: () => Promise<void>; done: () => void } | undefined;
  let maintaining = false;

  const track = (promise: Promise<void>) => {
    const tracked = promise.catch(() => undefined).finally(() => work.delete(tracked));
    work.add(tracked);
  };

  const stateOf = (id: string): State => {
    let state = states.get(id);
    if (state === undefined) {
      state = { id, live: undefined, turn: undefined, queue: [], handled: new Set(), chain: Promise.resolve(), used: 0 };
      states.set(id, state);
    }
    return state;
  };

  const adapterOf = (provider: Provider): ProgramAdapter => {
    const adapter = adapters.get(provider);
    if (adapter === undefined) {
      throw new Error(`No program is configured for ${provider}`);
    }
    return adapter;
  };

  const dropLive = (state: State, live: Live | undefined = state.live) => {
    if (live === undefined) {
      return;
    }
    live.closed = true;
    live.attempt = undefined;
    if (state.live === live) {
      state.live = undefined;
    }
    const closed = live.handle.close();
    track(closed);
    return closed;
  };

  const trimOpen = () => {
    const open = [...states.values()].filter((state) => state.live !== undefined && state.turn === undefined);
    const excess = [...states.values()].filter((state) => state.live !== undefined).length - maximumOpen;
    open.sort((a, b) => a.used - b.used);
    for (const state of open.slice(0, Math.max(0, excess))) {
      dropLive(state);
    }
  };

  const finishTurn = (state: State, turn: TurnRun, outcome: "completed" | "interrupted" | "failed", reason: string | null) => {
    if (state.turn !== turn) {
      return;
    }
    turn.current = undefined;
    if (state.live !== undefined) {
      state.live.attempt = undefined;
    }
    state.turn = undefined;
    transport.send({ type: "turn.finished", conversation: state.id, turn: turn.id, outcome, reason });
    startTurn(state);
    tryMaintenance();
  };

  const nextProvider = (turn: TurnRun): Provider | undefined => providers.candidates().find((provider) => !turn.tried.has(provider));

  const unavailableSummary = (): string =>
    providers
      .order()
      .map((provider) => {
        const reason = providers.reasons().get(provider)?.reason;
        return reason === undefined ? undefined : `${provider}: ${reason}`;
      })
      .filter((line) => line !== undefined)
      .join("; ");

  const switchProvider = (state: State, attempt: Attempt, reason: string) => {
    const { turn } = attempt;
    dropLive(state);
    if (turn.interrupting) {
      finishTurn(state, turn, "interrupted", null);
      return;
    }
    const next = nextProvider(turn);
    if (next === undefined) {
      finishTurn(state, turn, "failed", unavailableSummary() || reason);
      return;
    }
    transport.send({
      type: "provider.changed",
      conversation: state.id,
      turn: turn.id,
      from: attempt.provider,
      to: next,
      model: adapterOf(next).model,
      reason,
    });
    track(run(state, turn, next, "continue", false));
  };

  const onEvent = (state: State, live: Live, event: ProgramEvent) => {
    if (live.closed) {
      return;
    }
    if (event.type === "session") {
      live.session = event.session;
      transport.send({ type: "session", conversation: state.id, provider: live.provider, session: event.session });
      return;
    }
    const attempt = live.attempt;
    if (attempt === undefined || state.turn !== attempt.turn || attempt.turn.current !== attempt) {
      if (event.type === "failed" || event.type === "unavailable") {
        if (event.type === "unavailable") {
          providers.markUnavailable(live.provider, event.reason, event.until);
        }
        dropLive(state, live);
      }
      return;
    }
    const { turn } = attempt;
    const prefix = `${attempt.token}.`;
    switch (event.type) {
      case "text":
        transport.send({ type: "text", conversation: state.id, turn: turn.id, block: prefix + event.block, delta: event.delta });
        return;
      case "tool.started":
        transport.send({
          type: "tool.started",
          conversation: state.id,
          turn: turn.id,
          call: prefix + event.call,
          name: event.name,
          input: event.input,
        });
        return;
      case "tool.output":
        transport.send({ type: "tool.output", conversation: state.id, turn: turn.id, call: prefix + event.call, delta: event.delta });
        return;
      case "tool.finished":
        transport.send({
          type: "tool.finished",
          conversation: state.id,
          turn: turn.id,
          call: prefix + event.call,
          output: event.output,
          ok: event.ok,
        });
        return;
      case "turn.finished":
        providers.markAvailable(attempt.provider);
        finishTurn(state, turn, turn.interrupting ? "interrupted" : event.outcome, null);
        return;
      case "unavailable":
        providers.markUnavailable(attempt.provider, event.reason, event.until);
        switchProvider(state, attempt, event.reason);
        return;
      case "failed":
        if (event.lostSession && !attempt.freshSession) {
          dropLive(state, live);
          track(run(state, turn, attempt.provider, attempt.mode, true));
          return;
        }
        providers.markUnavailable(attempt.provider, event.reason, null);
        switchProvider(state, attempt, event.reason);
        return;
    }
  };

  const openLive = (state: State, turn: TurnRun, provider: Provider, session: string | null): Live => {
    const adapter = adapterOf(provider);
    let live: Live | undefined;
    const handle = adapter.open(
      {
        session,
        tools: { url: options.tools.url, token: options.tools.token, conversation: state.id, turn: turn.id },
        workspace: options.workspace,
      },
      (event) => {
        if (live !== undefined) {
          onEvent(state, live, event);
        }
      },
    );
    live = { provider, turn: turn.id, handle, session, attempt: undefined, closed: false };
    return live;
  };

  const steerQueued = async (state: State) => {
    const live = state.live;
    const turn = state.turn;
    if (live === undefined || turn === undefined || !turn.started) {
      return;
    }
    while (state.queue.length > 0 && state.turn === turn && state.live === live) {
      const input = state.queue[0];
      if (input === undefined) {
        return;
      }
      const result = await live.handle
        .steer(steerPrompt(input, attachments), promptImages([input], attachments))
        .catch(() => "queued" as const);
      if (result !== "steered" || state.turn !== turn) {
        return;
      }
      state.queue.shift();
      turn.inputs.push(input);
      transport.send({ type: "input.taken", conversation: state.id, turn: turn.id, input: input.id });
    }
  };

  const run = async (state: State, turn: TurnRun, provider: Provider, mode: Mode, freshSession: boolean): Promise<void> => {
    turn.tokens += 1;
    const attempt: Attempt = { turn, token: turn.tokens, provider, mode, freshSession };
    turn.current = attempt;
    turn.provider = provider;
    turn.tried.add(provider);
    let prepared: Prepared;
    try {
      prepared = await transport.prepare({
        conversation: state.id,
        provider,
        exclude: turn.inputs.flatMap((input) => [
          ...(mode === "fresh" ? [input.id] : []),
          ...(input.quote === undefined ? [] : [input.quote.id]),
        ]),
        fresh: freshSession,
      });
    } catch (error) {
      if (state.turn === turn && turn.current === attempt) {
        finishTurn(state, turn, "failed", messageOf(error));
      }
      return;
    }
    if (state.turn !== turn || turn.current !== attempt || closing) {
      return;
    }
    if (turn.interrupting) {
      finishTurn(state, turn, "interrupted", null);
      return;
    }
    let live = state.live;
    try {
      if (live !== undefined && (live.turn !== turn.id || live.provider !== provider || freshSession)) {
        await dropLive(state, live)?.catch(() => undefined);
        if (state.turn !== turn || turn.current !== attempt || closing) {
          return;
        }
        if (turn.interrupting) {
          finishTurn(state, turn, "interrupted", null);
          return;
        }
        live = undefined;
      }
      if (live === undefined) {
        live = openLive(state, turn, provider, freshSession ? null : prepared.session);
        state.live = live;
        trimOpen();
      }
      uses += 1;
      state.used = uses;
      live.attempt = attempt;
      turn.started = true;
      if (mode === "fresh") {
        live.handle.start(turnPrompt(prepared.history, turn.inputs, prepared.memory, attachments), promptImages(turn.inputs, attachments));
      } else {
        live.handle.start(continuationPrompt(prepared.history, prepared.memory, attachments, turn.inputs), promptImages(lastOwner(prepared.history), attachments));
      }
    } catch (error) {
      providers.markUnavailable(provider, messageOf(error), null);
      switchProvider(state, attempt, messageOf(error));
      return;
    }
    await steerQueued(state);
  };

  const startTurn = (state: State) => {
    if (closing || maintenance !== undefined || maintaining || state.turn !== undefined || state.queue.length === 0) {
      return;
    }
    const inputs = state.queue.splice(0);
    const candidates = providers.candidates();
    const provider = candidates[0] ?? providers.order()[0];
    if (provider === undefined) {
      return;
    }
    const turn: TurnRun = {
      id: newId(),
      inputs,
      tried: new Set(),
      provider,
      tokens: 0,
      current: undefined,
      started: false,
      interrupting: false,
    };
    state.turn = turn;
    transport.send({
      type: "turn.started",
      conversation: state.id,
      turn: turn.id,
      provider,
      model: adapterOf(provider).model,
      inputs: inputs.map((input) => input.id),
    });
    track(run(state, turn, provider, "fresh", false));
  };

  const accept = async (state: State, input: BrainInput) => {
    if (state.handled.has(input.id)) {
      return;
    }
    state.handled.add(input.id);
    state.queue.push(input);
    if (state.turn === undefined) {
      startTurn(state);
      return;
    }
    await steerQueued(state);
  };

  const interrupt = (state: State) => {
    const turn = state.turn;
    if (turn === undefined) {
      return;
    }
    turn.interrupting = true;
    const live = state.live;
    if (live?.attempt !== undefined && live.attempt.turn === turn) {
      try {
        live.handle.interrupt();
      } catch (error) {
        finishTurn(state, turn, "interrupted", messageOf(error));
      }
    }
  };

  const tryMaintenance = () => {
    if (closing || maintaining || maintenance === undefined || [...states.values()].some((state) => state.turn !== undefined)) {
      return;
    }
    const task = maintenance;
    maintenance = undefined;
    maintaining = true;
    for (const state of states.values()) {
      dropLive(state);
    }
    const outstanding = [...work, router?.reset()];
    track((async () => {
      try {
        await Promise.all(outstanding);
        await task.action();
      } finally {
        maintaining = false;
        task.done();
        if (!closing) {
          router?.warm();
        }
        for (const state of states.values()) {
          startTurn(state);
        }
        tryMaintenance();
      }
    })());
  };

  return {
    providers,
    maintenance: (action) => new Promise<void>((done) => {
      if (closing || maintenance !== undefined || maintaining) {
        done();
        return;
      }
      maintenance = { action, done };
      tryMaintenance();
    }),
    status,
    receive: (message) => {
      if (closing) {
        return;
      }
      if (message.type === "order") {
        providers.setOrder(message.order);
        if (maintenance === undefined && !maintaining) {
          router?.warm();
        }
        return;
      }
      if (message.type === "route") {
        const reply = async () => {
          const choice = await (maintenance === undefined && !maintaining ? router?.route(message).catch(() => null) : null);
          if (!closing) {
            transport.send({ type: "routed", request: message.request, choice: choice ?? null });
          }
        };
        track(reply());
        return;
      }
      if (message.type === "input") {
        const state = stateOf(message.conversation);
        const next = state.chain.then(() => accept(state, message.input));
        state.chain = next.catch(() => undefined);
        track(next);
        return;
      }
      if (message.type === "interrupt") {
        const state = states.get(message.conversation);
        if (state !== undefined) {
          interrupt(state);
        }
      }
    },
    running: () =>
      [...states.values()].flatMap((state) => (state.turn === undefined ? [] : [{ conversation: state.id, turn: state.turn.id }])),
    settled: async () => {
      while (work.size > 0) {
        await Promise.all([...work]);
      }
    },
    close: async () => {
      closing = true;
      maintenance?.done();
      maintenance = undefined;
      for (const state of states.values()) {
        dropLive(state);
      }
      await router?.reset();
      while (work.size > 0) {
        await Promise.all([...work]);
      }
    },
  };
}
