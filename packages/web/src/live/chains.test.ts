import { describe, expect, it } from "vitest";
import { startedWith, startView } from "./chains.js";
import { holdCard, startCard } from "./fixtures.js";

describe("the start cards' layout", () => {
  it("puts chains with nothing before them under 可以开始, in ticket order", () => {
    const view = startView([startCard(3), holdCard("a1"), startCard(1)]);
    expect(view.now.map((card) => card.ticket.id)).toEqual([1, 3]);
    expect(view.later).toEqual([]);
    expect(view.all).toEqual(["start:1", "start:3"]);
  });

  it("groups the chains that wait under what they wait for", () => {
    const view = startView([
      startCard(1),
      startCard(2, { before: [{ id: 1, zh: "第一" }] }),
      startCard(4, { before: [{ id: 1, zh: "第一" }] }),
      startCard(5, { before: [{ id: 3, zh: "第三" }, { id: 1, zh: "第一" }] }),
    ]);
    expect(view.now.map((card) => card.ticket.id)).toEqual([1]);
    expect(view.later.map((group) => [group.before.map((entry) => entry.title.zh), group.cards.map((card) => card.ticket.id)])).toEqual([
      [["第一"], [2, 4]],
      [["第一", "第三"], [5]],
    ]);
    expect(view.all).toEqual(["start:1", "start:2", "start:4", "start:5"]);
  });

  it("finds the cards a start names, and nothing else", () => {
    expect(startedWith([startCard(1), startCard(2), holdCard("a1")], ["start:2", "hold:a1", "start:9"]).map((card) => card.key)).toEqual(["start:2"]);
  });
});
