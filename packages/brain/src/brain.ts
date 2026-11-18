import { randomUUID } from "node:crypto";
import type { BrainInput, BrainMessage, BrainProviders, HistoryItem, HubToBrain, Prepared, Provider, RunningTurn } from "@super-agent2/protocol";
import type { Clock } from "@super-agent2/programs";
import type { ProgramAdapter, ProgramEvent, ProgramHandle } from "@super-agent2/programs";
import type { Schedule } from "./link.js";
import { continuationPrompt, defaultAttachmentsFolder, promptImages, turnPrompt } from "./prompt.js";
import { defaultSoftShare, fallbackInputCapacity, topicPrompt } from "./seed.js";
import { createProviderChoice, type ProviderChoice } from "./providers.js";

export interface PrepareCall {
  readonly conversation: string;
  readonly provider: Provider;
  readonly exclude: readonly string[];
  readonly fresh: boolean;
  readonly seed?: boolean;
  readonly steer?: boolean;
  readonly continuing?: boolean;
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
  readonly idleMilliseconds?: number;
  readonly schedule?: Schedule;
  readonly seedSoftShare?: number;
  readonly inputCapacity?: Readonly<Record<Provider, number>>;
  readonly newId?: () => string;
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
  idleAt: number;
  waiting: number;
  retiring: Promise<void> | undefined;
  steering: boolean;
}

export const defaultIdleMilliseconds = 2 * 60 * 60 * 1000;

const idleSchedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, Math.min(milliseconds, 2 ** 31 - 1));
  timer.unref();
  return () => clearTimeout(timer);
};

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
  const schedule = options.schedule ?? idleSchedule;
  const idleMilliseconds = options.idleMilliseconds ?? defaultIdleMilliseconds;
  const softShare = options.seedSoftShare ?? defaultSoftShare;
  const inputCapacity = options.inputCapacity ?? fallbackInputCapacity;
  const learnedCapacity = new Map<Provider, number>();
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
  const states = new Map<string, State>();
  const work = new Set<Promise<void>>();
  let uses = 0;
  let arrivals = 0;
  let cancelIdle: (() => void) | undefined;
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
      state = { id, live: undefined, turn: undefined, queue: [], handled: new Set(), chain: Promise.resolve(), used: 0, idleAt: 0, waiting: 0, retiring: undefined, steering: false };
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

  const dropLive = (state: State) => {
    const live = state.live;
    if (live === undefined) {
      return state.retiring;
    }
    live.closed = true;
    live.attempt = undefined;
    state.live = undefined;
    const retiring = Promise.resolve().then(() => live.handle.close()).catch(() => undefined).then(() => {
      state.retiring = undefined;
      pump();
    });
    state.retiring = retiring;
    track(retiring);
    return retiring;
  };

  const idle = (state: State) => state.live !== undefined && state.turn === undefined && state.queue.length === 0 && !state.steering;
  const occupiesSlot = (state: State) => state.live !== undefined || state.turn !== undefined || state.retiring !== undefined;

  const finishTurn = (state: State, turn: TurnRun, outcome: "completed" | "interrupted" | "failed", reason: string | null, applied = false) => {
    if (state.turn !== turn) {
      return;
    }
    turn.current = undefined;
    if (state.live !== undefined) {
      state.live.attempt = undefined;
    }
    state.turn = undefined;
    state.used = ++uses;
    state.idleAt = options.clock.now();
    transport.send({ type: "turn.finished", conversation: state.id, turn: turn.id, outcome, reason, applied });
    pump();
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
    if (event.type === "capacity") {
      learnedCapacity.set(live.provider, event.tokens);
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
        dropLive(state);
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
        finishTurn(state, turn, turn.interrupting ? "interrupted" : event.outcome, null, true);
        return;
      case "unavailable":
        providers.markUnavailable(attempt.provider, event.reason, event.until);
        switchProvider(state, attempt, event.reason);
        return;
      case "failed":
        if (event.lostSession && !attempt.freshSession) {
          dropLive(state);
          track(run(state, turn, attempt.provider, attempt.mode, true));
          return;
        }
        providers.markUnavailable(attempt.provider, event.reason, null);
        switchProvider(state, attempt, event.reason);
        return;
    }
  };

  const openLive = (state: State, provider: Provider, session: string | null): Live => {
    const adapter = adapterOf(provider);
    let live: Live | undefined;
    const handle = adapter.open(
      {
        session,
        tools: { url: options.tools.url, token: options.tools.token, conversation: state.id },
        workspace: options.workspace,
      },
      (event) => {
        if (live !== undefined) {
          onEvent(state, live, event);
        }
      },
    );
    live = { provider, handle, session, attempt: undefined, closed: false };
    return live;
  };

  const preparePrompt = (state: State, provider: Provider, inputs: readonly BrainInput[], prepared: Prepared, continuing = false) =>
    topicPrompt({
      conversation: state.id, inputs, prepared, provider, capacity: learnedCapacity.get(provider) ?? inputCapacity[provider],
      softShare, attachments, continuing,
    });

  const steerQueued = async (state: State) => {
    const live = state.live;
    const turn = state.turn;
    if (live === undefined || turn === undefined || live.attempt !== turn.current || !turn.started || state.steering) {
      return;
    }
    state.steering = true;
    try {
      while (state.queue.length > 0 && state.turn === turn && state.live === live && !turn.interrupting) {
        const input = state.queue[0];
        if (input === undefined) {
          return;
        }
        const prepared = await transport.prepare({ conversation: state.id, provider: live.provider, exclude: [], fresh: false, steer: true });
        if (state.turn !== turn || state.live !== live || turn.interrupting) {
          return;
        }
        const prompt = preparePrompt(state, live.provider, [input], prepared);
        const result = await live.handle.steer(prompt.text, prompt.images);
        if (result !== "steered" || state.turn !== turn || state.live !== live) {
          return;
        }
        turn.inputs.push(input);
        state.queue.shift();
        transport.send({
          type: "input.taken", conversation: state.id, turn: turn.id, input: input.id,
          ...(prepared.memoryRevision === undefined ? {} : { memoryRevision: prepared.memoryRevision }),
        });
      }
    } catch {
      return;
    } finally {
      state.steering = false;
      pump();
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
        exclude: turn.inputs.map((input) => input.id),
        fresh: freshSession,
        seed: state.live?.provider !== provider || freshSession || mode === "continue",
        continuing: mode === "continue",
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
    if (live !== undefined && (live.provider !== provider || freshSession || (prepared.board !== undefined && live.session !== prepared.session))) {
      dropLive(state);
      live = undefined;
    }
    await state.retiring;
    if (closing || state.turn !== turn || turn.current !== attempt) {
      return;
    }
    if (turn.interrupting) {
      finishTurn(state, turn, "interrupted", null);
      return;
    }

    let prompt: ReturnType<typeof topicPrompt>;
    try {
      if (prepared.board !== undefined || prepared.seed !== undefined || turn.inputs.some((input) => input.quote !== undefined)) {
        prompt = preparePrompt(state, provider, turn.inputs, prepared, mode === "continue");
      } else if (mode === "fresh") {
        prompt = { text: turnPrompt(prepared.history, turn.inputs, prepared.memory, attachments), images: promptImages(turn.inputs, attachments) };
      } else {
        prompt = { text: continuationPrompt(prepared.history, prepared.memory, attachments), images: promptImages(lastOwner(prepared.history), attachments) };
      }
    } catch (error) {
      finishTurn(state, turn, "failed", messageOf(error));
      return;
    }
    try {
      if (live === undefined) {
        live = openLive(state, provider, freshSession ? null : prepared.session);
        state.live = live;
      }
      live.attempt = attempt;
      turn.started = true;
      live.handle.start(prompt.text, prompt.images);
    } catch (error) {
      providers.markUnavailable(provider, messageOf(error), null);
      switchProvider(state, attempt, messageOf(error));
      return;
    }
    await steerQueued(state);
  };

  const startTurn = (state: State) => {
    const candidates = providers.candidates();
    const provider = candidates[0] ?? providers.order()[0];
    if (provider === undefined) {
      return;
    }
    const turn: TurnRun = {
      id: newId(),
      inputs: state.queue.splice(0),
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
      inputs: turn.inputs.map((input) => input.id),
    });
    track(run(state, turn, provider, "fresh", false));
  };

  const accept = async (state: State, input: BrainInput) => {
    if (state.handled.has(input.id)) {
      return;
    }
    state.handled.add(input.id);
    if (state.queue.length === 0) {
      state.waiting = ++arrivals;
    }
    state.queue.push(input);
    if (state.turn === undefined) {
      pump();
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
    track((async () => {
      try {
        await Promise.all([...work]);
        await task.action();
      } finally {
        maintaining = false;
        task.done();
        pump();
      }
    })());
  };

  const pump = () => {
    cancelIdle?.();
    cancelIdle = undefined;
    if (closing || maintaining) {
      return;
    }
    if (maintenance !== undefined) {
      tryMaintenance();
      return;
    }
    const now = options.clock.now();
    for (const state of states.values()) {
      if (idle(state) && now - state.idleAt >= idleMilliseconds) {
        dropLive(state);
      }
    }
    const waiting = [...states.values()]
      .filter((state) => state.turn === undefined && state.queue.length > 0 && state.retiring === undefined && !state.steering)
      .sort((a, b) => a.waiting - b.waiting);
    let open = [...states.values()].filter(occupiesSlot).length;
    for (const state of waiting) {
      if (state.live !== undefined || open < maximumOpen) {
        if (state.live === undefined) {
          open += 1;
        }
        startTurn(state);
      } else if (![...states.values()].some((candidate) => candidate.retiring !== undefined && candidate.turn === undefined)) {
        const oldest = [...states.values()].filter((candidate) =>
          candidate.live !== undefined && candidate.turn === undefined && !candidate.steering
          && (candidate.queue.length === 0 || candidate.waiting > state.waiting),
        ).sort((a, b) => a.used - b.used)[0];
        if (oldest !== undefined) {
          dropLive(oldest);
          break;
        }
      }
    }
    const idleAt = Math.min(...[...states.values()].filter(idle).map((state) => state.idleAt));
    if (Number.isFinite(idleAt)) {
      cancelIdle = schedule(pump, Math.max(0, idleAt + idleMilliseconds - now));
    }
  };

  return {
    providers,
    maintenance: (action) => new Promise<void>((done) => {
      if (closing || maintenance !== undefined || maintaining) {
        done();
        return;
      }
      maintenance = { action, done };
      pump();
    }),
    status,
    receive: (message) => {
      if (closing) {
        return;
      }
      if (message.type === "order") {
        providers.setOrder(message.order);
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
      cancelIdle?.();
      maintenance?.done();
      maintenance = undefined;
      for (const state of states.values()) {
        dropLive(state);
      }
      while (work.size > 0) {
        await Promise.all([...work]);
      }
    },
  };
}
