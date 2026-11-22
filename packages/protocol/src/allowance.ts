import { z } from "zod";

export const allowancePrograms = ["codex", "claude", "antigravity"] as const;
export const AllowanceProgram = z.enum(allowancePrograms);
export type AllowanceProgram = z.infer<typeof AllowanceProgram>;

export const allowanceStates = ["available", "exhausted", "unknown"] as const;
export const AllowanceState = z.enum(allowanceStates);
export type AllowanceState = z.infer<typeof AllowanceState>;

export const AllowanceWindow = z.object({
  name: z.string().min(1),
  usedPercent: z.number().min(0),
  durationMinutes: z.number().positive().optional(),
  resetsAt: z.number().int().nullable(),
});
export type AllowanceWindow = z.infer<typeof AllowanceWindow>;

export const SubscriptionReading = z.object({
  program: AllowanceProgram,
  readAt: z.number().int(),
  state: AllowanceState,
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.number().int().nullable(),
  windows: z.array(AllowanceWindow),
  problem: z.string().nullable(),
});
export type SubscriptionReading = z.infer<typeof SubscriptionReading>;

export const BalanceWallet = z.object({ currency: z.string().min(1), total: z.number().finite(), granted: z.number().finite(), toppedUp: z.number().finite() });
export const BalanceReading = z.object({
  program: z.literal("dsh"), readAt: z.number().int(), available: z.boolean().nullable(),
  wallets: z.array(BalanceWallet), problem: z.string().nullable(),
});
export type BalanceReading = z.infer<typeof BalanceReading>;
export const AllowanceReading = z.union([SubscriptionReading, BalanceReading]);
export type AllowanceReading = z.infer<typeof AllowanceReading>;
export const Balance = BalanceReading.extend({ state: z.enum(["ok", "low", "empty", "unknown"]), machine: z.string().nullable() });
export type Balance = z.infer<typeof Balance>;
export const defaultLowBalance = 30;

export function currentBalance(readings: readonly MachineReading[], now: number, low: number = defaultLowBalance, maxAge: number = Number.MAX_SAFE_INTEGER): Balance {
  const current = readings.filter((item): item is MachineReading & { reading: BalanceReading } => item.reading.program === "dsh" && item.reading.readAt <= now && now - item.reading.readAt <= maxAge)
    .sort((a, b) => b.reading.readAt - a.reading.readAt || a.machine.localeCompare(b.machine))[0];
  if (current === undefined) return { program: "dsh", readAt: now, available: null, wallets: [], problem: "no current reading", state: "unknown", machine: null };
  const { reading } = current;
  const state = reading.available === null ? "unknown" : !reading.available || reading.wallets.every((wallet) => wallet.total <= 0) ? "empty" : reading.wallets.every((wallet) => wallet.total < low) ? "low" : "ok";
  return { ...reading, state, machine: current.machine };
}

export function unknownAllowance(program: AllowanceProgram, readAt: number, problem: string | null): z.infer<typeof SubscriptionReading> {
  return { program, readAt, state: "unknown", remainingPercent: null, resetsAt: null, windows: [], problem };
}

export function allowanceFrom(program: AllowanceProgram, readAt: number, windows: readonly AllowanceWindow[], blocked: boolean): z.infer<typeof SubscriptionReading> {
  if (windows.length === 0 && !blocked) {
    return unknownAllowance(program, readAt, "the program reported no usage window");
  }
  const most = [...windows].sort((a, b) => b.usedPercent - a.usedPercent || (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
  const used = most === undefined ? 100 : Math.min(100, most.usedPercent);
  const full = windows.filter((window) => window.usedPercent >= 100);
  const exhausted = blocked || full.length > 0;
  const resets = exhausted
    ? full.reduce<number | null>((latest, window) => (window.resetsAt !== null && (latest === null || window.resetsAt > latest) ? window.resetsAt : latest), null)
    : (most?.resetsAt ?? null);
  return {
    program,
    readAt,
    state: exhausted ? "exhausted" : "available",
    remainingPercent: exhausted ? 0 : Math.max(0, 100 - used),
    resetsAt: resets,
    windows: [...windows],
    problem: null,
  };
}

export const allowanceMaxAge = 30 * 60 * 1000;

export const Subscription = z.object({
  program: AllowanceProgram,
  state: AllowanceState,
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.number().int().nullable(),
  readAt: z.number().int().nullable(),
  machine: z.string().nullable(),
  windows: z.array(AllowanceWindow).optional(),
});
export type Subscription = z.infer<typeof Subscription>;

export interface MachineReading {
  readonly machine: string;
  readonly reading: AllowanceReading;
}

export function currentSubscription(program: AllowanceProgram, readings: readonly MachineReading[], now: number, maxAge: number = allowanceMaxAge): Subscription {
  const current = readings
    .filter((item): item is MachineReading & { reading: z.infer<typeof SubscriptionReading> } => item.reading.program !== "dsh")
    .filter(({ reading }) => reading.program === program && reading.state !== "unknown" && reading.readAt <= now && now - reading.readAt <= maxAge)
    .filter(({ reading }) => !(reading.state === "exhausted" && reading.resetsAt !== null && reading.resetsAt <= now))
    .sort((a, b) => b.reading.readAt - a.reading.readAt || (a.machine < b.machine ? -1 : 1))[0];
  if (current === undefined) {
    return { program, state: "unknown", remainingPercent: null, resetsAt: null, readAt: null, machine: null };
  }
  const { reading } = current;
  return {
    program,
    state: reading.state,
    remainingPercent: reading.remainingPercent,
    resetsAt: reading.resetsAt,
    readAt: reading.readAt,
    machine: current.machine,
    windows: reading.windows,
  };
}

export const OpenAICost = z.object({ state: z.enum(["available", "unknown"]), amount: z.number().finite().nullable(), currency: z.string().nullable(), readAt: z.number().nullable(), budget: z.number().positive().nullable() });
export type OpenAICost = z.infer<typeof OpenAICost>;

export const AllowanceList = z.object({
  openaiCost: OpenAICost.optional(),
  subscriptions: z.array(Subscription),
  balance: Balance.optional(),
});
export type AllowanceList = z.infer<typeof AllowanceList>;

export type Subscriptions = Readonly<Record<AllowanceProgram, Subscription>>;

export function subscriptionsOf(readings: readonly MachineReading[], now: number, maxAge: number = allowanceMaxAge): Subscriptions {
  return {
    codex: currentSubscription("codex", readings, now, maxAge),
    claude: currentSubscription("claude", readings, now, maxAge),
    antigravity: currentSubscription("antigravity", readings, now, maxAge),
  };
}
