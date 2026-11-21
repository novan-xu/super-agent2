import {
  activeMarks,
  currentBalance,
  type Balance,
  type AllowanceStates,
  EngineTable,
  engineOrder,
  type EngineContext,
  type MachineChoice,
  type MachineReading,
  machineChoices,
  machinesFor,
  type MachineStatus,
  type OwnerChoice,
  type Provider,
  ProgramId,
  type ProviderMark,
  type ProviderOut,
  type ProviderUnavailable,
  providersOut,
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

export type DefaultsListener = () => void;

export type SubscriptionAdjustment = (subscriptions: Subscriptions) => Subscriptions;

export interface StartDefaults {
  table(): EngineTable;
  setTable(table: EngineTable): EngineTable;
  subscriptions(): Subscriptions;
  balance(): Balance;
  unavailable(): ProviderUnavailable[];
  out(): Map<ProgramId, ProviderOut>;
  order(prose: boolean): ProgramId[];
  markUnavailable(program: ProgramId, reason: string, until: number | null, category?: "limit" | "problem" | "overload"): void;
  healthMarks(): { program: ProgramId; reason: string; since: number; category: "limit" | "problem" | "overload" | null }[];
  recovered(program: ProgramId, at: number): boolean;
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

const MarkRow = z.object({ program: z.string(), reason: z.string(), since: z.number().int(), until: z.number().int().nullable(), category: z.enum(["limit", "problem", "overload"]).nullable() });

export function allowanceStatesOf(subscriptions: Subscriptions): AllowanceStates {
  return { codex: subscriptions.codex.state, claude: subscriptions.claude.state };
}

export function readingsOf(statuses: readonly MachineStatus[]): MachineReading[] {
  return statuses.flatMap((status) => (status.report?.allowances ?? []).map((reading) => ({ machine: status.name, reading })));
}

export function createStartDefaults(options: StartDefaultsOptions): StartDefaults {
  const { connection } = options.database;
  const { clock } = options;
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

  const selectMarks = connection.prepare("SELECT * FROM provider_marks ORDER BY program");
  const upsertMark = connection.prepare(
    "INSERT INTO provider_marks (program, reason, since, until, category) VALUES (?, ?, ?, ?, ?) ON CONFLICT (program) DO UPDATE SET reason = excluded.reason, since = excluded.since, until = excluded.until, category = excluded.category",
  );
  const deleteMark = connection.prepare("DELETE FROM provider_marks WHERE program = ? AND since < ?");

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

  const order = (prose: boolean): ProgramId[] => engineOrder(options.providerOrder?.(), prose);

  const contextOf = (): EngineContext => ({ out: new Set(out().keys()), order: order(false) });

  const foldedStates = (): AllowanceStates => {
    const states = allowanceStatesOf(subscriptions());
    const unavailableNow = out();
    return { codex: unavailableNow.has("codex") ? "exhausted" : states.codex, claude: unavailableNow.has("claude") ? "exhausted" : states.claude };
  };

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
    order,
    healthMarks: () => {
      const active = new Set(unavailable().map((mark) => mark.program));
      return selectMarks.all().flatMap((row) => {
        const mark = MarkRow.parse(row);
        const program = ProgramId.safeParse(mark.program);
        return program.success && active.has(program.data) ? [{ program: program.data, reason: mark.reason, since: mark.since, category: mark.category }] : [];
      });
    },
    markUnavailable: (program, reason, until, category) => {
      const now = clock.now();
      upsertMark.run(program, reason, now, until !== null && until > now ? until : null, category ?? null);
      changed();
    },
    recovered: (program, at) => {
      if (Number(deleteMark.run(program, at).changes) === 0) {
        return false;
      }
      changed();
      return true;
    },
    machines,
    machinesFor: (ticket) => machinesFor(ticket.platform, machines(), ticket.requiredMachine),
    resolve: (ticket, owner = ticket.ownerChoice) =>
      resolveStart(
        {
          kind: ticket.kind,
          difficulty: ticket.difficulty,
          platform: ticket.platform,
          requiredMachine: ticket.requiredMachine,
          brainEngine: ticket.brainEngine,
          stated: ticket.difficultyReason !== null && ticket.platform !== null && ticket.difficulty !== null,
          owner,
        },
        table(),
        machines(),
        foldedStates(),
        contextOf(),
      ),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changed: () => { balanceHold(); changed(); },
  };
}
