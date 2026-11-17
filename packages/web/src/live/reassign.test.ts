import type { MachineChoice } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { fixtureMachines, ticket } from "./fixtures.js";
import { draftOptions, draftWithEngine, draftWithMachine, draftWithModel, initialDraft, reassignChange, reassignMachines } from "./reassign.js";

const withAntigravity: MachineChoice[] = [
  ...fixtureMachines,
  { name: "studio", platform: "win32", free: 1, engines: [{ engine: "antigravity", models: [{ id: "gemini-3.8-flash", efforts: ["high"] }] }, { engine: "claude", models: [{ id: "claude-haiku-5-5", efforts: ["medium"] }] }] },
];

describe("改派", () => {
  const working = ticket(1, { state: "working", machine: "pc", engine: "codex", model: "gpt-6.1-sol", effort: "high", platform: "any" });

  it("starts from the ticket's current choice", () => {
    expect(initialDraft(working)).toEqual({ machine: "pc", engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  });

  it("offers the machines fitting the platform, and no Antigravity for code", () => {
    expect(reassignMachines({ ...working, platform: "windows" }, withAntigravity).map((machine) => machine.name)).toEqual(["pc", "studio"]);
    const studio = reassignMachines(working, withAntigravity).find((machine) => machine.name === "studio");
    expect(studio?.engines.map((offer) => offer.engine)).toEqual(["claude"]);
    const writing = reassignMachines({ ...working, kind: "writing" }, withAntigravity).find((machine) => machine.name === "studio");
    expect(writing?.engines.map((offer) => offer.engine)).toEqual(["antigravity", "claude"]);
  });

  it("lists the same choices a start card does", () => {
    const options = draftOptions(initialDraft(working), fixtureMachines);
    expect(options.machines).toEqual(["pc", "mini"]);
    expect(options.engines).toEqual(["codex", "claude"]);
    expect(options.models.map((option) => option.value)).toContain("gpt-6-luna low");
  });

  it("keeps the engine and model on a machine that offers them, and drops what it does not", () => {
    expect(draftWithMachine(initialDraft(working), "mini", fixtureMachines)).toEqual({ machine: "mini", engine: "codex", model: "gpt-6.1-sol", effort: "high" });
    const claude = draftWithEngine(initialDraft(working), "claude");
    expect(claude).toEqual({ machine: "pc", engine: "claude", model: null, effort: null });
    expect(draftWithMachine(claude, "mini", fixtureMachines)).toEqual({ machine: "mini", engine: "codex", model: null, effort: null });
  });

  it("sends the machine and engine, and the model only when one is picked, so the default table fills it", () => {
    expect(reassignChange(draftWithEngine(initialDraft(working), "claude"))).toEqual({ machine: "pc", engine: "claude" });
    const picked = draftWithModel(draftWithEngine(initialDraft(working), "claude"), "claude-opus-5-5 max");
    expect(reassignChange(picked)).toEqual({ machine: "pc", engine: "claude", model: "claude-opus-5-5", effort: "max" });
    expect(reassignChange(draftWithModel(picked, ""))).toEqual({ machine: "pc", engine: "claude" });
    expect(reassignChange({ machine: null, engine: null, model: null, effort: null })).toBeUndefined();
  });
});
