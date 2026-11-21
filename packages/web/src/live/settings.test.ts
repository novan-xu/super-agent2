import { type MachineChoice, type MachineStatus, startingEngineTable, type Ticket } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { ticket } from "./fixtures.js";
import { availableNow, movedEarlier, nameProblem, pairOptions, providerRows, withChoice, slotsOf, subscriptionOf, tableRows, ticketsRunningOn, workersOut } from "./settings.js";

const report = {
  hostname: "pc",
  platform: "win32" as const,
  release: "10",
  arch: "x64",
  user: "owner",
  slots: { total: 3, free: 1 },
  programs: [],
  allowances: [],
};

function machine(name: string, online: boolean): MachineStatus {
  return { name, online, createdAt: 1, lastSeenAt: 2, report };
}

describe("machines in 设置", () => {
  it("count running and free slots only while online", () => {
    expect(slotsOf(machine("pc", true))).toEqual({ total: 3, running: 2, free: 1 });
    expect(slotsOf(machine("pc", false))).toEqual({ total: 3, running: 0, free: 0 });
    expect(slotsOf({ ...machine("pc", true), report: null })).toEqual({ total: 0, running: 0, free: 0 });
  });

  it("count the tickets working on a machine", () => {
    const tickets: Ticket[] = [
      { ...ticket(1), state: "working", machine: "pc" },
      { ...ticket(2), state: "verifying", machine: "pc" },
      { ...ticket(3), state: "working", machine: "mini" },
      { ...ticket(4), state: "working", machine: "pc" },
    ];
    expect(ticketsRunningOn(tickets, "pc")).toBe(2);
    expect(ticketsRunningOn(tickets, "studio")).toBe(0);
  });

  it("check a new machine's name before asking the hub", () => {
    expect(nameProblem("studio-pc", [machine("pc", true)])).toBeNull();
    expect(nameProblem("pc", [machine("pc", false)])).toBe("taken");
    expect(nameProblem("Studio", [])).toBe("name");
    expect(nameProblem("nas", [])).toBe("name");
    expect(nameProblem("", [])).toBe("name");
  });
});

describe("provider orders", () => {
  it("moves any provider one place earlier while keeping all three", () => {
    expect(movedEarlier(["gpt", "claude", "deepseek"], "claude")).toEqual(["claude", "gpt", "deepseek"]);
    expect(movedEarlier(["claude", "gpt", "deepseek"], "claude")).toEqual(["claude", "gpt", "deepseek"]);
    expect(movedEarlier(["claude", "gpt", "deepseek"], "deepseek")).toEqual(["claude", "deepseek", "gpt"]);
    expect(movedEarlier(["claude", "deepseek", "gpt"], "deepseek")).toEqual(["deepseek", "claude", "gpt"]);
  });

  it("lists providers in order with their state when reported", () => {
    const rows = providerRows(["deepseek", "gpt", "claude"], [{ provider: "gpt", model: "m", effort: "high", available: false, until: 5 }]);
    expect(rows.map((row) => [row.provider, row.state?.available])).toEqual([
      ["deepseek", undefined],
      ["gpt", false],
      ["claude", undefined],
    ]);
    expect(availableNow(rows[1]?.state, 4)).toBe(false);
    expect(availableNow(rows[1]?.state, 5)).toBe(true);
    expect(availableNow(undefined, 5)).toBeUndefined();
  });

  it("read what is left on the subscription each provider uses", () => {
    const codex = { program: "codex" as const, state: "available" as const, remainingPercent: 40, resetsAt: null, readAt: 1, machine: "pc" };
    expect(subscriptionOf([codex], "gpt")).toBe(codex);
    expect(subscriptionOf([codex], "claude")).toBeUndefined();
    expect(subscriptionOf([codex], "deepseek")).toBeUndefined();
  });
});

describe("the providers the hub marked unavailable for workers", () => {
  it("are found by the provider each program stands for", () => {
    const claude = { program: "claude" as const, reason: "limit", since: 1, until: 9, given: true };
    const dsh = { program: "dsh" as const, reason: "auth", since: 1, until: 9, given: false };
    expect(workersOut([claude, dsh], "claude")).toBe(claude);
    expect(workersOut([claude, dsh], "deepseek")).toBe(dsh);
    expect(workersOut([claude, dsh], "gpt")).toBeUndefined();
    expect(workersOut([], "claude")).toBeUndefined();
  });
});

describe("the model table", () => {
  const machines: MachineChoice[] = [
    { name: "pc", platform: "win32", free: 1, engines: [{ engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high", "xhigh"] }] }] },
    { name: "mini", platform: "darwin", free: 1, engines: [{ engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high"] }, { id: "gpt-6-luna", efforts: ["medium"] }] }] },
  ];

  it("offers each pair some online machine offers, once, and keeps an unoffered current value first", () => {
    expect(pairOptions(machines, "codex", { model: "gpt-6.1-sol", effort: "high" })).toEqual([
      { model: "gpt-6.1-sol", effort: "high", offered: true },
      { model: "gpt-6.1-sol", effort: "xhigh", offered: true },
      { model: "gpt-6-luna", effort: "medium", offered: true },
    ]);
    expect(pairOptions(machines, "claude", { model: "claude-opus-5-5", effort: "high" })).toEqual([{ model: "claude-opus-5-5", effort: "high", offered: false }]);
  });

  it("keeps a pair the owner picked even after the machine offering it went away", () => {
    const options = pairOptions([], "codex", { model: "gpt-6-luna", effort: "medium" });
    expect(withChoice(options, { model: "gpt-6-luna", effort: "high" })).toEqual([
      { model: "gpt-6-luna", effort: "high", offered: false },
      { model: "gpt-6-luna", effort: "medium", offered: false },
    ]);
    expect(withChoice(options, { model: "gpt-6-luna", effort: "medium" })).toEqual(options);
  });

  it("has a row per difficulty for each code engine", () => {
    const groups = tableRows(startingEngineTable);
    expect(groups.map((group) => [group.engine, group.rows.length])).toEqual([
      ["codex", 3],
      ["claude", 3],
      ["dsh", 3],
    ]);
    expect(groups[0]?.rows[2]).toEqual({ engine: "codex", difficulty: "complex", current: startingEngineTable.codex.complex });
  });
});
