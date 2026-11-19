import { z } from "zod";
import { Subscription } from "./allowance.js";
import { ProviderState } from "./brain.js";
import { GitHubAccount } from "./commands.js";
import { Provider } from "./conversations.js";
import { EngineTable, type MachineChoice, offers } from "./defaults.js";
import { ProviderUnavailable } from "./providers.js";
import { MachineName, MachineStatus, MachineSystem, type ProgramId } from "./runner.js";
import { type Difficulty, difficulties, RepositoryName } from "./tickets.js";

export const tableEngines = ["codex", "claude", "dsh", "antigravity"] as const;
export type TableEngine = (typeof tableEngines)[number];

export interface TableCell {
  readonly engine: TableEngine;
  readonly difficulty: Difficulty | null;
  readonly model: string;
  readonly effort: string;
}

export function tableCells(table: EngineTable): TableCell[] {
  return tableEngines.flatMap((engine): TableCell[] => {
    if (engine === "antigravity") {
      return [{ engine, difficulty: null, ...table.antigravity }];
    }
    return difficulties.map((difficulty) => ({ engine, difficulty, ...table[engine][difficulty] }));
  });
}

export function withCell(table: EngineTable, cell: TableCell): EngineTable {
  const choice = { model: cell.model, effort: cell.effort };
  if (cell.engine === "antigravity" || cell.difficulty === null) {
    return cell.engine === "antigravity" ? { ...table, antigravity: choice } : table;
  }
  return { ...table, [cell.engine]: { ...table[cell.engine], [cell.difficulty]: choice } };
}

export function offeredAnywhere(machines: readonly MachineChoice[], engine: ProgramId, model: string, effort: string): boolean {
  return machines.some((machine) => offers(machine, engine, model, effort));
}

export function unofferedChanges(next: EngineTable, current: EngineTable, machines: readonly MachineChoice[]): TableCell[] {
  const before = tableCells(current);
  return tableCells(next).filter((cell, index) => {
    const old = before[index];
    const changed = old === undefined || old.model !== cell.model || old.effort !== cell.effort;
    return changed && !offeredAnywhere(machines, cell.engine, cell.model, cell.effort);
  });
}

export const settingsSections = ["machines", "repositories", "models", "appearance", "connections"] as const;
export const SettingsSection = z.enum(settingsSections);
export type SettingsSection = z.infer<typeof SettingsSection>;

export const MachineAddRequest = z.object({ name: MachineName, system: MachineSystem });
export type MachineAddRequest = z.infer<typeof MachineAddRequest>;

export const MachineAdded = z.object({
  name: MachineName,
  system: MachineSystem,
  command: z.string().min(1),
});
export type MachineAdded = z.infer<typeof MachineAdded>;

export const AccessTokenOutcome = z.enum(["removed", "kept", "none"]);
export type AccessTokenOutcome = z.infer<typeof AccessTokenOutcome>;

export const MachineRevoked = z.object({ name: MachineName, accessToken: AccessTokenOutcome });
export type MachineRevoked = z.infer<typeof MachineRevoked>;

export const RepositoryAccount = z.object({ repository: RepositoryName, account: GitHubAccount, chosen: z.boolean(), pinned: z.boolean().default(false), alias: z.string().nullable().optional() });
export type RepositoryAccount = z.infer<typeof RepositoryAccount>;

export const RepositoryAccountChange = z.object({ repository: RepositoryName, account: GitHubAccount });
export type RepositoryAccountChange = z.infer<typeof RepositoryAccountChange>;

export const RepositoryPinChange = z.object({ repository: RepositoryName, pinned: z.boolean() });
export type RepositoryPinChange = z.infer<typeof RepositoryPinChange>;

export const RepositoryAliasChange = z.object({ repository: RepositoryName, alias: z.string().max(40).regex(/^[^\r\n]*$/).nullable() });
export type RepositoryAliasChange = z.infer<typeof RepositoryAliasChange>;

export const AccountState = z.object({ account: GitHubAccount, configured: z.boolean() });
export type AccountState = z.infer<typeof AccountState>;

export const chosenProviders = ["gpt", "claude"] as const;
export const fallbackProvider: Provider = "deepseek";

export const startingOrder: readonly (typeof chosenProviders)[number][] = ["claude", "gpt"];

export const ProviderOrderChange = z.object({
  order: z
    .array(z.enum(chosenProviders))
    .length(chosenProviders.length)
    .refine((order) => new Set(order).size === order.length, { error: "names each provider once" }),
});
export type ProviderOrderChange = z.infer<typeof ProviderOrderChange>;

export function fullOrder(chosen: readonly Provider[]): Provider[] {
  return [...chosen.filter((provider, index) => provider !== fallbackProvider && chosen.indexOf(provider) === index), fallbackProvider];
}

export const BrainSettings = z.object({
  linked: z.boolean(),
  order: z.array(Provider),
  providers: z.array(ProviderState),
});
export type BrainSettings = z.infer<typeof BrainSettings>;

export const pushServices = ["apple", "google", "mozilla", "microsoft", "other"] as const;
export const PushServiceName = z.enum(pushServices);
export type PushServiceName = z.infer<typeof PushServiceName>;

export const Device = z.object({ id: z.string().min(1), service: PushServiceName, createdAt: z.number().int() });
export type Device = z.infer<typeof Device>;

export function pushServiceOf(endpoint: string): PushServiceName {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "other";
  }
  const within = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (within("push.apple.com")) {
    return "apple";
  }
  if (within("googleapis.com")) {
    return "google";
  }
  if (within("mozilla.com") || within("mozaws.net")) {
    return "mozilla";
  }
  if (within("notify.windows.com")) {
    return "microsoft";
  }
  return "other";
}

export const SettingsSnapshot = z.object({
  machines: z.array(MachineStatus),
  canAdd: z.object({ cloudflare: z.boolean(), release: z.boolean() }),
  repositories: z.array(RepositoryAccount),
  accounts: z.array(AccountState),
  brain: BrainSettings,
  table: EngineTable,
  subscriptions: z.array(Subscription),
  unavailable: z.array(ProviderUnavailable).default([]),
  devices: z.array(Device),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

export const SettingsUpdate = z.object({ type: z.literal("settings"), settings: SettingsSnapshot });
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
