import { describe, expect, it } from "vitest";
import {
  applyChange,
  chainDifficulty,
  defaultEngine,
  defaultMachine,
  EngineTable,
  isComplete,
  type MachineChoice,
  machineChoices,
  machinesFor,
  offers,
  ownerGivesUnoffered,
  resolveStart,
  type StartInput,
  startingEngineTable,
  tableChoice,
} from "./defaults.js";
import type { MachineStatus } from "./runner.js";
import { noOwnerChoice } from "./tickets.js";

const pc: MachineChoice = {
  name: "pc",
  platform: "win32",
  free: 2,
  engines: [
    { engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["medium", "high"] }] },
    { engine: "claude", models: [{ id: "claude-opus-5-5", efforts: ["high", "max"] }] },
    { engine: "dsh", models: [{ id: "deepseek-flash", efforts: ["low", "high", "max"] }] },
  ],
};

const mini: MachineChoice = {
  name: "mini",
  platform: "darwin",
  free: 1,
  engines: [
    { engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high"] }] },
    { engine: "claude", models: [{ id: "claude-opus-5-5", efforts: ["high"] }] },
  ],
};

const available = { codex: "available", claude: "available" } as const;

function input(overrides: Partial<StartInput> = {}): StartInput {
  return { kind: "feature", difficulty: "complex", platform: "macos", brainEngine: "claude", stated: true, owner: noOwnerChoice, ...overrides };
}

describe("the starting table", () => {
  it("holds the design's values, Antigravity's included", () => {
    expect(EngineTable.parse(startingEngineTable)).toEqual(startingEngineTable);
    expect(tableChoice(startingEngineTable, "codex", "complex")).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(tableChoice(startingEngineTable, "claude", "mechanical")).toEqual({ model: "claude-haiku-5-5", effort: "medium" });
    expect(tableChoice(startingEngineTable, "dsh", "complex")).toEqual({ model: "deepseek-flash", effort: "max" });
    expect(tableChoice(startingEngineTable, "antigravity", null)).toEqual({ model: "gemini-3.8-flash", effort: "high" });
    expect(tableChoice(startingEngineTable, "codex", null)).toBeNull();
  });

  it("refuses a model or effort with spaces", () => {
    expect(EngineTable.safeParse({ ...startingEngineTable, antigravity: { model: "a b", effort: "high" } }).success).toBe(false);
  });
});

describe("a chain's difficulty", () => {
  it("is the highest of its issues", () => {
    expect(chainDifficulty(["mechanical", "complex", "standard"])).toBe("complex");
    expect(chainDifficulty(["mechanical", null])).toBe("mechanical");
    expect(chainDifficulty([])).toBeNull();
  });
});

describe("the default engine", () => {
  it("is dsh only when both subscriptions are used up", () => {
    expect(defaultEngine("feature", "codex", { codex: "exhausted", claude: "exhausted" })).toBe("dsh");
    for (const codex of ["available", "unknown", "exhausted"] as const) {
      for (const claude of ["available", "unknown"] as const) {
        expect(defaultEngine("feature", "codex", { codex, claude })).not.toBe("dsh");
        expect(defaultEngine("feature", "claude", { codex: claude, claude: codex })).not.toBe("dsh");
      }
    }
  });

  it("is the brain's pick, or the other subscription when the pick is used up", () => {
    expect(defaultEngine("fix", "claude", available)).toBe("claude");
    expect(defaultEngine("fix", "claude", { codex: "available", claude: "exhausted" })).toBe("codex");
    expect(defaultEngine("fix", "codex", { codex: "exhausted", claude: "unknown" })).toBe("claude");
    expect(defaultEngine("fix", "codex", { codex: "unknown", claude: "unknown" })).toBe("codex");
    expect(defaultEngine("fix", null, available)).toBeNull();
  });

  it("is Antigravity for writing", () => {
    expect(defaultEngine("writing", null, { codex: "exhausted", claude: "exhausted" })).toBe("antigravity");
  });
});

describe("the default machine", () => {
  it("takes the platform, the engines a runner has and its free slots", () => {
    expect(defaultMachine("macos", "codex", [pc, mini])).toBe("mini");
    expect(defaultMachine("windows", "codex", [pc, mini])).toBe("pc");
    expect(defaultMachine("any", "codex", [pc, mini])).toBe("pc");
    expect(defaultMachine("any", "codex", [{ ...pc, free: 0 }, mini])).toBe("mini");
    expect(defaultMachine("macos", "dsh", [pc, mini])).toBeNull();
  });

  it("is made only from runners online with a report", () => {
    const status = (name: string, online: boolean): MachineStatus => ({
      name,
      online,
      createdAt: 1,
      lastSeenAt: 1,
      report: {
        hostname: name,
        platform: "darwin",
        release: "1",
        arch: "arm64",
        user: "owner",
        slots: { total: 2, free: 1 },
        programs: [
          { id: "codex", installed: true, path: "codex", version: "1", models: [], source: "program", problem: null },
          { id: "dsh", installed: false, path: null, version: null, models: [], source: "none", problem: null },
        ],
        allowances: [],
      },
    });
    expect(machineChoices([status("mini", true), status("old", false)])).toEqual([{ name: "mini", platform: "darwin", free: 1, engines: [{ engine: "codex", models: [] }] }]);
    const broken = status("broken", true);
    broken.report!.programs[0]!.models = [{ id: "gpt-6.1-sol", efforts: ["high"] }];
    broken.report!.programs[0]!.problem = "probe failed";
    expect(machineChoices([broken])[0]!.engines[0]!.models).toEqual([]);
  });
});

describe("resolving a chain's start", () => {
  it("chooses a fitting machine before ranking free slots and respects an explicit machine", () => {
    const broken = { ...pc, engines: [{ engine: "codex" as const, models: [] }] };
    const base = input({ platform: "any", brainEngine: "codex" });
    expect(resolveStart(base, startingEngineTable, [broken, mini], available)).toMatchObject({ machine: "mini", missing: [] });
    expect(resolveStart({ ...base, owner: { ...noOwnerChoice, machine: "pc" } }, startingEngineTable, [broken, mini], available)).toMatchObject({ machine: "pc", missing: ["model"] });
    expect(resolveStart(base, startingEngineTable, [broken], available)).toMatchObject({ machine: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", missing: ["model"] });
    const wrongEffort = { ...mini, engines: [{ engine: "codex" as const, models: [{ id: "gpt-6.1-sol", efforts: ["medium"] }] }] };
    expect(resolveStart(base, startingEngineTable, [wrongEffort], available)).toMatchObject({ machine: null, missing: ["effort"] });
  });

  it("offers a complex macOS chain on the Mac with the complex row of the brain's engine", () => {
    const choice = resolveStart(input(), startingEngineTable, [pc, mini], available);
    expect(choice).toEqual({
      machine: "mini",
      engine: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      by: { machine: "default", engine: "default", model: "default", effort: "default" },
      missing: [],
    });
    expect(isComplete(choice)).toBe(true);
  });

  it("lets the owner's choice win", () => {
    const owner = { machine: "pc", engine: "codex" as const, model: "gpt-6.1-sol", effort: "medium" };
    const choice = resolveStart(input({ owner }), startingEngineTable, [pc, mini], available);
    expect(choice).toMatchObject({ machine: "pc", engine: "codex", model: "gpt-6.1-sol", effort: "medium", missing: [] });
    expect(choice.by).toEqual({ machine: "owner", engine: "owner", model: "owner", effort: "owner" });
  });

  it("says an effort the machine does not offer for the model is missing, instead of taking a neighbour", () => {
    const owner = { ...noOwnerChoice, model: "gpt-6.1-sol", effort: "max" };
    const choice = resolveStart(input({ brainEngine: "codex", platform: "windows", owner }), startingEngineTable, [pc], available);
    expect(choice).toMatchObject({ model: "gpt-6.1-sol", effort: "max", missing: ["effort"] });
    expect(isComplete(choice)).toBe(false);
    expect(ownerGivesUnoffered(owner, choice, [pc])).toBe(true);
  });

  it("says a model the machine does not offer is missing", () => {
    const owner = { ...noOwnerChoice, model: "gpt-99", effort: "high" };
    const choice = resolveStart(input({ brainEngine: "codex", platform: "windows", owner }), startingEngineTable, [pc], available);
    expect(choice).toMatchObject({ model: "gpt-99", effort: "high", missing: ["model"] });
  });

  it("says what is missing when nothing is stated, no runner fits, or the engine is nowhere", () => {
    expect(resolveStart(input({ stated: false, brainEngine: null, difficulty: null, platform: null }), startingEngineTable, [pc, mini], available).missing).toEqual(["defaults"]);
    expect(resolveStart(input({ platform: "macos" }), startingEngineTable, [pc], available).missing).toEqual(["machine"]);
    expect(resolveStart(input({ platform: "macos" }), startingEngineTable, [pc, mini], { codex: "exhausted", claude: "exhausted" })).toMatchObject({ engine: "dsh", machine: null, missing: ["engine"] });
    expect(resolveStart(input({ owner: { ...noOwnerChoice, machine: "gone" } }), startingEngineTable, [pc, mini], available).missing).toEqual(["machine"]);
    expect(resolveStart(input({ owner: { ...noOwnerChoice, machine: "mini", engine: "dsh" } }), startingEngineTable, [pc, mini], available).missing).toEqual(["engine"]);
  });

  it("uses dsh's row when both subscriptions are used up", () => {
    const choice = resolveStart(input({ platform: "windows" }), startingEngineTable, [pc], { codex: "exhausted", claude: "exhausted" });
    expect(choice).toMatchObject({ machine: "pc", engine: "dsh", model: "deepseek-flash", effort: "max", missing: [] });
  });

  it("does not refuse a default the owner did not give, and refuses what the owner gives that is not offered", () => {
    const engineOnly = { ...noOwnerChoice, engine: "dsh" as const };
    const choice = resolveStart(input({ platform: "windows" }), startingEngineTable, [pc], available);
    expect(ownerGivesUnoffered(noOwnerChoice, choice, [pc])).toBe(false);
    expect(ownerGivesUnoffered(engineOnly, resolveStart(input({ platform: "windows", owner: engineOnly }), startingEngineTable, [pc], available), [pc])).toBe(false);
    expect(ownerGivesUnoffered({ ...noOwnerChoice, machine: "elsewhere" }, choice, [pc])).toBe(true);
    expect(ownerGivesUnoffered({ ...noOwnerChoice, engine: "antigravity" }, choice, [pc])).toBe(true);
  });

  it("checks what a machine offers by model and effort together", () => {
    expect(offers(pc, "codex", "gpt-6.1-sol", "high")).toBe(true);
    expect(offers(pc, "codex", "gpt-6.1-sol", "max")).toBe(false);
    expect(offers(pc, "antigravity", "gemini-3.8-flash", "high")).toBe(false);
    expect(offers(undefined, "codex", "gpt-6.1-sol", "high")).toBe(false);
  });
});

describe("a change on the card", () => {
  it("keeps what it does not name and clears what it names as null", () => {
    const owner = { machine: "pc", engine: "codex" as const, model: "m", effort: "e" };
    expect(applyChange(owner, { engine: "claude", model: null, effort: null })).toEqual({ machine: "pc", engine: "claude", model: null, effort: null });
    expect(applyChange(noOwnerChoice, { machine: "mini" })).toEqual({ ...noOwnerChoice, machine: "mini" });
  });
});

describe("a ticket that must run on one machine", () => {
  it("defaults to that machine whatever the platform says, and lists no other", () => {
    const choice = resolveStart(input({ kind: "operation", platform: "any", requiredMachine: "mini" }), startingEngineTable, [pc, mini], available);
    expect(choice.machine).toBe("mini");
    expect(choice.missing).toEqual([]);
    expect(machinesFor("any", [pc, mini], "mini").map((machine) => machine.name)).toEqual(["mini"]);
  });

  it("is missing its machine while that machine is away, rather than taking another", () => {
    const choice = resolveStart(input({ kind: "operation", platform: "any", requiredMachine: "mini" }), startingEngineTable, [pc], available);
    expect(choice.machine).toBe("mini");
    expect(choice.missing).toEqual(["machine"]);
  });

  it("refuses the owner's choice of another machine instead of running there", () => {
    const owner = { ...noOwnerChoice, machine: "pc" };
    const choice = resolveStart(input({ kind: "operation", platform: "any", requiredMachine: "mini", owner }), startingEngineTable, [pc, mini], available);
    expect(choice.missing).toContain("machine");
    expect(ownerGivesUnoffered(owner, choice, [pc, mini], "mini")).toBe(true);
    expect(ownerGivesUnoffered({ ...noOwnerChoice, machine: "mini" }, choice, [pc, mini], "mini")).toBe(false);
  });

  it("gives an operation a code engine by difficulty, and prose Antigravity", () => {
    expect(defaultEngine("operation", "codex", available)).toBe("codex");
    expect(defaultEngine("writing", "codex", available)).toBe("antigravity");
  });
});
