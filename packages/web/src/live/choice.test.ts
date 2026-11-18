import type { StartCard } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { canStartCard, changeOfEffort, changeOfEngine, changeOfMachine, changeOfModel, choiceOptions } from "./choice.js";
import { startCard } from "./fixtures.js";

function card(...args: Parameters<typeof startCard>): StartCard {
  const made = startCard(...args);
  if (made.kind !== "start") {
    throw new Error("not a start card");
  }
  return made;
}

describe("the choices on a start card", () => {
  it("lists the machines, the providers of the chosen machine, its models, and the efforts of the chosen model", () => {
    expect(choiceOptions(card(1))).toEqual({
      machines: ["pc", "mini"],
      engines: ["codex", "claude"],
      models: ["gpt-6.1-sol", "gpt-6-luna"],
      efforts: ["medium", "high"],
    });
    expect(choiceOptions(card(1, { choice: { model: "gpt-6-luna", effort: "low" } })).efforts).toEqual(["low", "medium"]);
  });

  it("keeps a current value the machine does not offer, so the card shows what it holds", () => {
    const options = choiceOptions(card(1, { choice: { model: "gpt-6.1-sol", effort: "max", missing: ["effort"] } }));
    expect(options.efforts).toEqual(["max", "medium", "high"]);
    expect(choiceOptions(card(1, { choice: { model: "gpt-9", missing: ["model"] } })).models).toEqual(["gpt-9", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(choiceOptions(card(1, { choice: { machine: "gone" } })).machines).toEqual(["gone", "pc", "mini"]);
  });

  it("keeps the effort when the new model offers it", () => {
    const owned = card(1, { ticket: { ownerChoice: { machine: null, engine: null, model: null, effort: "medium" } }, choice: { effort: "medium" } });
    expect(changeOfModel(owned, "gpt-6-luna")).toEqual({ model: "gpt-6-luna" });
  });

  it("returns the owner's effort to the default when the new model does not offer it", () => {
    const owned = card(1, { ticket: { ownerChoice: { machine: null, engine: null, model: null, effort: "high" } }, choice: { effort: "high" } });
    expect(changeOfModel(owned, "gpt-6-luna")).toEqual({ model: "gpt-6-luna", effort: null });
    expect(changeOfModel(card(1), "gpt-6-luna")).toEqual({ model: "gpt-6-luna" });
  });

  it("changes the effort alone", () => {
    expect(changeOfEffort("medium")).toEqual({ effort: "medium" });
  });

  it("goes back to the table's model and effort when the provider changes", () => {
    expect(changeOfEngine("claude")).toEqual({ engine: "claude", model: null, effort: null });
  });

  it("drops the owner's provider, model and effort when another machine does not have them", () => {
    const owned = card(1, {
      ticket: { ownerChoice: { machine: null, engine: "claude", model: "claude-opus-5-5", effort: "high" } },
      choice: { engine: "claude", model: "claude-opus-5-5", effort: "high" },
    });
    expect(changeOfMachine(owned, "mini")).toEqual({ machine: "mini", engine: null, model: null, effort: null });
    expect(changeOfMachine(owned, "pc")).toEqual({ machine: "pc" });
    expect(changeOfMachine(card(1), "mini")).toEqual({ machine: "mini" });
  });

  it("drops only the owner's effort when another machine has the model but not that effort", () => {
    const owned = card(1, {
      ticket: { ownerChoice: { machine: null, engine: null, model: "gpt-6.1-sol", effort: "medium" } },
      choice: { model: "gpt-6.1-sol", effort: "medium" },
    });
    expect(changeOfMachine(owned, "mini")).toEqual({ machine: "mini", effort: null });
  });

  it("offers 开始 only for a complete choice with nothing pending before it", () => {
    expect(canStartCard(card(1))).toBe(true);
    expect(canStartCard(card(1, { startable: false }))).toBe(false);
    expect(canStartCard(card(1, { choice: { missing: ["defaults"] } }))).toBe(false);
  });
});
