import { ticketProject, ticketReference } from "@super-agent2/protocol";
import { createHash } from "node:crypto";
import { text } from "@super-agent2/catalog";
import {
  applyChange,
  arrangedAfter,
  canStartAlone,
  canQueueStart,
  cardKey,
  chainDifficulty,
  type ChainNode,
  type ChainStartItem,
  type ChoiceChange,
  type Difficulty,
  findCycle,
  fitsForm,
  hasStartPins,
  isComplete,
  type MachineChoice,
  noOwnerChoice,
  type OwnerChoice,
  ownerGivesUnoffered,
  type StartChoice,
  GeneratedText,
  inWorkingOrder,
  indexOf,
  type Platform,
  type ProgramId,
  RepositoryName,
  requiredMachineFor,
  readyToBegin,
  type StartCard,
  startGaps,
  type Ticket,
  type TicketIssue,
  type TicketKind,
  type ScreenshotReport,
  unmetWaits,
  waitEdges,
  waitsForProvider,
} from "@super-agent2/protocol";
import { z } from "zod";
import { scheduleAccess } from "./schedule-access.js";
import type { AccessVerifier, OwnerProof } from "./access.js";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { type ChosenRun, type DefaultsStatement, TicketError, type TicketService, type TicketWork, type WaitToSet } from "./tickets.js";
import type { TicketTurn } from "./ticket-versions.js";

export interface ChainSpec {
  readonly name: string;
  readonly repository: string;
  readonly issues: readonly number[];
  readonly after?: readonly (string | number)[] | undefined;
  readonly afterDeployment?: boolean | undefined;
  readonly title?: GeneratedText | undefined;
  readonly summary?: GeneratedText | undefined;
  readonly kind?: TicketKind | undefined;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
}

export interface IssueDifficulty {
  readonly number: number;
  readonly difficulty: Difficulty;
}

export interface DefaultsSpec {
  readonly ticket: number;
  readonly kind: TicketKind;
  readonly issues?: readonly IssueDifficulty[] | undefined;
  readonly difficulty?: Difficulty | undefined;
  readonly reason: GeneratedText;
  readonly platform: Platform;
  readonly machine?: string | undefined;
  readonly ownerEngine?: ProgramId | undefined;
}

export type StateOutcome = { readonly ok: true; readonly tickets: readonly Ticket[] } | { readonly ok: false; readonly reason: string };

export interface ChainDefaults {
  subscribe?(listener: () => void): () => void;
  resolve(ticket: Ticket, owner?: OwnerChoice): StartChoice;
  machinesFor(ticket: Ticket): MachineChoice[];
  machines(): MachineChoice[];
}

export interface ArrangedChain {
  readonly name: string;
  readonly ticket: Ticket;
}

export type ArrangeOutcome =
  | { readonly ok: true; readonly chains: readonly ArrangedChain[]; readonly joined: readonly number[] }
  | { readonly ok: false; readonly reason: string };

export type TicketOutcome = { readonly ok: true; readonly ticket: Ticket; readonly began: readonly Ticket[] } | { readonly ok: false; readonly reason: string };

export interface ChainArranger {
  arrange(chains: readonly ChainSpec[], turn?: TicketTurn): ArrangeOutcome;
  state(defaults: readonly DefaultsSpec[], turn?: TicketTurn): StateOutcome;
  deployed(ticket: number, turn?: TicketTurn): TicketOutcome;
  proceed(ticket: number, turn?: TicketTurn): TicketOutcome;
}

export interface OwnerStart {
  readonly assertion: OwnerProof;
  readonly chains: readonly ChainStartItem[];
}

export type StartError = "forbidden" | "conflict" | "incomplete" | "unsupported" | "not_found";

export type StartOutcome = { readonly ok: true; readonly tickets: readonly Ticket[] } | { readonly ok: false; readonly error: StartError };

export interface OwnerChange {
  readonly assertion: OwnerProof;
  readonly ticket: number;
  readonly change: ChoiceChange;
}

export const reassignableStates: readonly string[] = ["waiting", "working", "verifying"];

export interface ChainStarter {
  start(given: OwnerStart): Promise<StartOutcome>;
  choose(given: OwnerChange): Promise<StartOutcome>;
  reassign(given: OwnerChange): Promise<StartOutcome>;
}

export type Tell = (ticket: number, notice: string, prompt: string, hidden?: boolean, screenshots?: readonly ScreenshotReport[]) => void;

export interface Chains {
  readonly arranger: ChainArranger;
  readonly starter: ChainStarter;
  startScheduled(run: string): number | undefined;
  cards(): StartCard[];
  resume(): void;
  idle(): Promise<void>;
  close(): void;
}

export interface ChainsOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly tickets: TicketService;
  readonly verify: AccessVerifier;
  readonly ownerEmail: string;
  readonly work?: TicketWork;
  readonly tell?: Tell;
  readonly defaults: ChainDefaults;
}

const everyTicket = 100_000;
const providerBlock = JSON.stringify({ en: "Waiting for a worker provider to become available.", zh: text("chains.missing.provider"), provider: true });

export interface ShownChain {
  readonly ticket: Ticket;
  readonly choice: StartChoice;
}

export function chainFingerprint(shown: readonly ShownChain[]): string {
  const shape = shown.map(({ ticket, choice }) => [
    ticket.id,
    ticket.state,
    ticket.form,
    ticket.repository,
    ticket.requiredMachine,
    ...(ticket.deploymentTargets === undefined ? [] : [ticket.deploymentTargets]),
    ticket.machinePinned,
    ticket.enginePin,
    ticket.commitRef,
    ticket.deploys,
    ticket.localBuild,
    ticket.kind,
    ticket.difficulty,
    ticket.platform,
    ticket.title.en,
    ticket.title.zh,
    ticket.issues.map((issue) => [issue.repository, issue.number, issue.title.en, issue.title.zh]),
    ticket.waits.map((wait) => [wait.ticket, wait.deployment, wait.waived]),
    ticket.difficultyReason === null ? null : [ticket.difficultyReason.en, ticket.difficultyReason.zh],
    [choice.machine, choice.engine, choice.model, choice.effort, choice.by.machine, choice.by.engine, choice.by.model, choice.by.effort, choice.missing],
  ]);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function issueKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

export function chosenRun(choice: StartChoice | undefined): ChosenRun | undefined {
  if (choice === undefined || !isComplete(choice) || choice.machine === null || choice.engine === null || choice.model === null || choice.effort === null) {
    return undefined;
  }
  return { machine: choice.machine, engine: choice.engine, model: choice.model, effort: choice.effort, by: choice.by };
}

const BeginRow = z.object({ ticket_id: z.number().int() });

function antigravityForCode(ticket: Ticket, owner: OwnerChoice): boolean {
  return ticket.form === "code" && owner.engine === "antigravity";
}

function pinnedBlock(ticket: Ticket, choice: StartChoice): string {
  const where = ticket.machinePinned === true ? choice.machine : null;
  const engine = ticket.enginePin === undefined ? null : choice.engine;
  const en = where === null ? [] : [`machine ${where}`];
  const zh = where === null ? [] : [`指定机器 ${where}`];
  if (engine !== null) {
    en.push(`engine ${engine}`);
    zh.push(`指定引擎 ${text(`engine.${engine}`)}`);
  }
  const reasons = choice.missing.filter((part) => part !== "defaults").map((part) =>
    part === "provider" && engine !== null ? text("chains.missing.pinnedProvider")
      : part === "machine" && where !== null ? text("chains.missing.pinnedMachine")
        : text(`chains.missing.${part}`),
  );
  return JSON.stringify({
    en: `Waiting for the owner's ${en.join(" and ")} (${choice.missing.join(", ")}).`,
    zh: `等待${zh.join("和")}（${reasons.join("、")}）`,
    pinned: true,
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function described(ticket: Ticket): string {
  return `ticket ${ticketReference(ticket)} (${ticket.title.en})`;
}

export function createChains(options: ChainsOptions): Chains {
  const { tickets, clock } = options;
  const { connection } = options.database;
  const scheduled = scheduleAccess(options.database);
  const owner = options.ownerEmail.toLowerCase();
  const tell: Tell = options.tell ?? (() => undefined);
  const work = options.work;
  const { defaults } = options;
  const running = new Set<Promise<void>>();
  const toldStopped = new Set<number>();
  let advancing = false;
  let again = false;
  let closed = false;

  const insertBegin = connection.prepare(
    "INSERT INTO ticket_begins (ticket_id, due_at) VALUES (?, ?) ON CONFLICT (ticket_id) DO UPDATE SET due_at = excluded.due_at, done_at = NULL, failed_at = NULL, failure = NULL",
  );
  const selectBlock = connection.prepare("SELECT value FROM hub_settings WHERE key = ?");
  const saveBlock = connection.prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  const deleteBlock = connection.prepare("DELETE FROM hub_settings WHERE key = ?");
  const hasUnchosenWaiting = connection.prepare("SELECT 1 FROM tickets WHERE state = 'waiting' AND chosen_at IS NULL LIMIT 1");
  const markBegun = connection.prepare("UPDATE ticket_begins SET done_at = ? WHERE ticket_id = ? AND done_at IS NULL AND failed_at IS NULL");
  const markFailed = connection.prepare("UPDATE ticket_begins SET failed_at = ?, failure = ? WHERE ticket_id = ? AND done_at IS NULL AND failed_at IS NULL");
  const selectDue = connection.prepare(
    "SELECT b.ticket_id FROM ticket_begins b JOIN tickets t ON t.id = b.ticket_id WHERE b.done_at IS NULL AND b.failed_at IS NULL AND t.state = 'working' ORDER BY b.ticket_id",
  );

  const openTickets = (): Ticket[] => tickets.list({ open: true, limit: everyTicket });

  const ownerStartList = (list: readonly Ticket[]): Ticket[] =>
    list.filter((ticket) => ticket.state !== "pending" || ticket.scheduleRun === undefined || !scheduled.pending(ticket.scheduleRun));

  const withBefore = (list: readonly Ticket[]): Map<number, Ticket> => {
    const index = indexOf(list);
    for (const ticket of list) {
      for (const wait of ticket.waits) {
        if (!index.has(wait.ticket)) {
          const before = tickets.get(wait.ticket);
          if (before !== undefined) {
            index.set(before.id, before);
          }
        }
      }
    }
    return index;
  };

  const fingerprintOf = (root: number, list: readonly Ticket[]): string | undefined => {
    const index = indexOf(list);
    const closure = arrangedAfter([root], list);
    if (closure.length === 0) {
      return undefined;
    }
    return chainFingerprint(
      closure.flatMap((id) => {
        const ticket = index.get(id);
        return ticket === undefined ? [] : [{ ticket, choice: defaults.resolve(ticket) }];
      }),
    );
  };

  const begin = (ids: readonly number[]) => {
    for (const id of ids) {
      const ticket = tickets.get(id);
      if (ticket === undefined || ticket.state !== "working") {
        continue;
      }
      const task = (async () => {
        try {
          await work?.begin(ticket);
          markBegun.run(clock.now(), id);
        } catch (error) {
          const reason = reasonOf(error);
          markFailed.run(clock.now(), reason, id);
          if (!closed) {
            tickets.change((writes) => writes.touched(id));
            tell(
              ticket.id,
              text("notice.ticketBeginFailed", { ticket: ticket.code }),
              [
                `[hub] The owner started ${described(ticket)}, but its work could not begin: ${reason}`,
                "It stays recorded as working, with that failure. Decide what happens to it: stop it with stop_ticket and arrange the work again, or find and fix the cause. Tell the owner what you decided.",
              ].join("\n"),
            );
          }
        }
      })();
      const tracked = task.finally(() => running.delete(tracked));
      running.add(tracked);
    }
  };

  const advance = () => {
    if (closed) {
      return;
    }
    if (advancing) {
      again = true;
      return;
    }
    advancing = true;
    try {
      do {
        again = false;
        const list = openTickets();
        const index = withBefore(list);
        const ready = list.filter((ticket) => ticket.state === "waiting" && readyToBegin(ticket, index)).map((ticket) => ticket.id);
        if (ready.length === 0) {
          continue;
        }
        const notices: { ticket: Ticket; choice: StartChoice; reason: string; machines: MachineChoice[] }[] = [];
        const began = tickets.change((writes) =>
          ready.filter((id) => {
            const ticket = writes.get(id);
            if (ticket?.state !== "waiting") {
              return false;
            }
            if (ticket.chosenAt === null && (ticket.light !== undefined || ticket.scheduleRun !== undefined || hasStartPins(ticket) || ticket.startBlock != null)) {
              const choice = defaults.resolve(ticket);
              const run = chosenRun(choice);
              if (run === undefined) {
                if (hasStartPins(ticket)) {
                  const block = pinnedBlock(ticket, choice);
                  const key = `start_block:${id}`;
                  if (selectBlock.get(key)?.["value"] !== block) {
                    saveBlock.run(key, block, clock.now());
                    writes.touched(id);
                  }
                  return false;
                }
                const wanted = [ticket.platform ?? "any", choice.engine ?? "not set", choice.model ?? "not set", choice.effort ?? "not set"].join(" ");
                const missing = choice.missing.join(", ");
                const en = `missing ${missing}; wanted ${wanted}${ticket.requiredMachine === null ? "" : ` on ${ticket.requiredMachine}`}`;
                const names = { defaults: "\u9ed8\u8ba4\u8bbe\u7f6e", provider: "\u4f9b\u5e94\u5546", machine: "\u673a\u5668", engine: "\u5f15\u64ce", slot: "\u7a7a\u95f2\u69fd\u4f4d", model: "\u6a21\u578b", effort: "\u63a8\u7406\u5f3a\u5ea6" };
                const zh = `\u65e0\u6cd5\u5f00\u59cb\uff1a\u7f3a\u5c11 ${choice.missing.map((part) => names[part]).join("\u3001")}\uff1b\u9700\u8981 ${wanted}${ticket.requiredMachine === null ? "" : `\uff0c\u6307\u5b9a\u673a\u5668 ${ticket.requiredMachine}`}`;
                const key = `start_block:${id}`;
                const previous = selectBlock.get(key) as { value: string } | undefined;
                const signature = JSON.stringify(choice.missing);
                const old = previous === undefined ? null : JSON.parse(previous.value) as { signature?: string };
                const provider = waitsForProvider(choice);
                const block = provider ? providerBlock : JSON.stringify({ en, zh, signature });
                if (previous?.value !== block) {
                  saveBlock.run(key, block, clock.now());
                  writes.touched(id);
                }
                if (!provider && old?.signature !== signature) notices.push({ ticket, choice, reason: en, machines: defaults.machinesFor(ticket) });
                return false;
              }
              writes.choose(id, run);
            }
            if (ticket.startBlock != null) deleteBlock.run(`start_block:${id}`);
            writes.move(id, "working");
            insertBegin.run(id, clock.now());
            return true;
          }),
        );
        for (const notice of notices) {
          const offers = notice.machines.map((machine) => {
            const engine = machine.engines.find((entry) => entry.engine === notice.choice.engine);
            return `${machine.name}: ${engine === undefined ? "engine not offered" : engine.models.map((model) => `${model.id} (${model.efforts.join(", ")})`).join(", ") || "no models"}`;
          });
          tell(notice.ticket.id, text("notice.ticketBeginFailed", { ticket: notice.ticket.code }),
            [`[hub] Started ${described(notice.ticket)} cannot begin: ${notice.reason}.`, ...offers, "Decide what to do and tell the owner."].join("\n"));
        }
        begin(began);
      } while (again);
    } finally {
      advancing = false;
    }
  };

  const tellStopped = (stopped: Ticket) => {
    if (toldStopped.has(stopped.id)) {
      return;
    }
    toldStopped.add(stopped.id);
    const why = stopped.stopReason === null ? "" : `: ${stopped.stopReason.en}`;
    for (const after of tickets.waitingFor(stopped.id)) {
      if ((after.state !== "waiting" && after.state !== "pending") || !after.waits.some((wait) => wait.ticket === stopped.id && !wait.waived)) {
        continue;
      }
      const choice =
        after.state === "waiting"
          ? `The owner already started it, and it waits for ${described(stopped)}. Decide what happens to it: let it go ahead without ticket ${ticketReference(stopped)} with proceed_ticket, or stop it with stop_ticket.`
          : `It is not started yet and is arranged after ticket ${ticketReference(stopped)}. Arrange it again with arrange_chains, or stop it with stop_ticket.`;
      tell(
        after.id,
        text("notice.ticketBeforeStopped", { before: stopped.code, ticket: after.code }),
        [`[hub] ${described(stopped)} stopped${why}.`, `${described(after)} is ${after.state}. ${choice}`, "Tell the owner what you decided."].join("\n"),
      );
    }
  };

  const unsubscribe = tickets.subscribe((ticket) => {
    if (ticket.state === "stopped") {
      if (ticket.repairedBy === null) {
        tellStopped(ticket);
      }
      return;
    }
    if (ticket.state === "merged" || ticket.state === "delivered" || ticket.state === "waiting") {
      advance();
    }
  });

  const unsubscribeDefaults = defaults.subscribe?.(() => queueMicrotask(advance));
  const retry = setInterval(() => {
    if (hasUnchosenWaiting.get() !== undefined) advance();
  }, 30_000);
  retry.unref();

  const startScheduled = (run: string): number | undefined => {
    if (closed || !scheduled.mayStart(run)) return undefined;
    const list = openTickets();
    const pending = list.filter((ticket) => ticket.scheduleRun === run && ticket.state === "pending");
    if (pending.length === 0) return 0;
    const order = inWorkingOrder(pending.map((ticket) => ticket.id), indexOf(list));
    return tickets.change((writes) => {
      if (!scheduled.mayStart(run)) return undefined;
      let blocked = 0;
      for (const id of order) {
        const ticket = writes.get(id);
        if (ticket?.scheduleRun !== run || ticket.state !== "pending") continue;
        const ready = ticket.difficultyReason !== null && ticket.difficulty !== null && ticket.platform !== null;
        if (!ready || ticket.waits.some((wait) => !wait.waived && writes.get(wait.ticket)?.state === "pending")) {
          blocked += 1;
          continue;
        }
        writes.move(id, "waiting");
      }
      return blocked;
    });
  };

  const isOwner = async (assertion: OwnerProof): Promise<boolean> => {
    try {
      const result = await options.verify(assertion);
      return result.ok && result.identity.kind === "person" && result.identity.email === owner;
    } catch {
      return false;
    }
  };

  const start = async (given: OwnerStart): Promise<StartOutcome> => {
    if (!(await isOwner(given.assertion))) {
      return { ok: false, error: "forbidden" };
    }
    if (closed || given.chains.length === 0) {
      return { ok: false, error: "conflict" };
    }
    const list = openTickets();
    const candidates = ownerStartList(list);
    const index = indexOf(list);
    const chosen = new Set<number>();
    for (const item of given.chains) {
      const root = index.get(item.ticket);
      if (root === undefined || root.light !== undefined || root.state !== "pending") {
        return { ok: false, error: "conflict" };
      }
      if (fingerprintOf(item.ticket, candidates) !== item.fingerprint) {
        return { ok: false, error: "conflict" };
      }
      for (const id of arrangedAfter([item.ticket], candidates)) {
        chosen.add(id);
      }
    }
    if (startGaps([...chosen], index).length > 0) {
      return { ok: false, error: "conflict" };
    }
    const order = inWorkingOrder([...chosen], index);
    const choices = new Map<number, StartChoice>();
    for (const id of order) {
      const ticket = index.get(id);
      const choice = ticket === undefined ? undefined : defaults.resolve(ticket);
      if (ticket === undefined || choice === undefined || !canQueueStart(ticket, choice)) {
        return { ok: false, error: "incomplete" };
      }
      choices.set(id, choice);
    }
    let began: number[];
    try {
      began = tickets.change((writes) => {
        const now: number[] = [];
        for (const id of order) {
          const ticket = writes.get(id);
          if (ticket?.state !== "pending") {
            throw new TicketError(`Ticket ${tickets.reference(id) ?? "(unavailable)"} is no longer pending`);
          }
          const run = chosenRun(choices.get(id));
          if (hasStartPins(ticket) || run === undefined) {
            if (!hasStartPins(ticket)) saveBlock.run(`start_block:${id}`, providerBlock, clock.now());
            writes.move(id, "waiting");
            continue;
          }
          writes.choose(id, run);
          const lookup = new Map<number, ChainNode>();
          for (const wait of ticket.waits) {
            const before = writes.get(wait.ticket);
            if (before !== undefined) {
              lookup.set(before.id, before);
            }
          }
          if (readyToBegin(ticket, lookup)) {
            writes.move(id, "working");
            insertBegin.run(id, clock.now());
            now.push(id);
          } else {
            writes.move(id, "waiting");
          }
        }
        return now;
      });
    } catch (error) {
      if (error instanceof TicketError) {
        return { ok: false, error: "conflict" };
      }
      throw error;
    }
    begin(began);
    return {
      ok: true,
      tickets: order.flatMap((id) => {
        const ticket = tickets.get(id);
        return ticket === undefined ? [] : [ticket];
      }),
    };
  };

  const choose = async (given: OwnerChange): Promise<StartOutcome> => {
    if (!(await isOwner(given.assertion))) {
      return { ok: false, error: "forbidden" };
    }
    const ticket = tickets.get(given.ticket);
    if (ticket === undefined) {
      return { ok: false, error: "not_found" };
    }
    if (closed || ticket.state !== "pending") {
      return { ok: false, error: "conflict" };
    }
    const owner = applyChange(ticket.ownerChoice, given.change);
    const choice = defaults.resolve(ticket, owner);
    const machines = ticket.machinePinned === true || ticket.deploymentTargets !== undefined ? defaults.machinesFor(ticket) : defaults.machines();
    if (ownerGivesUnoffered(owner, choice, machines, requiredMachineFor(ticket, owner)) || antigravityForCode(ticket, owner)) {
      return { ok: false, error: "unsupported" };
    }
    try {
      tickets.change((writes) => {
        if (writes.get(ticket.id)?.state !== "pending") {
          throw new TicketError(`Ticket ${ticketReference(ticket)} is no longer pending`);
        }
        writes.ownerChoice(ticket.id, owner);
      });
    } catch (error) {
      if (error instanceof TicketError) {
        return { ok: false, error: "conflict" };
      }
      throw error;
    }
    const now = tickets.get(ticket.id);
    return { ok: true, tickets: now === undefined ? [] : [now] };
  };

  const reassign = async (given: OwnerChange): Promise<StartOutcome> => {
    if (!(await isOwner(given.assertion))) {
      return { ok: false, error: "forbidden" };
    }
    const ticket = tickets.get(given.ticket);
    if (ticket === undefined) {
      return { ok: false, error: "not_found" };
    }
    if (closed || !reassignableStates.includes(ticket.state)) {
      return { ok: false, error: "conflict" };
    }
    const owner = applyChange(hasStartPins(ticket) ? ticket.ownerChoice : noOwnerChoice, given.change);
    const choice = defaults.resolve(ticket, owner);
    const machines = ticket.machinePinned === true || ticket.deploymentTargets !== undefined ? defaults.machinesFor(ticket) : defaults.machines();
    if (ownerGivesUnoffered(owner, choice, machines, requiredMachineFor(ticket, owner)) || antigravityForCode(ticket, owner)) {
      return { ok: false, error: "unsupported" };
    }
    const run = chosenRun(choice);
    if (run === undefined) {
      return { ok: false, error: "incomplete" };
    }
    try {
      tickets.change((writes) => {
        if (writes.get(ticket.id)?.state !== ticket.state) {
          throw new TicketError(`Ticket ${ticketReference(ticket)} changed meanwhile`);
        }
        writes.ownerChoice(ticket.id, owner);
        writes.choose(ticket.id, run);
      });
    } catch (error) {
      if (error instanceof TicketError) {
        return { ok: false, error: "conflict" };
      }
      throw error;
    }
    const now = tickets.get(ticket.id);
    if (now !== undefined) {
      try {
        await work?.reassign?.(now);
      } catch (error) {
        tell(
          now.id,
          text("notice.ticketBeginFailed", { ticket: now.code }),
          `[hub] The owner reassigned ${described(now)} to ${run.machine} with ${run.engine} ${run.model} ${run.effort}, but its work could not restart there: ${reasonOf(error)}. Decide what happens to it and tell the owner.`,
        );
      }
    }
    return { ok: true, tickets: now === undefined ? [] : [now] };
  };

  const state = (specs: readonly DefaultsSpec[], turn?: TicketTurn): StateOutcome => {
    const refuse = (reason: string): StateOutcome => ({ ok: false, reason: `Nothing was changed: ${reason}` });
    const scheduledRun = turn === undefined ? undefined : scheduled.forTurn(turn);
    if (specs.length === 0) {
      return refuse("no chain was named");
    }
    const statements = new Map<number, { statement: DefaultsStatement; spec: DefaultsSpec }>();
    for (const spec of specs) {
      if (statements.has(spec.ticket)) {
        return refuse(`ticket ${tickets.reference(spec.ticket) ?? "(unavailable)"} is named twice`);
      }
      const ticket = tickets.get(spec.ticket);
      if (ticket === undefined) {
        return refuse(`there is no ticket ${tickets.reference(spec.ticket) ?? "(unavailable)"}`);
      }
      if (scheduledRun !== undefined && (!scheduledRun.authorized || ticket.scheduleRun !== scheduledRun.id)) {
        return refuse("a scheduled run can choose defaults only for work it opened.");
      }
      const reference = ticketReference(ticket);
      if (ticket.state !== "pending") {
        return refuse(`ticket ${reference} is ${ticket.state}; defaults are stated for chains that have not started`);
      }
      if (!fitsForm(ticket.form, spec.kind)) {
        return refuse(
          ticket.form === "task"
            ? `ticket ${reference} is a task ticket: its kind is writing (prose) or operation (anything done on a machine), not ${spec.kind}`
            : `ticket ${reference} is a code ticket and cannot be stated as ${spec.kind}`,
        );
      }
      if (!GeneratedText.safeParse(spec.reason).success || /[\r\n]/.test(spec.reason.en) || /[\r\n]/.test(spec.reason.zh)) {
        return refuse(`the reason for ticket ${reference} must be one line in English with a one-line Chinese copy`);
      }
      let difficulty: Difficulty | null;
      if (ticket.issues.length > 0) {
        const given = spec.issues ?? [];
        const named = new Set(given.map((entry) => entry.number));
        const own = new Set(ticket.issues.map((issue) => issue.number));
        if (given.length !== named.size || named.size !== own.size || [...own].some((number) => !named.has(number))) {
          return refuse(
            `ticket ${reference} holds issues ${[...own].map((number) => `#${number}`).join(", ")}; give the difficulty of each of them, and only them, in issues`,
          );
        }
        difficulty = chainDifficulty(given.map((entry) => entry.difficulty));
      } else {
        difficulty = spec.difficulty ?? (spec.kind === "writing" ? "standard" : null);
      }
      if (difficulty === null) {
        return refuse(`ticket ${reference} needs a difficulty`);
      }
      statements.set(spec.ticket, {
        spec,
        statement: {
          kind: spec.kind,
          difficulty,
          difficultyReason: { en: spec.reason.en.trim(), zh: spec.reason.zh.trim() },
          platform: spec.platform,
        },
      });
    }
    try {
      tickets.change((writes) => {
        for (const [id, { statement, spec }] of statements) {
          if (writes.get(id)?.state !== "pending") {
            throw new TicketError(`Ticket ${tickets.reference(id) ?? "(unavailable)"} is no longer pending`);
          }
          writes.pins(id, spec);
          writes.state(id, statement);
        }
      }, turn);
    } catch (error) {
      if (error instanceof TicketError) {
        return refuse(error.message);
      }
      throw error;
    }
    return {
      ok: true,
      tickets: [...statements.keys()].flatMap((id) => {
        const ticket = tickets.get(id);
        return ticket === undefined ? [] : [ticket];
      }),
    };
  };

  const arrange = (specs: readonly ChainSpec[], turn?: TicketTurn): ArrangeOutcome => {
    const refuse = (reason: string): ArrangeOutcome => ({ ok: false, reason: `Nothing was changed: ${reason}` });
    const scheduledRun = turn === undefined ? undefined : scheduled.forTurn(turn);
    if (specs.length === 0) {
      return refuse("the arrangement names no chain");
    }
    const names = new Set<string>();
    for (const spec of specs) {
      if (spec.name.trim() === "") {
        return refuse("every chain needs a name");
      }
      if (names.has(spec.name)) {
        return refuse(`the chain name ${spec.name} is used twice`);
      }
      names.add(spec.name);
      if (!RepositoryName.safeParse(spec.repository).success) {
        return refuse(`${spec.repository} in chain ${spec.name} is not a repository as owner/name`);
      }
      if (spec.issues.length === 0) {
        return refuse(`chain ${spec.name} has no issues`);
      }
    }
    const list = openTickets();
    const holder = new Map<string, Ticket>();
    for (const ticket of list) {
      if (ticket.state !== "pending") {
        continue;
      }
      for (const issue of ticket.issues) {
        holder.set(issueKey(issue.repository, issue.number), ticket);
      }
    }
    const named = new Map<string, string>();
    const sources = new Map<number, Ticket>();
    const issuesOf = new Map<string, TicketIssue[]>();
    for (const spec of specs) {
      const issues: TicketIssue[] = [];
      for (const number of spec.issues) {
        const key = issueKey(spec.repository, number);
        const already = named.get(key);
        if (already !== undefined) {
          return refuse(`issue ${spec.repository}#${number} is named in chain ${already} and in chain ${spec.name}; an issue belongs to one chain`);
        }
        named.set(key, spec.name);
        const ticket = holder.get(key);
        if (ticket === undefined) {
          const started = tickets.forIssue(spec.repository, number).find((found) => found.state !== "stopped");
          if (started !== undefined) {
            return refuse(
              `issue ${spec.repository}#${number} is on ticket ${ticketReference(started)}, which is ${started.state}. A started chain is closed: file the later work as a new issue and arrange it after ticket ${ticketReference(started)}`,
            );
          }
          return refuse(`no pending ticket holds issue ${spec.repository}#${number}; it does not exist here. File it with file_issue, or open a ticket for it with open_ticket, first`);
        }
        if (ticket.repairs !== null) {
          return refuse(`issue ${spec.repository}#${number} is on ticket ${ticketReference(ticket)}, a repair ticket that continues the work of ticket ${tickets.reference(ticket.repairs) ?? "(unavailable)"} on its branch; it cannot be regrouped, and the owner starts it as it is`);
        }
        if (scheduledRun !== undefined && (!scheduledRun.authorized || ticket.scheduleRun !== scheduledRun.id)) {
          return refuse("a scheduled run can arrange only work it opened.");
        }
        const issue = ticket.issues.find((entry) => entry.number === number && entry.repository.toLowerCase() === spec.repository.toLowerCase());
        if (issue === undefined) {
          return refuse(`issue ${spec.repository}#${number} could not be read from ticket ${ticketReference(ticket)}`);
        }
        issues.push(issue);
        sources.set(ticket.id, ticket);
      }
      issuesOf.set(spec.name, issues);
    }
    for (const source of sources.values()) {
      const left = source.issues.filter((issue) => !named.has(issueKey(issue.repository, issue.number)));
      if (left.length > 0) {
        return refuse(
          `ticket ${ticketReference(source)} also holds ${left.map((issue) => `${issue.repository}#${issue.number}`).join(", ")}; name every issue of a ticket you arrange`,
        );
      }
    }
    const byId = indexOf(list);
    for (const spec of specs) {
      for (const before of spec.after ?? []) {
        if (typeof before === "string") {
          if (before === spec.name) {
            return refuse(`chain ${spec.name} cannot come after itself`);
          }
          if (!names.has(before)) {
            return refuse(`chain ${spec.name} comes after ${before}, which is not a chain of this arrangement`);
          }
          continue;
        }
        const ticket = byId.get(before) ?? tickets.get(before);
        if (ticket === undefined) {
          return refuse(`chain ${spec.name} comes after ticket ${tickets.reference(before) ?? "(unavailable)"}, which does not exist`);
        }
        if (sources.has(before)) {
          return refuse(`chain ${spec.name} comes after ticket ${ticketReference(ticket)}, which this arrangement rearranges; name its chain instead`);
        }
        if (ticket.state === "stopped") {
          return refuse(
            ticket.repairedBy === null
              ? `chain ${spec.name} comes after ticket ${ticketReference(ticket)}, which has stopped`
              : `chain ${spec.name} comes after ticket ${ticketReference(ticket)}, which has stopped; ticket ${ticket.repairedByReference ?? "(unavailable)"} repairs it, so come after that`,
          );
        }
      }
    }
    const plans = new Map<string, { title: GeneratedText; summary: GeneratedText; kind: TicketKind; difficulty: Difficulty | null; platform: Platform | null; conversation: string | null; pins: Ticket[] }>();
    for (const spec of specs) {
      const issues = issuesOf.get(spec.name) ?? [];
      const from = [...new Set(issues.map((issue) => holder.get(issueKey(issue.repository, issue.number))))].flatMap((ticket) => (ticket === undefined ? [] : [ticket]));
      const whole = from.length === 1 && from[0] !== undefined && from[0].issues.length === issues.length ? from[0] : undefined;
      const first = issues[0];
      const title = spec.title ?? whole?.title ?? (issues.length === 1 && first !== undefined ? first.title : undefined);
      const summary = spec.summary ?? whole?.summary ?? (issues.length === 1 && first !== undefined ? first.summary : undefined);
      if (title === undefined || summary === undefined) {
        return refuse(`chain ${spec.name} has several issues and needs its own title and summary, each in English and Chinese`);
      }
      if (!GeneratedText.safeParse(title).success || !GeneratedText.safeParse(summary).success) {
        return refuse(`the title and summary of chain ${spec.name} each need an English original and a Chinese copy`);
      }
      const platforms = [...new Set(from.map((ticket) => ticket.platform).filter((platform) => platform !== null && platform !== "any"))];
      if (spec.platform === undefined && platforms.length > 1) {
        return refuse(`chain ${spec.name} needs ${platforms.join(" and ")}; cut it where the platform changes`);
      }
      const head = from[0];
      if (head === undefined) {
        return refuse(`chain ${spec.name} has no issues`);
      }
      const pins = from.filter(hasStartPins);
      const machines = new Set(pins.filter((ticket) => ticket.machinePinned === true).map((ticket) => requiredMachineFor(ticket)));
      const engines = new Set(pins.filter((ticket) => ticket.enginePin !== undefined).map((ticket) => ticket.ownerChoice.engine ?? ticket.enginePin));
      if (machines.size > 1 || engines.size > 1) {
        return refuse(`chain ${spec.name} has conflicting owner pins; keep those issues in separate chains`);
      }
      plans.set(spec.name, {
        title,
        summary,
        kind: spec.kind ?? head.kind,
        difficulty: spec.difficulty ?? chainDifficulty(from.map((ticket) => ticket.difficulty)),
        platform: spec.platform ?? platforms[0] ?? (from.some((ticket) => ticket.platform === "any") ? "any" : null),
        conversation: head.conversation,
        pins,
      });
    }
    const claimed = new Map<string, number>();
    const taken = new Set<number>();
    for (const spec of specs) {
      const wanted = new Set((issuesOf.get(spec.name) ?? []).map((issue) => issueKey(issue.repository, issue.number)));
      const same = [...sources.values()].find(
        (ticket) => !taken.has(ticket.id) && ticket.issues.length === wanted.size && ticket.issues.every((issue) => wanted.has(issueKey(issue.repository, issue.number))),
      );
      if (same !== undefined) {
        claimed.set(spec.name, same.id);
        taken.add(same.id);
      }
    }
    for (const spec of specs) {
      if (claimed.has(spec.name)) {
        continue;
      }
      const candidates = [...new Set((issuesOf.get(spec.name) ?? []).map((issue) => holder.get(issueKey(issue.repository, issue.number))?.id))]
        .flatMap((id) => (id === undefined || taken.has(id) ? [] : [id]))
        .sort((a, b) => a - b);
      const pick = candidates[0];
      if (pick !== undefined) {
        claimed.set(spec.name, pick);
        taken.add(pick);
      }
    }
    let placeholder = -1;
    const idOf = new Map<string, number>();
    for (const spec of specs) {
      idOf.set(spec.name, claimed.get(spec.name) ?? placeholder--);
    }
    const chainOfIssue = new Map<string, string>(named);
    const targets = (source: Ticket): number[] =>
      [...new Set(source.issues.map((issue) => chainOfIssue.get(issueKey(issue.repository, issue.number))))].flatMap((name) => {
        const id = name === undefined ? undefined : idOf.get(name);
        return id === undefined ? [] : [id];
      });
    const chainWaits = new Map<string, WaitToSet[]>();
    for (const spec of specs) {
      chainWaits.set(
        spec.name,
        (spec.after ?? []).map((before) => ({ ticket: typeof before === "string" ? (idOf.get(before) ?? 0) : before, deployment: spec.afterDeployment === true })),
      );
    }
    const chainIds = new Set(idOf.values());
    const outsideWaits = new Map<number, WaitToSet[]>();
    for (const ticket of list) {
      if (ticket.state !== "pending" || chainIds.has(ticket.id) || sources.has(ticket.id)) {
        continue;
      }
      if (!ticket.waits.some((wait) => sources.has(wait.ticket))) {
        continue;
      }
      const waits: WaitToSet[] = [];
      for (const wait of ticket.waits) {
        const source = sources.get(wait.ticket);
        if (source === undefined) {
          waits.push({ ticket: wait.ticket, deployment: wait.deployment });
        } else {
          for (const target of targets(source)) {
            waits.push({ ticket: target, deployment: wait.deployment });
          }
        }
      }
      outsideWaits.set(ticket.id, waits);
    }
    const graph: ChainNode[] = [];
    for (const ticket of list) {
      if (sources.has(ticket.id)) {
        continue;
      }
      const rewired = outsideWaits.get(ticket.id);
      const waits = rewired === undefined ? ticket.waits : rewired.map((wait) => ({ ...wait, waived: false }));
      graph.push({ id: ticket.id, state: ticket.state, deployedAt: ticket.deployedAt, localBuild: ticket.localBuild, waits });
    }
    for (const spec of specs) {
      graph.push({
        id: idOf.get(spec.name) ?? 0,
        state: "pending",
        deployedAt: null,
        waits: (chainWaits.get(spec.name) ?? []).map((wait) => ({ ...wait, waived: false })),
      });
    }
    const cycle = findCycle(waitEdges(graph));
    if (cycle !== undefined) {
      const nameOf = (id: number) => specs.find((spec) => idOf.get(spec.name) === id)?.name;
      return refuse(`it has a cycle: ${cycle.map((id) => (nameOf(id) === undefined ? `ticket ${tickets.reference(id) ?? "(unavailable)"}` : `chain ${nameOf(id) ?? ""}`)).join(" waits for ")}`);
    }
    let written: { chains: Map<string, number>; joined: number[] };
    try {
      written = tickets.change((writes) => {
        const real = new Map<string, number>();
        for (const spec of specs) {
          const plan = plans.get(spec.name);
          const issues = issuesOf.get(spec.name) ?? [];
          if (plan === undefined) {
            continue;
          }
          const existing = claimed.get(spec.name);
          const id =
            existing ??
            writes.open({
              repository: issues[0]?.repository ?? spec.repository,
              issues,
              title: plan.title,
              summary: plan.summary,
              kind: plan.kind,
              difficulty: plan.difficulty ?? undefined,
              platform: plan.platform ?? undefined,
              conversation: plan.conversation ?? undefined,
            });
          if (existing !== undefined) {
            const before = writes.get(id);
            const sameIssues =
              before !== undefined &&
              before.issues.length === issues.length &&
              before.issues.every((issue, position) => issue.number === issues[position]?.number && issue.repository === issues[position]?.repository);
            const sameShape = before !== undefined && before.kind === plan.kind && before.difficulty === plan.difficulty && before.platform === plan.platform;
            writes.setIssues(id, issues);
            if (!sameIssues || !sameShape) {
              writes.forgetDefaults(id);
            }
          }
          for (const source of plan.pins) writes.inheritPins(id, source);
          writes.pins(id, plan);
          writes.describe(id, plan);
          real.set(spec.name, id);
        }
        const actual = (id: number): number => {
          const name = specs.find((spec) => idOf.get(spec.name) === id)?.name;
          return name === undefined ? id : (real.get(name) ?? id);
        };
        for (const spec of specs) {
          const id = real.get(spec.name);
          if (id !== undefined) {
            writes.setWaits(id, (chainWaits.get(spec.name) ?? []).map((wait) => ({ ticket: actual(wait.ticket), deployment: wait.deployment })));
          }
        }
        for (const [id, waits] of outsideWaits) {
          writes.setWaits(id, waits.map((wait) => ({ ticket: actual(wait.ticket), deployment: wait.deployment })));
        }
        const joined: number[] = [];
        for (const source of sources.values()) {
          if (taken.has(source.id)) {
            continue;
          }
          const into = targets(source).map(actual)[0] ?? 0;
          writes.join(source.id, into, { en: `Joined into ticket ${tickets.reference(into) ?? "(unavailable)"} by an arrangement`, zh: text("ticket.reason.joined", { ticket: writes.get(into)?.code ?? "?" }) });
          joined.push(source.id);
        }
        return { chains: real, joined };
      }, turn);
    } catch (error) {
      if (error instanceof TicketError) {
        return refuse(error.message);
      }
      throw error;
    }
    return {
      ok: true,
      chains: specs.flatMap((spec) => {
        const id = written.chains.get(spec.name);
        const ticket = id === undefined ? undefined : tickets.get(id);
        return ticket === undefined ? [] : [{ name: spec.name, ticket }];
      }),
      joined: written.joined,
    };
  };

  const deployed = (id: number, turn?: TicketTurn): TicketOutcome => {
    const ticket = tickets.get(id);
    if (ticket === undefined) {
      return { ok: false, reason: `There is no ticket ${tickets.reference(id) ?? "(unavailable)"}.` };
    }
    if (ticket.state !== "merged") {
      return { ok: false, reason: `Ticket ${ticketReference(ticket)} is ${ticket.state}; only merged work is deployed.` };
    }
    const before = new Set(openTickets().filter((entry) => entry.state === "working").map((entry) => entry.id));
    tickets.change((writes) => writes.deployed(id), turn);
    advance();
    return { ok: true, ticket: tickets.get(id) ?? ticket, began: openTickets().filter((entry) => entry.state === "working" && !before.has(entry.id)) };
  };

  const proceed = (id: number, turn?: TicketTurn): TicketOutcome => {
    const ticket = tickets.get(id);
    if (ticket === undefined) {
      return { ok: false, reason: `There is no ticket ${tickets.reference(id) ?? "(unavailable)"}.` };
    }
    if (ticket.state !== "waiting") {
      return {
        ok: false,
        reason:
          ticket.state === "pending"
            ? `Ticket ${ticketReference(ticket)} is not started; only the owner starts it, with 开始 on its card. Arrange it again with arrange_chains if what it waits for has changed.`
            : `Ticket ${ticketReference(ticket)} is ${ticket.state} and is not waiting.`,
      };
    }
    const stopped = ticket.waits.filter((wait) => !wait.waived && tickets.get(wait.ticket)?.state === "stopped").map((wait) => wait.ticket);
    if (stopped.length === 0) {
      return { ok: false, reason: `Nothing ticket ${tickets.reference(id) ?? "(unavailable)"} waits for has stopped; it begins by itself when what it waits for has merged or is done.` };
    }
    tickets.change((writes) => {
      for (const before of stopped) {
        writes.waive(id, before);
      }
    }, turn);
    advance();
    const now = tickets.get(id) ?? ticket;
    return { ok: true, ticket: now, began: now.state === "working" ? [now] : [] };
  };

  const cards = (): StartCard[] => {
    const list = openTickets();
    const candidates = ownerStartList(list);
    const index = withBefore(list);
    const listIndex = indexOf(list);
    return candidates
      .filter((ticket) => ticket.state === "pending" && ticket.light === undefined)
      .flatMap((ticket): StartCard[] => {
        const fingerprint = fingerprintOf(ticket.id, candidates);
        if (fingerprint === undefined) {
          return [];
        }
        return [
          {
            kind: "start",
            key: cardKey("start", String(ticket.id)),
            at: ticket.createdAt,
            ticket,
            fingerprint,
            before: unmetWaits(ticket, index).flatMap((wait) => {
              const before = index.get(wait.ticket);
              return before === undefined ? [] : [{ id: before.id, title: before.title, repository: ticketProject(before), state: before.state }];
            }),
            startable: canStartAlone(ticket, listIndex),
            choice: defaults.resolve(ticket),
            machines: defaults.machinesFor(ticket),
          },
        ];
      });
  };

  return {
    arranger: { arrange, state, deployed, proceed },
    starter: { start, choose, reassign },
    startScheduled,
    cards,
    resume: () => {
      begin(selectDue.all().map((row) => BeginRow.parse(row).ticket_id));
      advance();
    },
    idle: async () => {
      while (running.size > 0) {
        await Promise.all([...running]);
      }
    },
    close: () => {
      closed = true;
      clearInterval(retry);
      unsubscribe();
      unsubscribeDefaults?.();
    },
  };
}
