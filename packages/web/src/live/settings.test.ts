import { type MachineChoice, type MachineStatus, startingEngineTable, type Ticket } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { ticket } from "./fixtures.js";
import { availableNow, movedEarlier, nameProblem, pairOptions, providerRows, slotsOf, subscriptionOf, tableRows, ticketsRunningOn } from "./settings.js";

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

describe("the brain's providers", () => {
  it("move one place earlier, with DeepSeek fixed last", () => {
    expect(movedEarlier(["gpt", "claude", "deepseek"], "claude")).toEqual(["claude", "gpt"]);
    expect(movedEarlier(["claude", "gpt", "deepseek"], "claude")).toEqual(["claude", "gpt"]);
    expect(movedEarlier(["claude", "deepseek"], "gpt")).toEqual(["gpt", "claude"]);
  });

  it("are listed in order with their state, and only GPT and Claude move", () => {
    const rows = providerRows({ linked: true, order: ["claude", "gpt", "deepseek"], providers: [{ provider: "gpt", model: "m", effort: "high", available: false, until: 5 }] });
    expect(rows.map((row) => [row.provider, row.movable, row.state?.available])).toEqual([
      ["claude", false, undefined],
      ["gpt", true, false],
      ["deepseek", false, undefined],
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

  it("has a row per difficulty for each code engine and one for Antigravity", () => {
    const groups = tableRows(startingEngineTable);
    expect(groups.map((group) => [group.engine, group.rows.length])).toEqual([
      ["codex", 3],
      ["claude", 3],
      ["dsh", 3],
      ["antigravity", 1],
    ]);
    expect(groups[0]?.rows[2]).toEqual({ engine: "codex", difficulty: "complex", current: startingEngineTable.codex.complex });
  });
});
