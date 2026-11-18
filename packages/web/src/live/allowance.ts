import type { AllowanceReport, AllowanceWindow, Subscription } from "@super-agent2/protocol";

export type Tone = "ok" | "warn" | "bad" | "unknown";
export type WindowName = "week" | "fiveHours" | "sevenDays";
export interface WindowView { readonly name: WindowName; readonly remaining: number | null; readonly resetsAt: number | null; readonly tone: Tone }
export interface ProviderView {
  readonly id: "codex" | "claude" | "dsh";
  readonly name: string;
  readonly compactName: string;
  readonly windows: readonly WindowView[];
  readonly amount: string | null;
  readonly tone: Tone;
  readonly unavailableUntil: number | null | undefined;
  readonly readAt: number | null;
  readonly machine: string | null;
}

export function percentTone(value: number | null): Tone {
  return value === null ? "unknown" : value <= 0 ? "bad" : value < 20 ? "warn" : "ok";
}

function windowView(name: WindowName, item: AllowanceWindow | undefined): WindowView {
  const remaining = item === undefined ? null : Math.max(0, Math.min(100, 100 - item.usedPercent));
  return { name, remaining, resetsAt: item?.resetsAt ?? null, tone: percentTone(remaining) };
}

function weekly(windows: readonly AllowanceWindow[]): AllowanceWindow | undefined {
  return windows.find((item) => item.durationMinutes === 10080) ?? windows.find((item) => item.name === "secondary" && item.durationMinutes === undefined) ?? (windows.length === 1 && windows[0]?.durationMinutes === undefined ? windows[0] : undefined);
}

function windowsOf(id: "codex" | "claude", subscription: Subscription | undefined): WindowView[] {
  const windows = subscription?.state === "unknown" ? [] : subscription?.windows ?? [];
  if (id === "codex") return [windowView("week", weekly(windows))];
  return [windowView("fiveHours", windows.find((item) => item.name === "five_hour" || item.name === "session")), windowView("sevenDays", windows.find((item) => item.name === "seven_day" || item.name === "weekly_all"))];
}

function currency(currency: string, total: number): string {
  const sign = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
  return `${sign}${total.toFixed(2)}`;
}

export function providersOf(report: AllowanceReport | null, now = 0): ProviderView[] {
  const result: ProviderView[] = (["codex", "claude"] as const).map((id) => {
    const subscription = report?.subscriptions.find((item) => item.program === id);
    const windows = windowsOf(id, subscription);
    const mark = report?.unavailable.find((item) => item.program === id && (item.until === null || item.until > now));
    const tones = windows.map((item) => item.tone);
    const tone: Tone = mark || subscription?.state === "exhausted" || tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : tones.includes("ok") ? "ok" : "unknown";
    return { id, name: id === "codex" ? "GPT" : "Claude", compactName: id === "codex" ? "GPT" : "Claude", windows, amount: null, tone, unavailableUntil: mark === undefined ? undefined : mark.until, readAt: subscription?.readAt ?? null, machine: subscription?.machine ?? null };
  });
  const balance = report?.balance;
  const mark = report?.unavailable.find((item) => item.program === "dsh" && (item.until === null || item.until > now));
  result.push({ id: "dsh", name: "DeepSeek", compactName: "DS", windows: [], amount: balance?.state === "unknown" || !balance ? null : balance.wallets.map((wallet) => currency(wallet.currency, wallet.total)).join(" · "), tone: mark || balance?.state === "empty" ? "bad" : balance?.state === "low" ? "warn" : balance?.state === "ok" ? "ok" : "unknown", unavailableUntil: mark === undefined ? undefined : mark.until, readAt: balance?.machine ? balance.readAt : null, machine: balance?.machine ?? null });
  return result;
}

export function compactValue(provider: ProviderView): string | null {
  if (provider.unavailableUntil !== undefined) return null;
  if (provider.id === "dsh") return provider.amount;
  const values = provider.windows.flatMap((item) => item.remaining === null ? [] : [item.remaining]);
  return values.length === 0 ? null : `${Math.round(Math.min(...values))}%`;
}
