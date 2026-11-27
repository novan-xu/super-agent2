import { createHash } from "node:crypto";
import {
  type AppGatewayStatus,
  type BrainSettings,
  type Device,
  defaultMachineLoadSettings,
  defaultTodoReminderSettings,
  type EngineTable,
  type HubFeatures,
  type MachineStatus,
  fullOrder,
  gitHubAccounts,
  MachineLoadSettings,
  Provider,
  ProviderOrderChange,
  pushServiceOf,
  type SettingsSnapshot,
  startingBrainOrder,
  startingWorkerOrder,
  type TodoReminderChange,
  TodoReminderSettings,
  type TableCell,
  unofferedChanges,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import type { StartDefaults } from "./defaults.js";
import type { MachineAdmin } from "./machine-admin.js";
import type { RepositoryAccounts } from "./repositories.js";
import type { Runners } from "./runners.js";

export type TableOutcome = { readonly ok: true; readonly table: EngineTable } | { readonly ok: false; readonly unoffered: readonly TableCell[] };

export interface Settings {
  snapshot(): SettingsSnapshot;
  brainOrder(): Provider[] | undefined;
  workerOrder(): Provider[];
  setOrder(role: "brain" | "worker", order: readonly Provider[]): void;
  setTable(table: EngineTable): TableOutcome;
  budget(): number | null;
  setBudget(value: number | null): void;
  setLoadSettings(settings: MachineLoadSettings): void;
  todoReminders(): TodoReminderSettings;
  setTodoReminders(change: TodoReminderChange): void;
  changed(): void;
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
  close(): void;
}

export interface SettingsOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly runners: Runners;
  readonly admin: MachineAdmin;
  readonly repositories: RepositoryAccounts;
  readonly conversations: () => ConversationService | undefined;
  readonly defaults: StartDefaults;
  readonly credentials: CredentialSource;
  readonly pushKey: string | undefined;
  readonly appGateway?: () => AppGatewayStatus;
  readonly features?: (machines: readonly MachineStatus[], brain: BrainSettings, apps?: AppGatewayStatus) => HubFeatures;
}

const orderKeys = { brain: "brain_order", worker: "worker_order" };
const loadKey = "machine_load";
const reminderKey = "todo_reminders";

const ValueRow = z.object({ value: z.string() });
const DeviceRow = z.object({ endpoint: z.string(), created_at: z.number().int() });

export function brainSettings(linked: boolean, stored: readonly Provider[] | undefined, reported: { readonly order: readonly Provider[]; readonly providers: BrainSettings["providers"] } | undefined): BrainSettings {
  const order = [...(stored ?? reported?.order ?? startingBrainOrder)];
  return { linked, order, providers: reported === undefined ? [] : [...reported.providers] };
}

export function createSettings(options: SettingsOptions): Settings {
  const { connection } = options.database;
  const selectSetting = connection.prepare("SELECT value FROM hub_settings WHERE key = ?");
  const upsertSetting = connection.prepare(
    "INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  const selectDevices = connection.prepare("SELECT endpoint, created_at FROM push_subscriptions WHERE vapid_key = ? ORDER BY created_at, endpoint");
  const listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  let scheduled = false;
  let closed = false;

  const readOrder = (role: keyof typeof orderKeys): Provider[] | undefined => {
    const row = selectSetting.get(orderKeys[role]);
    if (row === undefined) {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(ValueRow.parse(row).value);
      if (role === "worker") {
        const parsed = ProviderOrderChange.safeParse({ order: value });
        return parsed.success ? parsed.data.order : undefined;
      }
      const parsed = z.array(Provider).min(1).safeParse(value);
      return parsed.success ? fullOrder(parsed.data) : undefined;
    } catch {
      return undefined;
    }
  };

  const brainOrder = () => readOrder("brain");
  const workerOrder = () => readOrder("worker") ?? [...startingWorkerOrder];
  const loadSettings = (): MachineLoadSettings => {
    const row = selectSetting.get(loadKey);
    if (row === undefined) return defaultMachineLoadSettings;
    try {
      return MachineLoadSettings.parse(JSON.parse(ValueRow.parse(row).value));
    } catch {
      return defaultMachineLoadSettings;
    }
  };
  options.runners.setLoadSettings(loadSettings());

  const devices = (): Device[] =>
    options.pushKey === undefined
      ? []
      : selectDevices.all(options.pushKey).map((row) => {
          const value = DeviceRow.parse(row);
          return { id: createHash("sha256").update(value.endpoint).digest("hex").slice(0, 16), service: pushServiceOf(value.endpoint), createdAt: value.created_at };
        });

  const budget = (): number | null => {
    const row = selectSetting.get("openai_monthly_budget");
    if (row === undefined) return null;
    const value = Number(ValueRow.parse(row).value);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const todoReminders = (): TodoReminderSettings => {
    const row = selectSetting.get(reminderKey);
    if (row === undefined) return defaultTodoReminderSettings;
    try {
      return TodoReminderSettings.parse(JSON.parse(ValueRow.parse(row).value));
    } catch {
      return defaultTodoReminderSettings;
    }
  };

  const snapshot = (): SettingsSnapshot => {
    const conversations = options.conversations();
    const subscriptions = options.defaults.subscriptions();
    const machines = options.runners.statuses();
    const brain = brainSettings(conversations?.linked() ?? false, brainOrder(), conversations?.providers());
    const appGateway = options.appGateway?.();
    const features = options.features?.(machines, brain, appGateway);
    return {
      openaiBudget: budget(),
      machines,
      machineLoad: loadSettings(),
      canAdd: { ...options.admin.canAdd },
      repositories: options.repositories.list(),
      accounts: gitHubAccounts.map((account) => ({ account, configured: options.credentials(account).ok })),
      brain,
      workerOrder: workerOrder(),
      table: options.defaults.table(),
      subscriptions: [subscriptions.codex, subscriptions.claude],
      unavailable: options.defaults.unavailable(),
      devices: devices(),
      ...(options.pushKey === undefined ? {} : { todoReminders: { ...todoReminders(), timeZone: options.database.ticketTimeZone } }),
      ...(appGateway === undefined ? {} : { appGateway }),
      ...(features === undefined ? {} : { features }),
    };
  };

  const changed = () => {
    if (scheduled || closed || listeners.size === 0) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) {
        return;
      }
      const current = snapshot();
      for (const listener of listeners) {
        try {
          listener(current);
        } catch {
          continue;
        }
      }
    });
  };

  const unsubscribeRunners = options.runners.subscribe(changed);
  const unsubscribeDefaults = options.defaults.subscribe(changed);
  let unsubscribeBrain: (() => void) | undefined;
  const watchBrain = () => {
    if (unsubscribeBrain === undefined) {
      unsubscribeBrain = options.conversations()?.watchBrain(changed);
    }
  };

  return {
    snapshot: () => {
      watchBrain();
      return snapshot();
    },
    brainOrder,
    workerOrder,
    setOrder: (role, order) => {
      upsertSetting.run(orderKeys[role], JSON.stringify(order), options.clock.now());
      if (role === "brain") {
        options.conversations()?.sendOrder(order);
        changed();
      } else {
        options.defaults.changed();
      }
    },
    setTable: (table) => {
      const unoffered = unofferedChanges(table, options.defaults.table(), options.defaults.machines());
      if (unoffered.length > 0) {
        return { ok: false, unoffered };
      }
      return { ok: true, table: options.defaults.setTable(table) };
    },
    budget,
    setBudget: (value) => {
      upsertSetting.run("openai_monthly_budget", value === null ? "" : String(value), options.clock.now());
      options.defaults.changed();
    },
    setLoadSettings: (settings) => {
      upsertSetting.run(loadKey, JSON.stringify(settings), options.clock.now());
      options.runners.setLoadSettings(settings);
      changed();
    },
    todoReminders,
    setTodoReminders: (change) => {
      upsertSetting.run(reminderKey, JSON.stringify({ ...todoReminders(), ...change }), options.clock.now());
      changed();
    },
    changed,
    subscribe: (listener) => {
      watchBrain();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
      unsubscribeRunners();
      unsubscribeDefaults();
      unsubscribeBrain?.();
    },
  };
}
