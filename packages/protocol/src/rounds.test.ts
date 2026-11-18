import { describe, expect, it } from "vitest";
import {
  canMoveTicket,
  capReached,
  countsAsRound,
  guidanceRefusal,
  type LoopTicket,
  loopFailureOf,
  nextRound,
  roundCap,
  StuckAnswerRequest,
  stuckOffers,
} from "./index.js";

function loopTicket(overrides: Partial<LoopTicket> = {}): LoopTicket {
  return {
    state: "working",
    round: 0,
    freeRetry: false,
    work: { state: "failed", failure: "no-pull-request", reason: "No pull request" },
    verification: null,
    stuck: null,
    ...overrides,
  };
}

describe("what counts as a guided round", () => {
  it("counts a round after any failure of the work, and the cap is three", () => {
    expect(roundCap).toBe(3);
    for (const kind of ["workflow", "no-pull-request", "program"] as const) {
      expect(countsAsRound(kind, false)).toBe(true);
      expect(countsAsRound(kind, true)).toBe(true);
    }
  });

  it("does not count one retry after a failure of the machine, and counts the next one in a row", () => {
    expect(countsAsRound("lost", false)).toBe(false);
    expect(countsAsRound("prepare", false)).toBe(false);
    expect(countsAsRound("lost", true)).toBe(true);
    expect(countsAsRound("prepare", true)).toBe(true);
  });

  it("numbers the next round from the count kept on the ticket", () => {
    expect(nextRound(loopTicket({ round: 0 }), { kind: "workflow", detail: "" })).toEqual({ counted: true, round: 1 });
    expect(nextRound(loopTicket({ round: 2 }), { kind: "program", detail: "" })).toEqual({ counted: true, round: 3 });
    expect(nextRound(loopTicket({ round: 2 }), { kind: "lost", detail: "" })).toEqual({ counted: false, round: 2 });
    expect(nextRound(loopTicket({ round: 2, freeRetry: true }), { kind: "lost", detail: "" })).toEqual({ counted: true, round: 3 });
  });
});

describe("when the cap is reached", () => {
  it("is reached by a counted failure after three guided rounds, never before", () => {
    expect(capReached(0, "workflow", false)).toBe(false);
    expect(capReached(2, "workflow", false)).toBe(false);
    expect(capReached(3, "workflow", false)).toBe(true);
    expect(capReached(4, "program", false)).toBe(true);
  });

  it("leaves one retry for a failure of the machine at the cap, and stops at the second in a row", () => {
    expect(capReached(3, "lost", false)).toBe(false);
    expect(capReached(3, "lost", true)).toBe(true);
    expect(capReached(3, "workflow", true)).toBe(true);
  });
});

describe("the failure a round answers", () => {
  it("is the failed worker of a working ticket", () => {
    expect(loopFailureOf(loopTicket())).toEqual({ kind: "no-pull-request", detail: "No pull request" });
    expect(loopFailureOf(loopTicket({ work: { state: "failed", failure: null, reason: null } }))).toEqual({ kind: "program", detail: "" });
    expect(loopFailureOf(loopTicket({ work: { state: "running", failure: null, reason: null } }))).toBeNull();
    expect(loopFailureOf(loopTicket({ work: null }))).toBeNull();
  });

  it("is a red workflow of a verifying ticket, and never a conflict, which goes back to the worker", () => {
    expect(loopFailureOf(loopTicket({ state: "verifying", work: { state: "finished", failure: null, reason: null }, verification: { state: "failed", reason: "red" } }))).toEqual({
      kind: "workflow",
      detail: "red",
    });
    expect(loopFailureOf(loopTicket({ state: "verifying", verification: { state: "conflict", reason: "conflicts" } }))).toBeNull();
    expect(loopFailureOf(loopTicket({ state: "verifying", verification: { state: "waiting", reason: "no pipeline yet" } }))).toBeNull();
  });

  it("is the recorded failure of a stuck ticket, and nothing for a finished one", () => {
    const stuck = { at: 5, round: 3, from: "verifying" as const, failure: { kind: "workflow" as const, detail: "red" }, where: null };
    expect(loopFailureOf(loopTicket({ state: "stuck", stuck }))).toEqual({ kind: "workflow", detail: "red" });
    expect(loopFailureOf(loopTicket({ state: "merged" }))).toBeNull();
  });
});

describe("what a guidance may start", () => {
  it("starts a round for a failed ticket under the cap", () => {
    expect(guidanceRefusal(loopTicket())).toBeNull();
    expect(guidanceRefusal(loopTicket({ round: 2 }))).toBeNull();
  });

  it("refuses a fourth round, a ticket stopped for the owner, a running worker, nothing failed and a closed ticket", () => {
    expect(guidanceRefusal(loopTicket({ round: 3 }))).toBe("cap");
    expect(guidanceRefusal(loopTicket({ round: 7 }))).toBe("cap");
    expect(guidanceRefusal(loopTicket({ state: "stuck", round: 3 }))).toBe("stuck");
    expect(guidanceRefusal(loopTicket({ work: { state: "running", failure: null, reason: null } }))).toBe("running");
    expect(guidanceRefusal(loopTicket({ work: { state: "queued", failure: null, reason: null } }))).toBe("running");
    expect(guidanceRefusal(loopTicket({ work: { state: "finished", failure: null, reason: null } }))).toBe("nothing-failed");
    for (const state of ["pending", "waiting", "merged", "delivered", "stopped"]) {
      expect(guidanceRefusal(loopTicket({ state }))).toBe("closed");
    }
  });

  it("allows the one uncounted retry at the cap after a failure of the machine", () => {
    expect(guidanceRefusal(loopTicket({ round: 3, work: { state: "failed", failure: "lost", reason: "gone" } }))).toBeNull();
    expect(guidanceRefusal(loopTicket({ round: 3, freeRetry: true, work: { state: "failed", failure: "lost", reason: "gone" } }))).toBe("cap");
  });
});

describe("what each state offers", () => {
  it("offers the owner's answers only on a ticket stopped for the owner", () => {
    const stuck = { at: 5, round: 3, from: "working" as const, failure: { kind: "program" as const, detail: "" }, where: null };
    expect(stuckOffers({ state: "stuck", stuck })).toEqual(["resume", "give-up"]);
    expect(stuckOffers({ state: "working", stuck: null })).toEqual([]);
    expect(stuckOffers({ state: "stuck", stuck: null })).toEqual([]);
  });

  it("lets a ticket stop for the owner from working or verifying, and leave only back to where it was or to stopped", () => {
    expect(canMoveTicket("feature", "working", "stuck")).toBe(true);
    expect(canMoveTicket("feature", "verifying", "stuck")).toBe(true);
    expect(canMoveTicket("feature", "stuck", "working")).toBe(true);
    expect(canMoveTicket("feature", "stuck", "verifying")).toBe(true);
    expect(canMoveTicket("feature", "stuck", "stopped")).toBe(true);
    expect(canMoveTicket("feature", "stuck", "merged")).toBe(false);
    expect(canMoveTicket("writing", "stuck", "verifying")).toBe(false);
    expect(canMoveTicket("feature", "pending", "stuck")).toBe(false);
    expect(canMoveTicket("feature", "stopped", "stuck")).toBe(false);
  });

  it("takes an answer with the time of the stop, the answer and optional words", () => {
    expect(StuckAnswerRequest.parse({ at: 5, answer: "resume", words: " try the other library " })).toEqual({ at: 5, answer: "resume", words: "try the other library" });
    expect(StuckAnswerRequest.safeParse({ at: 5, answer: "again" }).success).toBe(false);
    expect(StuckAnswerRequest.safeParse({ answer: "resume" }).success).toBe(false);
  });
});
