import type { StartCard } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { canStartCard, changeOfEngine, changeOfMachine, changeOfModel, choiceOptions, modelValue, parseModelValue } from "./choice.js";
import { startCard } from "./fixtures.js";

function card(...args: Parameters<typeof startCard>): StartCard {
  const made = startCard(...args);
  if (made.kind !== "start") {
    throw new Error("not a start card");
  }
  return made;
}

describe("the choices on a start card", () => {
  it("lists the machines, the engines of the chosen machine, and each model with each of its efforts", () => {
    expect(choiceOptions(card(1))).toEqual({
      machines: ["pc", "mini"],
      engines: ["codex", "claude"],
      models: [
        { value: "gpt-6.1-sol medium", model: "gpt-6.1-sol", effort: "medium" },
        { value: "gpt-6.1-sol high", model: "gpt-6.1-sol", effort: "high" },
        { value: "gpt-6-luna low", model: "gpt-6-luna", effort: "low" },
        { value: "gpt-6-luna medium", model: "gpt-6-luna", effort: "medium" },
      ],
    });
  });

  it("keeps a current value the machine does not offer, so the card shows what it holds", () => {
    const options = choiceOptions(card(1, { choice: { model: "gpt-6.1-sol", effort: "max", missing: ["model"] } }));
    expect(options.models[0]).toEqual({ value: "gpt-6.1-sol max", model: "gpt-6.1-sol", effort: "max" });
    expect(choiceOptions(card(1, { choice: { machine: "gone" } })).machines).toEqual(["gone", "pc", "mini"]);
  });

  it("reads a model option back as a model and effort", () => {
    expect(parseModelValue(modelValue("claude-opus-5-5", "max"))).toEqual({ model: "claude-opus-5-5", effort: "max" });
    expect(parseModelValue("")).toBeUndefined();
    expect(changeOfModel("gpt-6.1-sol high")).toEqual({ model: "gpt-6.1-sol", effort: "high" });
  });

  it("goes back to the table's model when the engine changes", () => {
    expect(changeOfEngine("claude")).toEqual({ engine: "claude", model: null, effort: null });
  });

  it("drops the owner's engine and model when another machine does not have them", () => {
    const owned = card(1, {
      ticket: { ownerChoice: { machine: null, engine: "claude", model: "claude-opus-5-5", effort: "high" } },
      choice: { engine: "claude", model: "claude-opus-5-5", effort: "high" },
    });
    expect(changeOfMachine(owned, "mini")).toEqual({ machine: "mini", engine: null, model: null, effort: null });
    expect(changeOfMachine(owned, "pc")).toEqual({ machine: "pc" });
    expect(changeOfMachine(card(1), "mini")).toEqual({ machine: "mini" });
  });

  it("offers 开始 only for a complete choice with nothing pending before it", () => {
    expect(canStartCard(card(1))).toBe(true);
    expect(canStartCard(card(1, { startable: false }))).toBe(false);
    expect(canStartCard(card(1, { choice: { missing: ["defaults"] } }))).toBe(false);
  });
});
