import type { TicketMove, TicketRound } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { moveLabel, needsMoves, openDetail, receiveDetail, timeline } from "./detail.js";
import { stuckCard, stuckTicket, ticket, workStatus } from "./fixtures.js";
import { panelOffers, phaseLooks, ticketPhase, ticketProblem } from "./phase.js";
import { canAnswer, initialWaiting, waitingReducer } from "./waiting.js";

function move(seq: number, from: TicketMove["from"], to: TicketMove["to"], at: number): TicketMove {
  return { ticket: 1, seq, from, to, reason: null, at };
}

const round: TicketRound = {
  seq: 1,
  round: 1,
  attempt: 2,
  failure: { kind: "workflow", detail: "Pipeline #9 failed" },
  guidance: { en: "Return hello", zh: "让 greet 返回 hello" },
  at: 30,
};

describe("a ticket stopped for the owner", () => {
  it("reads as waiting for the owner, with where it is stuck", () => {
    expect(ticketPhase(stuckTicket(1))).toBe("stuck");
    expect(phaseLooks.stuck).toEqual({ tone: "warn", live: false });
    expect(ticketProblem(stuckTicket(1), new Map())).toEqual({ kind: "stuck", round: 3, failure: "workflow", where: null, detail: "Pipeline #9 on abc1234 failed: workflow check, step test (exit code 1)" });
    expect(ticketProblem(stuckTicket(1, { where: { en: "Stuck on the test", zh: "卡在测试上" } }), new Map())).toMatchObject({ where: "卡在测试上" });
  });

  it("offers no stop, reassignment or reply in its panel, since its card is where the owner answers", () => {
    expect(panelOffers(stuckTicket(1))).toEqual({ stop: false, reassign: false, reply: false });
  });

  it("is answered from its card: resuming at once, giving up only after a second press", () => {
    const shown = waitingReducer(initialWaiting, { type: "snapshot", cards: [stuckCard(1)] });
    const key = "stuck:1-40000";
    expect(canAnswer(shown, key, "resume")).toBe(true);
    expect(canAnswer(shown, key, "give-up")).toBe(false);
    const armed = waitingReducer(shown, { type: "arm", key });
    expect(canAnswer(armed, key, "give-up")).toBe(true);
    const again = waitingReducer(armed, { type: "snapshot", cards: [stuckCard(1, { where: { en: "Stuck", zh: "卡住了" } })] });
    expect(canAnswer(again, key, "give-up")).toBe(true);
  });
});

describe("rounds in the timeline", () => {
  it("puts the brain's guidance on the attempt its round started", () => {
    const state = receiveDetail(openDetail(1), {
      ticket: ticket(1, { state: "working", round: 1, createdAt: 1 }),
      moves: [move(1, null, "pending", 1), move(2, "pending", "working", 5)],
      attempts: [workStatus({ attempt: 1, createdAt: 6, state: "failed" }), workStatus({ attempt: 2, createdAt: 30 })],
      rounds: [round],
      switches: [],
    });
    const attempts = timeline(state).flatMap((entry) => (entry.kind === "attempt" ? [[entry.number, entry.round?.guidance.zh ?? null]] : []));
    expect(attempts).toEqual([
      [1, null],
      [2, "让 greet 返回 hello"],
    ]);
  });

  it("names the stop for the owner and the owner's resumption", () => {
    expect(moveLabel(move(3, "verifying", "stuck", 9))).toBe("stuck");
    expect(moveLabel(move(4, "stuck", "verifying", 10))).toBe("resumed");
    expect(moveLabel(move(4, "stuck", "working", 10))).toBe("resumed");
    expect(moveLabel(move(4, "stuck", "stopped", 10))).toBe("stopped");
  });

  it("reads the detail again when a round starts without a change of state", () => {
    const state = receiveDetail(openDetail(1), {
      ticket: ticket(1, { state: "working", round: 0 }),
      moves: [move(1, null, "pending", 1), move(2, "pending", "working", 2)],
      attempts: [],
      rounds: [],
      switches: [],
    });
    expect(needsMoves(state, ticket(1, { state: "working", round: 0 }))).toBe(false);
    expect(needsMoves(state, ticket(1, { state: "working", round: 1 }))).toBe(true);
    expect(needsMoves(state, ticket(1, { state: "working", round: 0, freeRetry: true }))).toBe(true);
  });
});
