import {
  type AllowanceStates,
  EngineTable,
  type MachineChoice,
  type MachineReading,
  machineChoices,
  machinesFor,
  type MachineStatus,
  type OwnerChoice,
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
}

const tableKey = "engine_table";

const ValueRow = z.object({ value: z.string() });

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

  const machines = (): MachineChoice[] => machineChoices(options.statuses());

  return {
    table,
    setTable: (next) => {
      const parsed = EngineTable.parse(next);
      upsertSetting.run(tableKey, JSON.stringify(parsed), clock.now());
      changed();
      return parsed;
    },
    subscriptions,
    machines,
    machinesFor: (ticket) => machinesFor(ticket.platform, machines()),
    resolve: (ticket, owner = ticket.ownerChoice) =>
      resolveStart(
        {
          kind: ticket.kind,
          difficulty: ticket.difficulty,
          platform: ticket.platform,
          brainEngine: ticket.brainEngine,
          stated: ticket.difficultyReason !== null && ticket.platform !== null && ticket.difficulty !== null,
          owner,
        },
        table(),
        machines(),
        allowanceStatesOf(subscriptions()),
      ),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changed,
  };
}
