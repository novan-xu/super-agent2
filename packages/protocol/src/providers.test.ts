import { describe, expect, it } from "vitest";
import type { Subscription } from "./allowance.js";
import { defaultEngine, type MachineChoice, resolveStart, startingEngineTable } from "./defaults.js";
import {
  activeMarks,
  engineOrder,
  type ProviderMark,
  type ProviderOut,
  providerHoldOff,
  providersOut,
  routeProvider,
  type RouteInput,
} from "./providers.js";
import type { ProgramId } from "./runner.js";
import { noOwnerChoice } from "./tickets.js";
import { WorkEvent } from "./work.js";

const now = 1_000_000;

function subscription(program: "codex" | "claude", state: Subscription["state"], extra: Partial<Subscription> = {}): Subscription {
  return { program, state, remainingPercent: state === "available" ? 50 : null, resetsAt: null, readAt: now - 1_000, machine: "pc", ...extra };
}

const unknown = (program: "codex" | "claude"): Subscription => ({ program, state: "unknown", remainingPercent: null, resetsAt: null, readAt: null, machine: null });

const claudeMark: ProviderMark = { program: "claude", reason: "usage limit", since: now - 5_000, until: now + 60_000 };

describe("a provider mark", () => {
  it("is active until the time the program gave", () => {
    expect(activeMarks([claudeMark], { claude: unknown("claude") }, now)).toEqual([
      { program: "claude", reason: "usage limit", since: now - 5_000, until: now + 60_000, given: true },
    ]);
    expect(activeMarks([claudeMark], { claude: unknown("claude") }, now + 60_000)).toEqual([]);
  });

  it("holds a mark with no time for a short while, then lets the program be tried again", () => {
    const mark: ProviderMark = { program: "dsh", reason: "not signed in", since: now, until: null };
    expect(activeMarks([mark], {}, now + providerHoldOff - 1)).toEqual([{ program: "dsh", reason: "not signed in", since: now, until: now + providerHoldOff, given: false }]);
    expect(activeMarks([mark], {}, now + providerHoldOff)).toEqual([]);
  });

  it("clears when a reading taken after it shows the subscription available, and not before", () => {
    expect(activeMarks([claudeMark], { claude: subscription("claude", "available", { readAt: now - 10_000 }) }, now)).toHaveLength(1);
    expect(activeMarks([claudeMark], { claude: subscription("claude", "available", { readAt: now - 1_000 }) }, now)).toEqual([]);
    expect(activeMarks([claudeMark], { claude: subscription("claude", "exhausted", { readAt: now - 1_000 }) }, now)).toHaveLength(1);
  });

  it("is never made by an unknown reading", () => {
    expect(providersOut([], { codex: unknown("codex"), claude: unknown("claude") }, now).size).toBe(0);
  });
});

describe("the providers that are out", () => {
  it("counts a used-up subscription and a mark, and an unknown reading as neither", () => {
    const out = providersOut(activeMarks([claudeMark], {}, now), { codex: subscription("codex", "exhausted", { resetsAt: now + 5_000 }), claude: unknown("claude") }, now);
    expect([...out.keys()].sort()).toEqual(["claude", "codex"]);
    expect(out.get("codex")).toEqual({ reason: "The subscription is used up", until: now + 5_000, given: true });
    expect(out.get("claude")).toEqual({ reason: "usage limit", until: now + 60_000, given: true });
  });

  it("takes the later time when a mark and a used-up reading both speak", () => {
    const out = providersOut(activeMarks([claudeMark], {}, now), { claude: subscription("claude", "exhausted", { resetsAt: now + 90_000 }) }, now);
    expect(out.get("claude")).toMatchObject({ reason: "usage limit", until: now + 90_000, given: true });
  });
});

describe("the order of providers", () => {
  it("follows the owner's order and puts DeepSeek last", () => {
    expect(engineOrder(["gpt", "claude", "deepseek"], false)).toEqual(["codex", "claude", "dsh"]);
    expect(engineOrder(["claude", "gpt", "deepseek"], false)).toEqual(["claude", "codex", "dsh"]);
    expect(engineOrder(undefined, false)).toEqual(["claude", "codex", "dsh"]);
  });

  it("puts Antigravity first for prose and leaves the code providers in the owner's order", () => {
    expect(engineOrder(["gpt", "claude", "deepseek"], true)).toEqual(["antigravity", "codex", "claude", "dsh"]);
  });
});

const pc: MachineChoice = {
  name: "pc",
  platform: "win32",
  free: 1,
  engines: [
    { engine: "claude", models: [{ id: "claude-opus-5-5", efforts: ["high"] }] },
    { engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high"] }] },
    { engine: "dsh", models: [{ id: "deepseek-flash", efforts: ["max"] }] },
  ],
};

const mini: MachineChoice = {
  name: "mini",
  platform: "darwin",
  free: 2,
  engines: [
    { engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high"] }] },
    { engine: "dsh", models: [{ id: "deepseek-flash", efforts: ["max"] }] },
  ],
};

function route(overrides: Partial<RouteInput> = {}, out: Readonly<Partial<Record<ProgramId, ProviderOut>>> = {}): ReturnType<typeof routeProvider> {
  return routeProvider({
    difficulty: "complex",
    platform: "any",
    requiredMachine: null,
    machine: "pc",
    canMove: true,
    order: ["claude", "codex", "dsh"],
    table: startingEngineTable,
    machines: [pc, mini],
    out: new Map(Object.entries(out) as [ProgramId, ProviderOut][]),
    ...overrides,
  });
}

const gone = (until: number | null): ProviderOut => ({ reason: "out", until, given: until !== null });

describe("routing away from a provider that is out", () => {
  it("takes the first provider in the order that is not out, on the same machine, with the table's model and effort", () => {
    expect(route({}, { claude: gone(now + 1) })).toEqual({ kind: "run", machine: "pc", engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  });

  it("falls to dsh only when both Claude and Codex are out", () => {
    expect(route({}, { claude: gone(now + 1), codex: gone(now + 2) })).toEqual({ kind: "run", machine: "pc", engine: "dsh", model: "deepseek-flash", effort: "max" });
  });

  it("goes to another machine that fits when this one lacks the program and the work can move", () => {
    const only: MachineChoice = { ...pc, engines: pc.engines.filter((offer) => offer.engine === "claude") };
    expect(route({ machines: [only, mini] }, { claude: gone(null) })).toEqual({ kind: "run", machine: "mini", engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  });

  it("stays on its machine when the work cannot move, and takes the next provider the machine has", () => {
    const only: MachineChoice = { ...pc, engines: pc.engines.filter((offer) => offer.engine !== "codex") };
    expect(route({ machines: [only, mini], canMove: false }, { claude: gone(null) })).toEqual({ kind: "run", machine: "pc", engine: "dsh", model: "deepseek-flash", effort: "max" });
  });

  it("respects the platform and a required machine", () => {
    expect(route({ platform: "macos" }, { claude: gone(null) })).toEqual({ kind: "run", machine: "mini", engine: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(route({ requiredMachine: "pc", machine: "pc" }, { claude: gone(null) })).toMatchObject({ kind: "run", machine: "pc", engine: "codex" });
  });

  it("waits, naming the earliest time, when every provider that could run it is out", () => {
    expect(route({}, { claude: gone(now + 500), codex: gone(now + 100), dsh: gone(now + 900) })).toEqual({ kind: "wait", engines: ["claude", "codex", "dsh"], until: now + 100 });
    expect(route({}, { claude: gone(null), codex: gone(null), dsh: gone(null) })).toEqual({ kind: "wait", engines: ["claude", "codex", "dsh"], until: null });
  });

  it("does not count a provider no machine offers, and waits when only the unavailable ones are offered", () => {
    const only: MachineChoice = { ...pc, engines: pc.engines.filter((offer) => offer.engine === "claude") };
    expect(route({ machines: [only], canMove: false }, { claude: gone(now + 7) })).toEqual({ kind: "wait", engines: ["claude"], until: now + 7 });
  });

  it("is none when no provider is offered with the table's model and effort", () => {
    expect(route({ machines: [{ ...pc, engines: [] }] })).toEqual({ kind: "none" });
    expect(route({ difficulty: null })).toEqual({ kind: "none" });
  });

  it("never hands a ticket back to a provider that is still out, so two flapping providers cannot hand it to each other", () => {
    const first = route({}, { claude: gone(now + 5) });
    expect(first).toMatchObject({ kind: "run", engine: "codex" });
    const second = route({}, { claude: gone(now + 5), codex: gone(now + 6), dsh: gone(now + 7) });
    expect(second.kind).toBe("wait");
  });

  it("starts prose with Antigravity and falls to the code providers in the owner's order", () => {
    const withAntigravity: MachineChoice = { ...pc, engines: [...pc.engines, { engine: "antigravity", models: [{ id: "gemini-3.8-flash", efforts: ["high"] }] }] };
    const prose = engineOrder(["gpt", "claude", "deepseek"], true);
    expect(route({ machines: [withAntigravity], order: prose }, { antigravity: gone(null) })).toEqual({ kind: "run", machine: "pc", engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  });
});

describe("the default engine with providers that are out", () => {
  const states = { codex: "available", claude: "available" } as const;
  const context = (out: readonly ProgramId[]) => ({ out: new Set<ProgramId>(out), order: ["claude", "codex", "dsh"] as readonly ProgramId[] });

  it("sends prose to the first code provider that is free when Antigravity is out", () => {
    expect(defaultEngine("writing", null, states, context(["antigravity"]))).toBe("claude");
    expect(defaultEngine("writing", null, { codex: "available", claude: "exhausted" }, context(["antigravity"]))).toBe("codex");
    expect(defaultEngine("writing", null, states, context([]))).toBe("antigravity");
  });

  it("stays with Antigravity when nothing else is free", () => {
    expect(defaultEngine("writing", null, { codex: "exhausted", claude: "exhausted" }, context(["antigravity", "dsh"]))).toBe("antigravity");
  });

  it("resolves a start the same way as before when nothing is marked", () => {
    const input = { kind: "feature", difficulty: "standard", platform: "any", brainEngine: "claude", stated: true, owner: noOwnerChoice } as const;
    const plain = resolveStart(input, startingEngineTable, [pc], states);
    const marked = resolveStart(input, startingEngineTable, [pc], { codex: "available", claude: "exhausted" });
    expect(plain.engine).toBe("claude");
    expect(marked.engine).toBe("codex");
  });
});

describe("the event a worker's program unavailable becomes", () => {
  it("is an ending event that carries the reason, the time and the messages not yet read", () => {
    expect(WorkEvent.parse({ kind: "unavailable", reason: "limit", until: 5 })).toEqual({ kind: "unavailable", reason: "limit", until: 5, unsent: [] });
    expect(WorkEvent.parse({ kind: "unavailable", reason: "limit", until: null, unsent: ["a"] })).toEqual({ kind: "unavailable", reason: "limit", until: null, unsent: ["a"] });
  });
});
