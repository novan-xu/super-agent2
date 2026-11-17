import { describe, expect, it } from "vitest";
import { holdCard } from "./fixtures.js";
import { canAnswer, initialWaiting, useOf, waitingCount, type WaitingAction, waitingReducer, type WaitingState } from "./waiting.js";

function run(...actions: WaitingAction[]): WaitingState {
  return actions.reduce(waitingReducer, initialWaiting);
}

const one = holdCard("a1", { at: 1000 });
const two = holdCard("b2", { at: 2000 });

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
  it("lets 确认 be pressed only after the card was armed", () => {
    const shown = run({ type: "snapshot", cards: [one] });
    expect(canAnswer(shown, "hold:a1", "release")).toBe(false);
    const armed = waitingReducer(shown, { type: "arm", key: "hold:a1" });
    expect(useOf(armed, "hold:a1").step).toBe("armed");
    expect(canAnswer(armed, "hold:a1", "release")).toBe(true);
    expect(canAnswer(armed, "hold:a1", "refuse")).toBe(true);
  });

  it("lets 拒绝 be pressed without arming", () => {
    expect(canAnswer(run({ type: "snapshot", cards: [one] }), "hold:a1", "refuse")).toBe(true);
  });

  it("lets the owner change their mind", () => {
    const state = run({ type: "snapshot", cards: [one] }, { type: "arm", key: "hold:a1" }, { type: "disarm", key: "hold:a1" });
    expect(useOf(state, "hold:a1").step).toBe("idle");
    expect(canAnswer(state, "hold:a1", "release")).toBe(false);
  });

  it("cannot be pressed twice while the answer is on its way", () => {
    const sending = run({ type: "snapshot", cards: [one] }, { type: "arm", key: "hold:a1" }, { type: "sending", key: "hold:a1", verdict: "release" });
    expect(useOf(sending, "hold:a1")).toEqual({ step: "sending", verdict: "release", failure: null });
    expect(canAnswer(sending, "hold:a1", "release")).toBe(false);
    expect(canAnswer(sending, "hold:a1", "refuse")).toBe(false);
    expect(waitingReducer(sending, { type: "sending", key: "hold:a1", verdict: "refuse" })).toBe(sending);
    expect(waitingReducer(sending, { type: "arm", key: "hold:a1" })).toBe(sending);
  });

  it("does not begin to answer a card that is not there", () => {
    const state = run({ type: "snapshot", cards: [one] });
    expect(canAnswer(state, "hold:zz", "refuse")).toBe(false);
    expect(waitingReducer(state, { type: "sending", key: "hold:zz", verdict: "refuse" })).toBe(state);
    expect(waitingReducer(state, { type: "arm", key: "hold:zz" })).toBe(state);
  });

  it("keeps the state of a card across the hub's lists, so a list arriving mid-answer changes nothing", () => {
    const sending = run({ type: "snapshot", cards: [one, two] }, { type: "arm", key: "hold:a1" }, { type: "sending", key: "hold:a1", verdict: "release" });
    const later = waitingReducer(sending, { type: "snapshot", cards: [one, two] });
    expect(useOf(later, "hold:a1").step).toBe("sending");
    expect(useOf(later, "hold:b2").step).toBe("idle");
  });

  it("starts again from the beginning when what the card holds has changed", () => {
    const armed = run({ type: "snapshot", cards: [one] }, { type: "arm", key: "hold:a1" });
    const changed = holdCard("a1", { at: 1000, fingerprint: "e".repeat(64) });
    const later = waitingReducer(armed, { type: "snapshot", cards: [changed] });
    expect(useOf(later, "hold:a1").step).toBe("idle");
  });

  it("returns to idle with the reason when the hub refuses, so the owner can try again", () => {
    const state = run({ type: "snapshot", cards: [one] }, { type: "arm", key: "hold:a1" }, { type: "sending", key: "hold:a1", verdict: "release" }, { type: "failed", key: "hold:a1", failure: "conflict" });
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
