import { describe, expect, it } from "vitest";
import { holdCard, stuckCard } from "./fixtures.js";
import { canAnswer, initialWaiting, useOf, waitingCount, type WaitingAction, waitingReducer, type WaitingState } from "./waiting.js";

function run(...actions: WaitingAction[]): WaitingState {
  return actions.reduce(waitingReducer, initialWaiting);
}

const one = holdCard("a1", { at: 1000 });
const two = holdCard("b2", { at: 2000 });
const stuck = stuckCard(7);

describe("what waits", () => {
  it("knows nothing until the hub has said what waits", () => {
    expect(initialWaiting.known).toBe(false);
    expect(waitingCount(initialWaiting)).toBe(0);
  });

  it("takes the hub's list as it is, newest first", () => {
    const state = run({ type: "snapshot", cards: [one, two] });
    expect(state.known).toBe(true);
    expect(state.cards.map((card) => card.key)).toEqual(["hold:b2", "hold:a1"]);
  });

  it("counts exactly the cards it shows", () => {
    let state = run({ type: "snapshot", cards: [one, two] });
    expect(waitingCount(state)).toBe(2);
    state = waitingReducer(state, { type: "answered", key: "hold:a1" });
    expect(waitingCount(state)).toBe(state.cards.length);
    expect(waitingCount(state)).toBe(1);
    state = waitingReducer(state, { type: "snapshot", cards: [] });
    expect(waitingCount(state)).toBe(0);
    expect(state.known).toBe(true);
  });

  it("shows a card once even when the list names it twice", () => {
    expect(waitingCount(run({ type: "snapshot", cards: [one, one] }))).toBe(1);
  });

  it("takes a card away when the hub's list no longer has it, as when another device answered", () => {
    const state = run({ type: "snapshot", cards: [one, two] }, { type: "snapshot", cards: [two] });
    expect(state.cards.map((card) => card.key)).toEqual(["hold:b2"]);
  });
});

describe("answering a card", () => {
  it("lets 确认 and 拒绝 of a held command be pressed once", () => {
    const shown = run({ type: "snapshot", cards: [one] });
    expect(canAnswer(shown, "hold:a1")).toBe(true);
    expect(useOf(waitingReducer(shown, { type: "sending", key: "hold:a1", verdict: "release" }), "hold:a1").step).toBe("sending");
  });

  it("lets 继续 and 放弃 of a stuck ticket be pressed once, with nothing to confirm", () => {
    const shown = run({ type: "snapshot", cards: [stuck] });
    expect(canAnswer(shown, stuck.key)).toBe(true);
    const sending = waitingReducer(shown, { type: "sending", key: stuck.key, verdict: "give-up" });
    expect(useOf(sending, stuck.key)).toEqual({ step: "sending", verdict: "give-up", failure: null });
  });

  it("cannot be pressed twice while the answer is on its way", () => {
    const sending = run({ type: "snapshot", cards: [one] }, { type: "sending", key: "hold:a1", verdict: "release" });
    expect(useOf(sending, "hold:a1")).toEqual({ step: "sending", verdict: "release", failure: null });
    expect(canAnswer(sending, "hold:a1")).toBe(false);
    expect(waitingReducer(sending, { type: "sending", key: "hold:a1", verdict: "refuse" })).toBe(sending);
  });

  it("does not begin to answer a card that is not there", () => {
    const state = run({ type: "snapshot", cards: [one] });
    expect(canAnswer(state, "hold:zz")).toBe(false);
    expect(waitingReducer(state, { type: "sending", key: "hold:zz", verdict: "refuse" })).toBe(state);
  });

  it("keeps the state of a card across the hub's lists, so a list arriving mid-answer changes nothing", () => {
    const sending = run({ type: "snapshot", cards: [one, two] }, { type: "sending", key: "hold:a1", verdict: "release" });
    const later = waitingReducer(sending, { type: "snapshot", cards: [one, two] });
    expect(useOf(later, "hold:a1").step).toBe("sending");
    expect(useOf(later, "hold:b2").step).toBe("idle");
  });

  it("starts again from the beginning when what the card holds has changed", () => {
    const failed = run({ type: "snapshot", cards: [one] }, { type: "failed", key: "hold:a1", failure: "conflict" });
    const changed = holdCard("a1", { at: 1000, fingerprint: "e".repeat(64) });
    const later = waitingReducer(failed, { type: "snapshot", cards: [changed] });
    expect(useOf(later, "hold:a1")).toEqual({ step: "idle", verdict: null, failure: null });
  });

  it("returns to idle with the reason when the hub refuses, so the owner can try again", () => {
    const state = run({ type: "snapshot", cards: [one] }, { type: "sending", key: "hold:a1", verdict: "release" }, { type: "failed", key: "hold:a1", failure: "conflict" });
    expect(useOf(state, "hold:a1")).toEqual({ step: "idle", verdict: null, failure: "conflict" });
    expect(waitingCount(state)).toBe(1);
  });

  it("removes the card at once when it was answered, and does not bring it back from an older list", () => {
    const answered = run({ type: "snapshot", cards: [one, two] }, { type: "answered", key: "hold:a1" });
    expect(answered.cards.map((card) => card.key)).toEqual(["hold:b2"]);
    const stale = waitingReducer(answered, { type: "snapshot", cards: [one, two] });
    expect(stale.cards.map((card) => card.key)).toEqual(["hold:b2"]);
    const current = waitingReducer(stale, { type: "snapshot", cards: [two] });
    expect(current.answered.size).toBe(0);
  });

  it("ignores a failure for a card that has already gone", () => {
    const state = run({ type: "snapshot", cards: [two] });
    expect(waitingReducer(state, { type: "failed", key: "hold:a1", failure: "network" })).toBe(state);
  });
});
