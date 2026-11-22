import {
  type BrainSettings,
  type Difficulty,
  difficulties,
  type EngineTable,
  fullOrder,
  MachineName,
  type MachineChoice,
  type MachineStatus,
  type Provider,
  type ProviderState,
  type ProviderUnavailable,
  type SettingsSection,
  type Subscription,
  type TableCell,
  type TableEngine,
  tableEngines,
  type Ticket,
} from "@super-agent2/protocol";

export type SettingsGroup = "work" | "links" | "personal";

export const settingsGroups: readonly { readonly group: SettingsGroup; readonly sections: readonly SettingsSection[] }[] = [
  { group: "work", sections: ["machines", "models", "repositories", "usage"] },
  { group: "links", sections: ["connections"] },
  { group: "personal", sections: ["appearance", "history"] },
];

export const firstSection: SettingsSection = "machines";

export interface Slots {
  readonly total: number;
  readonly running: number;
  readonly free: number;
}

export function slotsOf(status: MachineStatus): Slots {
  const total = status.report?.slots.total ?? 0;
  const free = status.online ? Math.min(total, status.report?.slots.free ?? 0) : 0;
  return { total, running: status.online ? total - free : 0, free };
}

export function onlineCount(machines: readonly MachineStatus[]): number {
  return machines.filter((machine) => machine.online).length;
}

export function ticketsRunningOn(tickets: readonly Ticket[], machine: string): number {
  return tickets.filter((ticket) => ticket.state === "working" && ticket.machine === machine).length;
}

export type NameProblem = "name" | "taken";

export function nameProblem(name: string, machines: readonly MachineStatus[]): NameProblem | null {
  if (!MachineName.safeParse(name).success) {
    return "name";
  }
  return machines.some((machine) => machine.name === name) ? "taken" : null;
}

export function movedEarlier(order: readonly Provider[], provider: Provider): Provider[] {
  const chosen = fullOrder(order);
  const index = chosen.indexOf(provider);
  if (index > 0) {
    chosen.splice(index, 1);
    chosen.splice(index - 1, 0, provider);
  }
  return chosen;
}

export interface ProviderRow {
  readonly provider: Provider;
  readonly state: ProviderState | undefined;
}

export function providerRows(order: readonly Provider[], states: BrainSettings["providers"] = []): ProviderRow[] {
  return fullOrder(order).map((provider) => ({
    provider,
    state: states.find((state) => state.provider === provider),
  }));
}

export function availableNow(state: ProviderState | undefined, now: number): boolean | undefined {
  if (state === undefined) {
    return undefined;
  }
  return state.available || (state.until !== null && state.until <= now);
}

export function subscriptionOf(subscriptions: readonly Subscription[], provider: Provider): Subscription | undefined {
  const program = provider === "gpt" ? "codex" : provider === "claude" ? "claude" : undefined;
  return program === undefined ? undefined : subscriptions.find((subscription) => subscription.program === program);
}

export function workersOut(unavailable: readonly ProviderUnavailable[], provider: Provider): ProviderUnavailable | undefined {
  const program = provider === "gpt" ? "codex" : provider === "claude" ? "claude" : "dsh";
  return unavailable.find((mark) => mark.program === program);
}

export interface PairOption {
  readonly model: string;
  readonly effort: string;
  readonly offered: boolean;
}

export function pairKey(model: string, effort: string): string {
  return `${model}\u0000${effort}`;
}

export function pairOptions(machines: readonly MachineChoice[], engine: TableEngine, current?: { readonly model: string; readonly effort: string }): PairOption[] {
  const seen = new Set<string>();
  const options: PairOption[] = [];
  for (const machine of machines) {
    for (const offer of machine.engines.filter((item) => item.engine === engine)) {
      for (const model of offer.models) {
        for (const effort of model.efforts) {
          const key = pairKey(model.id, effort);
          if (!seen.has(key)) {
            seen.add(key);
            options.push({ model: model.id, effort, offered: true });
          }
        }
      }
    }
  }
  if (current !== undefined && !seen.has(pairKey(current.model, current.effort))) {
    options.unshift({ model: current.model, effort: current.effort, offered: false });
  }
  return options;
}

export function withChoice(options: readonly PairOption[], chosen: { readonly model: string; readonly effort: string }): PairOption[] {
  const key = pairKey(chosen.model, chosen.effort);
  return options.some((option) => pairKey(option.model, option.effort) === key) ? [...options] : [{ model: chosen.model, effort: chosen.effort, offered: false }, ...options];
}

export interface TableRow {
  readonly engine: Exclude<TableEngine, "antigravity">;
  readonly difficulty: Difficulty;
  readonly current: { readonly model: string; readonly effort: string };
}

export function tableRows(table: EngineTable): { readonly engine: TableRow["engine"]; readonly rows: TableRow[] }[] {
  return tableEngines.filter((engine) => engine !== "antigravity").map((engine) => ({
    engine,
    rows: difficulties.map((difficulty) => ({ engine, difficulty, current: table[engine][difficulty] })),
  }));
}

export function cellOf(row: TableRow, model: string, effort: string): TableCell {
  return { engine: row.engine, difficulty: row.difficulty, model, effort };
}
