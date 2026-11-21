import { type AllowanceProgram, type AllowanceReport, type AllowanceWindow, allowancePrograms, type Subscription } from "@super-agent2/protocol";

export type Tone = "ok" | "warn" | "bad" | "unknown";
export type WindowName = "week" | "fiveHours";
export interface WindowView { readonly name: WindowName; readonly used: number | null; readonly resetsAt: number | null; readonly tone: Tone }
export interface ProviderView {
  readonly id: AllowanceProgram | "dsh";
  readonly name: string;
  readonly compactName: string;
  readonly windows: readonly WindowView[];
  readonly amount: string | null;
  readonly tone: Tone;
  readonly unavailableUntil: number | null | undefined;
}

export function usageTone(value: number | null): Tone {
  return value === null ? "unknown" : value < 75 ? "ok" : value < 90 ? "warn" : "bad";
}

function windowView(name: WindowName, item: AllowanceWindow | undefined): WindowView {
  const used = item === undefined ? null : Math.max(0, Math.min(100, item.usedPercent));
  return { name, used, resetsAt: item?.resetsAt ?? null, tone: usageTone(used) };
}

function weekly(windows: readonly AllowanceWindow[]): AllowanceWindow | undefined {
  return windows.find((item) => item.durationMinutes === 10080) ?? windows.find((item) => item.name === "secondary" && item.durationMinutes === undefined) ?? (windows.length === 1 && windows[0]?.durationMinutes === undefined ? windows[0] : undefined);
}

function windowsOf(id: AllowanceProgram, subscription: Subscription | undefined): WindowView[] {
  const windows = subscription?.state === "unknown" ? [] : subscription?.windows ?? [];
  if (id === "codex") return [windowView("week", weekly(windows))];
  return [windowView("fiveHours", windows.find((item) => item.name === "five_hour" || item.name === "session")), windowView("week", windows.find((item) => item.name === "seven_day" || item.name === "weekly_all"))];
}

const providerNames: Readonly<Record<AllowanceProgram, { name: string; compactName: string }>> = {
  codex: { name: "GPT", compactName: "GPT" },
  claude: { name: "Claude", compactName: "Claude" },
  antigravity: { name: "Antigravity", compactName: "Gemini" },
};

function currency(currency: string, total: number): string {
  const sign = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
  return `${sign}${total.toFixed(2)}`;
}

export function providersOf(report: AllowanceReport | null, now = 0): ProviderView[] {
  const result: ProviderView[] = allowancePrograms.map((id) => {
    const subscription = report?.subscriptions.find((item) => item.program === id);
    const windows = windowsOf(id, subscription);
    const mark = report?.unavailable.find((item) => item.program === id && (item.until === null || item.until > now));
    const tones = windows.map((item) => item.tone);
    const tone: Tone = mark || subscription?.state === "exhausted" || tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : tones.includes("ok") ? "ok" : "unknown";
    return { id, ...providerNames[id], windows, amount: null, tone, unavailableUntil: mark === undefined ? undefined : mark.until };
  });
  const balance = report?.balance;
  const mark = report?.unavailable.find((item) => item.program === "dsh" && (item.until === null || item.until > now));
  result.push({ id: "dsh", name: "DeepSeek", compactName: "DS", windows: [], amount: balance?.state === "unknown" || !balance ? null : balance.wallets.map((wallet) => currency(wallet.currency, wallet.total)).join(" · "), tone: mark || balance?.state === "empty" ? "bad" : balance?.state === "low" ? "warn" : balance?.state === "ok" ? "ok" : "unknown", unavailableUntil: mark === undefined ? undefined : mark.until });
  return result;
}

export function compactValue(provider: ProviderView): string | null {
  if (provider.unavailableUntil !== undefined) return null;
  if (provider.id === "dsh") return provider.amount;
  const values = provider.windows.flatMap((item) => item.used === null ? [] : [item.used]);
  return values.length === 0 ? null : `${Math.round(Math.max(...values))}%`;
}
