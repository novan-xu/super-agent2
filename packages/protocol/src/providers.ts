import { z } from "zod";
import { AllowanceList, type Subscription } from "./allowance.js";
import { type EngineTable, type MachineChoice, machinesFor, offers, tableChoice } from "./defaults.js";
import { type Provider, startingWorkerOrder } from "./conversations.js";
import { ProgramId } from "./runner.js";
import type { Difficulty, Platform } from "./tickets.js";

export const providerHoldOff = 10 * 60 * 1000;

export const ProviderUnavailable = z.object({
  program: ProgramId,
  reason: z.string(),
  since: z.number().int(),
  until: z.number().int().nullable(),
  given: z.boolean(),
});
export type ProviderUnavailable = z.infer<typeof ProviderUnavailable>;

export const AllowanceReport = AllowanceList.extend({ unavailable: z.array(ProviderUnavailable).default([]) });
export type AllowanceReport = z.infer<typeof AllowanceReport>;

export interface ProviderMark {
  readonly program: ProgramId;
  readonly reason: string;
  readonly since: number;
  readonly until: number | null;
}

export interface ProviderOut {
  readonly reason: string;
  readonly until: number | null;
  readonly given: boolean;
}

export function markUntil(mark: ProviderMark): number {
  return mark.until ?? mark.since + providerHoldOff;
}

export function markActive(mark: ProviderMark, subscription: Subscription | undefined, now: number): boolean {
  if (markUntil(mark) <= now) {
    return false;
  }
  return !(subscription !== undefined && subscription.state === "available" && subscription.readAt !== null && subscription.readAt > mark.since);
}

export function activeMarks(marks: readonly ProviderMark[], subscriptions: Readonly<Partial<Record<ProgramId, Subscription>>>, now: number): ProviderUnavailable[] {
  return marks
    .filter((mark) => markActive(mark, subscriptions[mark.program], now))
    .map((mark) => ({ program: mark.program, reason: mark.reason, since: mark.since, until: markUntil(mark), given: mark.until !== null }));
}

function later(a: number | null, b: number | null): number | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return Math.max(a, b);
}

export function providersOut(marks: readonly ProviderUnavailable[], subscriptions: Readonly<Partial<Record<ProgramId, Subscription>>>, now: number): Map<ProgramId, ProviderOut> {
  const out = new Map<ProgramId, ProviderOut>();
  for (const [program, subscription] of Object.entries(subscriptions) as [ProgramId, Subscription | undefined][]) {
    if (subscription?.state === "exhausted" && (subscription.resetsAt === null || subscription.resetsAt > now)) {
      out.set(program, { reason: "The subscription is used up", until: subscription.resetsAt, given: subscription.resetsAt !== null });
    }
  }
  for (const mark of marks) {
    const read = out.get(mark.program);
    out.set(mark.program, read === undefined ? { reason: mark.reason, until: mark.until, given: mark.given } : { reason: mark.reason, until: later(read.until, mark.until), given: read.given || mark.given });
  }
  return out;
}

const engineOfProvider: Readonly<Record<Provider, ProgramId>> = { claude: "claude", gpt: "codex", deepseek: "dsh" };

export function engineOrder(order: readonly Provider[] | undefined, prose: boolean): ProgramId[] {
  const full = [...new Set([...(order ?? []), ...startingWorkerOrder])].map((provider) => engineOfProvider[provider]);
  return prose ? ["antigravity", ...full] : full;
}

export interface EngineContext {
  readonly out: ReadonlySet<ProgramId>;
  readonly order: readonly ProgramId[];
  readonly antigravityOut?: ReadonlySet<string>;
}

export const noEngineContext: EngineContext = { out: new Set(), order: engineOrder(undefined, false) };

export interface RouteInput {
  readonly difficulty: Difficulty | null;
  readonly platform: Platform | null;
  readonly requiredMachine: string | null;
  readonly machine: string | null;
  readonly canMove: boolean;
  readonly order: readonly ProgramId[];
  readonly table: EngineTable;
  readonly machines: readonly MachineChoice[];
  readonly out: ReadonlyMap<ProgramId, ProviderOut>;
  readonly antigravityOut?: ReadonlyMap<string, ProviderOut>;
}

export interface RoutedRun {
  readonly machine: string;
  readonly engine: ProgramId;
  readonly model: string;
  readonly effort: string;
}

export type Routing =
  | ({ readonly kind: "run" } & RoutedRun)
  | { readonly kind: "wait"; readonly engines: readonly ProgramId[]; readonly until: number | null }
  | { readonly kind: "none" };

function placesFor(input: RouteInput, engine: ProgramId): RoutedRun[] {
  const choice = tableChoice(input.table, engine, input.difficulty);
  const choices = engine === "antigravity" ? input.table.antigravity : choice === null ? [] : [choice];
  const fitting = machinesFor(input.platform, input.machines, input.requiredMachine)
    .filter((machine) => input.canMove || machine.name === input.machine)
    .sort((a, b) => Number(b.name === input.machine) - Number(a.name === input.machine) || b.free - a.free || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return choices.flatMap((pair) => {
    const found = fitting.find((machine) => offers(machine, engine, pair.model, pair.effort));
    return found === undefined ? [] : [{ machine: found.name, engine, ...pair }];
  });
}

export function outFor(out: ReadonlyMap<ProgramId, ProviderOut>, antigravityOut: ReadonlyMap<string, ProviderOut> | undefined, engine: ProgramId, model: string): ProviderOut | undefined {
  const provider = out.get(engine);
  const pair = engine === "antigravity" ? antigravityOut?.get(model) : undefined;
  if (provider === undefined || pair === undefined) return provider ?? pair;
  return { reason: provider.reason, until: later(provider.until, pair.until), given: provider.given || pair.given };
}

export function routeProvider(input: RouteInput): Routing {
  const candidates = input.order.flatMap((engine) => placesFor(input, engine));
  if (candidates.length === 0) {
    return { kind: "none" };
  }
  const markOf = (candidate: RoutedRun) => outFor(input.out, input.antigravityOut, candidate.engine, candidate.model);
  const usable = candidates.find((candidate) => markOf(candidate) === undefined);
  if (usable !== undefined) {
    return { kind: "run", ...usable };
  }
  const untils = candidates.flatMap((candidate) => {
    const until = markOf(candidate)?.until;
    return until === null || until === undefined ? [] : [until];
  });
  return { kind: "wait", engines: [...new Set(candidates.map((candidate) => candidate.engine))], until: untils.length === 0 ? null : Math.min(...untils) };
}
