import type { AllowanceReport } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { compactValue, usageTone, providersOf } from "./allowance.js";

const report: AllowanceReport = {
  subscriptions: [
    { program: "codex", state: "available", remainingPercent: 50, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "primary", usedPercent: 99, durationMinutes: 300, resetsAt: 11 }, { name: "secondary", usedPercent: 15, durationMinutes: 10080, resetsAt: 12 }] },
    { program: "claude", state: "available", remainingPercent: 51, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "session", usedPercent: 49, resetsAt: 11 }, { name: "weekly_all", usedPercent: 81, resetsAt: 12 }] },
    { program: "antigravity", state: "available", remainingPercent: 70, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "seven_day", usedPercent: 15, durationMinutes: 10080, resetsAt: 12 }, { name: "five_hour", usedPercent: 30, durationMinutes: 300, resetsAt: null }] },
  ],
  balance: { program: "dsh", available: true, readAt: 10, machine: "mini", problem: null, state: "low", wallets: [{ currency: "CNY", total: 29.99, granted: 0, toppedUp: 29.99 }] },
  unavailable: [],
};

describe("provider allowance display", () => {
  it("shows GPT weekly, both Claude and Gemini windows, and DeepSeek in order", () => {
    const providers = providersOf(report);
    expect(providers.map((provider) => provider.name)).toEqual(["GPT", "Claude", "Antigravity", "DeepSeek"]);
    const [gpt, claude, antigravity, deepseek] = providers;
    expect(gpt?.windows).toMatchObject([{ name: "week", used: 15 }]);
    expect(claude?.windows).toMatchObject([{ name: "fiveHours", used: 49 }, { name: "week", used: 81 }]);
    expect(antigravity?.windows).toMatchObject([{ name: "fiveHours", used: 30, resetsAt: null }, { name: "week", used: 15, resetsAt: 12 }]);
    expect(providers.map(compactValue)).toEqual(["15%", "81%", "30%", "¥29.99"]);
    expect(deepseek?.tone).toBe("warn");
  });
  it("uses state hues at boundaries and distinguishes unknown and unavailable", () => {
    expect([usageTone(null), usageTone(0), usageTone(74.9), usageTone(75), usageTone(89.9), usageTone(90)]).toEqual(["unknown", "ok", "ok", "warn", "warn", "bad"]);
    expect(providersOf(null).map((item) => item.tone)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    const marked = providersOf({ ...report, unavailable: [{ program: "antigravity", reason: "login required", since: 1, until: 100, given: true }] });
    expect(marked[2]).toMatchObject({ tone: "bad", unavailableUntil: 100 });
    expect(compactValue(marked[2]!)).toBeNull();
    expect(providersOf({ ...report, balance: { ...report.balance!, state: "empty" } })[3]?.tone).toBe("bad");
  });
});
