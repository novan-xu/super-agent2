import {
  type BrainSettings,
  chosenProviders,
  type Difficulty,
  difficulties,
  type EngineTable,
  fullOrder,
  MachineName,
  type MachineChoice,
  type MachineStatus,
  type Provider,
  type ProviderState,
  type SettingsSection,
  type Subscription,
  type TableCell,
  type TableEngine,
  tableEngines,
  type Ticket,
} from "@super-agent2/protocol";

export type SettingsGroup = "work" | "links" | "personal";

export const settingsGroups: readonly { readonly group: SettingsGroup; readonly sections: readonly SettingsSection[] }[] = [
  { group: "work", sections: ["machines", "models", "repositories"] },
  { group: "links", sections: ["connections"] },
  { group: "personal", sections: ["appearance"] },
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
  const chosen = order.filter((item): item is (typeof chosenProviders)[number] => (chosenProviders as readonly string[]).includes(item));
  for (const item of chosenProviders) {
    if (!chosen.includes(item)) {
      chosen.push(item);
    }
  }
  const index = chosen.indexOf(provider as (typeof chosenProviders)[number]);
  if (index > 0) {
    const before = chosen[index - 1];
    const moved = chosen[index];
    if (before !== undefined && moved !== undefined) {
      chosen[index - 1] = moved;
      chosen[index] = before;
    }
  }
  return chosen;
}

export interface ProviderRow {
  readonly provider: Provider;
  readonly state: ProviderState | undefined;
  readonly movable: boolean;
}

export function providerRows(brain: BrainSettings): ProviderRow[] {
  const order = fullOrder(brain.order);
  return order.map((provider, index) => ({
    provider,
    state: brain.providers.find((state) => state.provider === provider),
    movable: index > 0 && (chosenProviders as readonly string[]).includes(provider),
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

export interface PairOption {
  readonly model: string;
  readonly effort: string;
  readonly offered: boolean;
}

export function pairKey(model: string, effort: string): string {
  return `${model}\u0000${effort}`;
}

export function pairOptions(machines: readonly MachineChoice[], engine: TableEngine, current: { readonly model: string; readonly effort: string }): PairOption[] {
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
  if (!seen.has(pairKey(current.model, current.effort))) {
    options.unshift({ model: current.model, effort: current.effort, offered: false });
  }
  return options;
}

export interface TableRow {
  readonly engine: TableEngine;
  readonly difficulty: Difficulty | null;
  readonly current: { readonly model: string; readonly effort: string };
}

export function tableRows(table: EngineTable): { readonly engine: TableEngine; readonly rows: TableRow[] }[] {
  return tableEngines.map((engine) => ({
    engine,
    rows:
      engine === "antigravity"
        ? [{ engine, difficulty: null, current: table.antigravity }]
        : difficulties.map((difficulty) => ({ engine, difficulty, current: table[engine][difficulty] })),
  }));
}

export function cellOf(row: TableRow, model: string, effort: string): TableCell {
  return { engine: row.engine, difficulty: row.difficulty, model, effort };
}
