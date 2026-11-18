import type { AllowanceReport } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { compactValue, percentTone, providersOf } from "./allowance.js";

const report: AllowanceReport = {
  subscriptions: [
    { program: "codex", state: "available", remainingPercent: 50, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "primary", usedPercent: 99, durationMinutes: 300, resetsAt: 11 }, { name: "secondary", usedPercent: 15, durationMinutes: 10080, resetsAt: 12 }] },
    { program: "claude", state: "available", remainingPercent: 51, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "session", usedPercent: 49, resetsAt: 11 }, { name: "weekly_all", usedPercent: 81, resetsAt: 12 }] },
  ],
  balance: { program: "dsh", available: true, readAt: 10, machine: "mini", problem: null, state: "low", wallets: [{ currency: "CNY", total: 29.99, granted: 0, toppedUp: 29.99 }] },
  unavailable: [],
};

describe("provider allowance display", () => {
  it("shows GPT weekly and both Claude windows, with compact values", () => {
    const [gpt, claude, deepseek] = providersOf(report);
    expect(gpt?.windows).toMatchObject([{ name: "week", remaining: 85 }]);
    expect(claude?.windows).toMatchObject([{ name: "fiveHours", remaining: 51 }, { name: "sevenDays", remaining: 19 }]);
    expect([gpt, claude, deepseek].map((provider) => provider && compactValue(provider))).toEqual(["85%", "19%", "¥29.99"]);
    expect(deepseek?.tone).toBe("warn");
  });
  it("uses state hues at boundaries and distinguishes unknown and unavailable", () => {
    expect([percentTone(null), percentTone(0), percentTone(19.9), percentTone(20)]).toEqual(["unknown", "bad", "warn", "ok"]);
    expect(providersOf(null).map((item) => item.tone)).toEqual(["unknown", "unknown", "unknown"]);
    const marked = providersOf({ ...report, unavailable: [{ program: "claude", reason: "limit", since: 1, until: 100, given: true }] });
    expect(marked[1]).toMatchObject({ tone: "bad", unavailableUntil: 100 });
    expect(compactValue(marked[1]!)).toBeNull();
    expect(providersOf({ ...report, balance: { ...report.balance!, state: "empty" } })[2]?.tone).toBe("bad");
  });
});
