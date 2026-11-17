import { describe, expect, it } from "vitest";
import { allowanceFrom, allowanceMaxAge, currentSubscription, type MachineReading, unknownAllowance } from "./allowance.js";

const now = 1_800_000_000_000;

describe("an allowance reading", () => {
  it("is what is left in the most used window", () => {
    const reading = allowanceFrom("claude", now, [
      { name: "session", usedPercent: 24, resetsAt: now + 1000 },
      { name: "weekly", usedPercent: 4, resetsAt: now + 9000 },
    ], false);
    expect(reading).toMatchObject({ state: "available", remainingPercent: 76, resetsAt: now + 1000 });
  });

  it("is used up when a window is full or the program says it is blocked", () => {
    expect(allowanceFrom("codex", now, [{ name: "primary", usedPercent: 100, resetsAt: now + 5000 }], false)).toMatchObject({
      state: "exhausted",
      remainingPercent: 0,
      resetsAt: now + 5000,
    });
    expect(allowanceFrom("codex", now, [{ name: "primary", usedPercent: 40, resetsAt: null }], true)).toMatchObject({ state: "exhausted", remainingPercent: 0 });
  });

  it("is unknown without any window", () => {
    expect(allowanceFrom("codex", now, [], false).state).toBe("unknown");
  });
});

describe("the current subscription", () => {
  const exhausted = (readAt: number, resetsAt: number | null): MachineReading => ({
    machine: "pc",
    reading: { program: "codex", readAt, state: "exhausted", remainingPercent: 0, resetsAt, windows: [], problem: null },
  });

  it("takes the newest current reading from any machine", () => {
    const readings: MachineReading[] = [
      exhausted(now - 2000, now + 60_000),
      { machine: "mini", reading: allowanceFrom("codex", now - 1000, [{ name: "primary", usedPercent: 30, resetsAt: null }], false) },
    ];
    expect(currentSubscription("codex", readings, now)).toMatchObject({ state: "available", remainingPercent: 70, machine: "mini", readAt: now - 1000 });
  });

  it("does not count a stale reading, one whose reset has passed, or an unknown one as used up", () => {
    expect(currentSubscription("codex", [exhausted(now - allowanceMaxAge - 1, null)], now).state).toBe("unknown");
    expect(currentSubscription("codex", [exhausted(now - 1000, now - 1)], now).state).toBe("unknown");
    expect(currentSubscription("codex", [{ machine: "pc", reading: unknownAllowance("codex", now, "no answer") }], now).state).toBe("unknown");
    expect(currentSubscription("codex", [exhausted(now - 1000, now + 1)], now).state).toBe("exhausted");
    expect(currentSubscription("claude", [exhausted(now - 1000, now + 1)], now).state).toBe("unknown");
  });
});
