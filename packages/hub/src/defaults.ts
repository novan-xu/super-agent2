import {
  activeMarks,
  currentBalance,
  defaultMachine,
  type Balance,
  EngineTable,
  engineOrder,
  hasStartPins,
  requiredMachineFor,
  isComplete,
  type EngineContext,
  type MachineChoice,
  type MachineReading,
  machineChoices,
  machinesFor,
  type MachineStatus,
  markActive,
  markUntil,
  type OwnerChoice,
  type Provider,
  ProgramId,
  type ProviderMark,
  type ProviderOut,
  type ProviderUnavailable,
  providersOut,
  routeProvider,
  resolveStart,
  type StartChoice,
  startingEngineTable,
  type Subscriptions,
  subscriptionsOf,
  type Ticket,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { createFollowUpRecords } from "./follow-ups.js";

export type DefaultsListener = () => void;

export type SubscriptionAdjustment = (subscriptions: Subscriptions) => Subscriptions;

export interface StartDefaults {
  table(): EngineTable;
  setTable(table: EngineTable): EngineTable;
  subscriptions(): Subscriptions;
  balance(): Balance;
  unavailable(): ProviderUnavailable[];
  out(): Map<ProgramId, ProviderOut>;
  antigravityOut(): Map<string, ProviderOut>;
  order(prose: boolean): ProgramId[];
  markUnavailable(program: ProgramId, reason: string, until: number | null, category?: "limit" | "problem" | "overload", model?: string): void;
  healthMarks(): { program: ProgramId; reason: string; since: number; category: "limit" | "problem" | "overload" | null }[];
  recovered(program: ProgramId, at: number, model?: string): boolean;
  machines(): MachineChoice[];
  machinesFor(ticket: Ticket): MachineChoice[];
  resolve(ticket: Ticket, owner?: OwnerChoice): StartChoice;
  subscribe(listener: DefaultsListener): () => void;
  changed(): void;
}

export interface StartDefaultsOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly statuses: () => readonly MachineStatus[];
  readonly adjust?: SubscriptionAdjustment;
  readonly lowBalance?: number;
  readonly providerOrder?: () => readonly Provider[] | undefined;
}

const tableKey = "engine_table";

const ValueRow = z.object({ value: z.string() });

const MarkRow = z.object({ program: z.string(), model: z.string(), reason: z.string(), since: z.number().int(), until: z.number().int().nullable(), category: z.enum(["limit", "problem", "overload"]).nullable() });

export function readingsOf(statuses: readonly MachineStatus[]): MachineReading[] {
  return statuses.flatMap((status) => (status.report?.allowances ?? []).map((reading) => ({ machine: status.name, reading })));
}

export function createStartDefaults(options: StartDefaultsOptions): StartDefaults {
  const { connection } = options.database;
  const { clock } = options;
  const followUps = createFollowUpRecords(options.database);
  const listeners = new Set<DefaultsListener>();
  const selectSetting = connection.prepare("SELECT value FROM hub_settings WHERE key = ?");
  const upsertSetting = connection.prepare(
    "INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );

  const table = (): EngineTable => {
    const row = selectSetting.get(tableKey);
    if (row === undefined) {
      return startingEngineTable;
    }
    try {
      const parsed = EngineTable.safeParse(JSON.parse(ValueRow.parse(row).value));
      return parsed.success ? parsed.data : startingEngineTable;
    } catch {
      return startingEngineTable;
    }
  };

  const selectMarks = connection.prepare("SELECT * FROM provider_marks WHERE model = '' ORDER BY program");
  const selectAntigravityMarks = connection.prepare("SELECT * FROM provider_marks WHERE program = 'antigravity' AND model <> '' ORDER BY model");
  const upsertMark = connection.prepare(
    "INSERT INTO provider_marks (program, model, reason, since, until, category) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (program, model) DO UPDATE SET reason = excluded.reason, since = excluded.since, until = excluded.until, category = excluded.category",
  );
  const deleteMark = connection.prepare("DELETE FROM provider_marks WHERE program = ? AND (model = '' OR model = ?) AND since < ?");

  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  };

  const subscriptions = (): Subscriptions => {
    const read = subscriptionsOf(readingsOf(options.statuses()), clock.now());
    return options.adjust === undefined ? read : options.adjust(read);
  };

  const balance = (): Balance => currentBalance(readingsOf(options.statuses()), clock.now(), options.lowBalance);
  const balanceHold = (): boolean => {
    const row = selectSetting.get("deepseek_balance_hold");
    let saved: { readAt: number; empty: boolean } = { readAt: -1, empty: false };
    try {
      if (row !== undefined) saved = z.object({ readAt: z.number(), empty: z.boolean() }).parse(JSON.parse(ValueRow.parse(row).value));
    } catch { saved = { readAt: -1, empty: false }; }
    const known = readingsOf(options.statuses()).filter((item) => item.reading.program === "dsh" && item.reading.available !== null);
    const latest = currentBalance(known, clock.now(), options.lowBalance, Number.MAX_SAFE_INTEGER);
    if (latest.machine !== null && latest.readAt > saved.readAt) {
      saved = { readAt: latest.readAt, empty: latest.state === "empty" };
      upsertSetting.run("deepseek_balance_hold", JSON.stringify(saved), clock.now());
    }
    return saved.empty;
  };

  const machines = (): MachineChoice[] => machineChoices(options.statuses());

  const marks = (): ProviderMark[] =>
    selectMarks.all().flatMap((row) => {
      const parsed = MarkRow.parse(row);
      const program = ProgramId.safeParse(parsed.program);
      return program.success ? [{ program: program.data, reason: parsed.reason, since: parsed.since, until: parsed.until }] : [];
    });

  const unavailable = (): ProviderUnavailable[] => {
    const read = subscriptions();
    return activeMarks(marks(), { codex: read.codex, claude: read.claude }, clock.now());
  };

  const out = (): Map<ProgramId, ProviderOut> => {
    const read = subscriptions();
    const result = providersOut(unavailable(), { codex: read.codex, claude: read.claude }, clock.now());
    if (balanceHold()) result.set("dsh", { reason: "The DeepSeek balance is empty", until: null, given: false });
    return result;
  };

  const antigravityOut = (): Map<string, ProviderOut> => {
    const now = clock.now();
    const result = new Map<string, ProviderOut>();
    for (const row of selectAntigravityMarks.all()) {
      const { model, reason, since, until } = MarkRow.parse(row);
      const mark = { program: "antigravity" as const, reason, since, until };
      if (markActive(mark, undefined, now)) result.set(model, { reason, until: markUntil(mark), given: until !== null });
    }
    return result;
  };

  const order = (prose: boolean): ProgramId[] => engineOrder(options.providerOrder?.(), prose);

  const contextOf = (): EngineContext => ({ out: new Set(out().keys()), order: order(false), antigravityOut: new Set(antigravityOut().keys()) });

  return {
    table,
    setTable: (next) => {
      const parsed = EngineTable.parse(next);
      upsertSetting.run(tableKey, JSON.stringify(parsed), clock.now());
      changed();
      return parsed;
    },
    subscriptions,
    balance,
    unavailable,
    out,
    antigravityOut,
    order,
    healthMarks: () => {
      const active = new Set(unavailable().map((mark) => mark.program));
      return selectMarks.all().flatMap((row) => {
        const mark = MarkRow.parse(row);
        const program = ProgramId.safeParse(mark.program);
        return program.success && active.has(program.data) ? [{ program: program.data, reason: mark.reason, since: mark.since, category: mark.category }] : [];
      });
    },
    markUnavailable: (program, reason, until, category, model) => {
      const now = clock.now();
      const scope = program === "antigravity" && category === "limit" ? model ?? "" : "";
      upsertMark.run(program, scope, reason, now, until !== null && until > now ? until : null, category ?? null);
      changed();
    },
    recovered: (program, at, model) => {
      if (Number(deleteMark.run(program, program === "antigravity" ? model ?? "" : "", at).changes) === 0) {
        return false;
      }
      changed();
      return true;
    },
    machines,
    machinesFor: (ticket) => machinesFor(ticket.platform, machines(), ticket.machinePinned === true ? null : ticket.requiredMachine),
    resolve: (ticket, owner = ticket.ownerChoice) => {
      const input = {
        kind: ticket.kind,
        difficulty: ticket.difficulty,
        platform: ticket.platform,
        requiredMachine: requiredMachineFor(ticket, owner),
        machinePinned: ticket.machinePinned,
        enginePin: ticket.enginePin,
        stated: ticket.difficultyReason !== null && ticket.platform !== null && ticket.difficulty !== null,
        owner,
      };
      const choices = table();
      const online = ticket.machinePinned === true ? machinesFor(ticket.platform, machines()) : machines();
      const context = contextOf();
      const ordinary = resolveStart(input, choices, online, context);
      const link = followUps.get(ticket.id);
      const source = link === undefined ? undefined : followUps.source(link.previous) ?? followUps.source(link.original);
      if (source === undefined || source.engine === "antigravity") return ordinary;
      if (ticket.enginePin !== undefined && ordinary.missing.includes("provider")) return ordinary;
      const engine = owner.engine ?? ticket.enginePin ?? source.engine;
      const sameEngine = engine === source.engine;
      const sourceLoaded = online.some((machine) => machine.name === source.machine && machine.loaded);
      const flexible = owner.machine === null && requiredMachineFor(ticket, owner) === null;
      const alternate = flexible && sourceLoaded && input.platform !== null
        ? defaultMachine(input.platform, engine, online, owner.model ?? (sameEngine ? source.model : null), owner.effort ?? (sameEngine ? source.effort : null))
        : null;
      if (owner.engine !== null || !context.out.has(engine)) {
        if (flexible && sourceLoaded && alternate === null && isComplete(ordinary)
          && online.some((machine) => machine.name === ordinary.machine && !machine.loaded)) return ordinary;
        const pinned = { ...owner, machine: owner.machine ?? (ticket.machinePinned === true ? ticket.requiredMachine : alternate ?? source.machine), engine };
        const preferred = resolveStart({
          ...input, owner: { ...pinned, model: owner.model ?? (sameEngine ? source.model : null), effort: owner.effort ?? (sameEngine ? source.effort : null) },
        }, choices, online, context);
        if (isComplete(preferred)) return { ...preferred, by: ordinary.by };
        const updatedModel = resolveStart({ ...input, owner: pinned }, choices, online, context);
        if (isComplete(updatedModel)) return { ...updatedModel, by: ordinary.by };
      }
      if (isComplete(ordinary) || hasStartPins(ticket) || owner.engine !== null || owner.model !== null || owner.effort !== null) return ordinary;
      const fallback = routeProvider({
        difficulty: ticket.difficulty,
        platform: ticket.platform,
        requiredMachine: owner.machine ?? ticket.requiredMachine,
        machine: owner.machine ?? source.machine,
        canMove: owner.machine === null,
        order: order(false),
        table: choices,
        machines: online,
        out: out(),
        antigravityOut: antigravityOut(),
      });
      return fallback.kind === "run" ? { ...fallback, by: ordinary.by, missing: [] } : ordinary;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changed: () => { balanceHold(); changed(); },
  };
}
