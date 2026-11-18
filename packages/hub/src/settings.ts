import { createHash } from "node:crypto";
import {
  type BrainSettings,
  type Device,
  type EngineTable,
  fullOrder,
  gitHubAccounts,
  Provider,
  pushServiceOf,
  type SettingsSnapshot,
  startingOrder,
  type TableCell,
  unofferedChanges,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import type { StartDefaults } from "./defaults.js";
import type { MachineAdmin } from "./enrollment.js";
import type { RepositoryAccounts } from "./repositories.js";
import type { Runners } from "./runners.js";

export type TableOutcome = { readonly ok: true; readonly table: EngineTable } | { readonly ok: false; readonly unoffered: readonly TableCell[] };

export interface Settings {
  snapshot(): SettingsSnapshot;
  order(): Provider[] | undefined;
  setOrder(chosen: readonly Provider[]): Provider[];
  setTable(table: EngineTable): TableOutcome;
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
}

const orderKey = "brain_order";

const ValueRow = z.object({ value: z.string() });
const DeviceRow = z.object({ endpoint: z.string(), created_at: z.number().int() });

export function brainSettings(linked: boolean, stored: readonly Provider[] | undefined, reported: { readonly order: readonly Provider[]; readonly providers: BrainSettings["providers"] } | undefined): BrainSettings {
  const order = stored !== undefined ? [...stored] : (reported === undefined ? fullOrder(startingOrder) : [...reported.order]);
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

  const order = (): Provider[] | undefined => {
    const row = selectSetting.get(orderKey);
    if (row === undefined) {
      return undefined;
    }
    try {
      const parsed = z.array(Provider).min(1).safeParse(JSON.parse(ValueRow.parse(row).value));
      return parsed.success ? fullOrder(parsed.data) : undefined;
    } catch {
      return undefined;
    }
  };

  const devices = (): Device[] =>
    options.pushKey === undefined
      ? []
      : selectDevices.all(options.pushKey).map((row) => {
          const value = DeviceRow.parse(row);
          return { id: createHash("sha256").update(value.endpoint).digest("hex").slice(0, 16), service: pushServiceOf(value.endpoint), createdAt: value.created_at };
        });

  const snapshot = (): SettingsSnapshot => {
    const conversations = options.conversations();
    const subscriptions = options.defaults.subscriptions();
    return {
      machines: options.runners.statuses(),
      enrollments: options.admin.pending(),
      canAdd: { ...options.admin.canAdd },
      repositories: options.repositories.list(),
      accounts: gitHubAccounts.map((account) => ({ account, configured: options.credentials(account).ok })),
      brain: brainSettings(conversations?.linked() ?? false, order(), conversations?.providers()),
      table: options.defaults.table(),
      subscriptions: [subscriptions.codex, subscriptions.claude],
      unavailable: options.defaults.unavailable(),
      devices: devices(),
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
    order,
    setOrder: (chosen) => {
      const full = fullOrder(chosen);
      upsertSetting.run(orderKey, JSON.stringify(full), options.clock.now());
      options.conversations()?.sendOrder(full);
      changed();
      return full;
    },
    setTable: (table) => {
      const unoffered = unofferedChanges(table, options.defaults.table(), options.defaults.machines());
      if (unoffered.length > 0) {
        return { ok: false, unoffered };
      }
      return { ok: true, table: options.defaults.setTable(table) };
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
