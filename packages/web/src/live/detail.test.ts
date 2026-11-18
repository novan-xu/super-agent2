import type { TicketMove, TicketSwitch } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { isWorkLive, moveLabel, needsMoves, openDetail, receiveDetail, receiveDetailWork, receiveMissing, receiveTicketChange, timeline } from "./detail.js";
import { ticket, workEvent, workStatus } from "./fixtures.js";

function move(seq: number, from: TicketMove["from"], to: TicketMove["to"], at: number): TicketMove {
  return { ticket: 1, seq, from, to, reason: null, at };
}

describe("a ticket's detail", () => {
  it("takes the hub's reading of the ticket, and a newer ticket from the socket", () => {
    const read = receiveDetail(openDetail(1), { ticket: ticket(1, { state: "working", updatedAt: 5 }), moves: [move(1, null, "pending", 1)], attempts: [], rounds: [], switches: [] });
    expect(read.ticket?.state).toBe("working");
    const older = receiveTicketChange(read, ticket(1, { state: "pending", updatedAt: 4 }));
    expect(older).toBe(read);
    const newer = receiveTicketChange(read, ticket(1, { state: "working", updatedAt: 6, work: workStatus({ attempt: 2 }) }));
    expect(newer.attempts.map((attempt) => attempt.attempt)).toEqual([2]);
    expect(receiveTicketChange(read, ticket(2, { updatedAt: 9 }))).toBe(read);
  });

  it("says a ticket the hub does not know is missing", () => {
    expect(receiveMissing(openDetail(3)).missing).toBe(true);
  });

  it("reads the moves again when the ticket's state is not the last move", () => {
    const read = receiveDetail(openDetail(1), { ticket: ticket(1, { state: "working" }), moves: [move(1, null, "pending", 1), move(2, "pending", "working", 2)], attempts: [], rounds: [], switches: [] });
    expect(needsMoves(read, ticket(1, { state: "working" }))).toBe(false);
    expect(needsMoves(read, ticket(1, { state: "stopped" }))).toBe(true);
    expect(needsMoves(read, ticket(2, { state: "stopped" }))).toBe(false);
  });

  it("puts the filing, the moves and each attempt in the order they happened", () => {
    const state = receiveDetailWork(
      receiveDetail(openDetail(1), {
        ticket: ticket(1, { state: "stopped", createdAt: 1 }),
        moves: [move(1, null, "pending", 1), move(2, "pending", "working", 5), move(3, "working", "stopped", 50)],
        attempts: [workStatus({ attempt: 1, createdAt: 6, state: "replaced" }), workStatus({ attempt: 2, createdAt: 20, state: "stopped" })],
        rounds: [],
        switches: [],
      }),
      [workEvent(1, { kind: "text", block: "a", delta: "x" }), workEvent(2, { kind: "text", block: "b", delta: "y" }, { attempt: 2, seq: 1 })],
    );
    expect(timeline(state).map((entry) => entry.key)).toEqual(["filed", "move-2", "attempt-1", "attempt-2", "move-3"]);
    const last = timeline(state).find((entry) => entry.key === "attempt-2");
    expect(last?.kind === "attempt" && last.latest && last.log?.items.length === 1).toBe(true);
  });

  it("puts a switch of provider between the attempt that stopped and the one that took over", () => {
    const entry: TicketSwitch = { ticket: 1, seq: 1, kind: "switched", at: 20, from: "claude", to: "codex", machine: "pc", model: "gpt-6.1-sol", effort: "high", reason: "limit", until: null, owner: false, attempt: 2 };
    const state = receiveDetail(openDetail(1), {
      ticket: ticket(1, { state: "working", createdAt: 1 }),
      moves: [move(1, null, "pending", 1), move(2, "pending", "working", 5)],
      attempts: [workStatus({ attempt: 1, createdAt: 6, state: "unavailable", engine: "claude" }), workStatus({ attempt: 2, createdAt: 20, engine: "codex" })],
      rounds: [],
      switches: [entry, { ...entry, seq: 2, kind: "waiting", to: null, at: 30, attempt: 2 }],
    });
    expect(timeline(state).map((item) => item.key)).toEqual(["filed", "move-2", "attempt-1", "switch-1", "attempt-2", "switch-2"]);
  });

  it("reads the detail again when a new attempt appears or the worker's program became unavailable", () => {
    const read = receiveDetail(openDetail(1), { ticket: ticket(1, { state: "working" }), moves: [move(1, null, "pending", 1), move(2, "pending", "working", 2)], attempts: [workStatus({ attempt: 1 })], rounds: [], switches: [] });
    expect(needsMoves(read, ticket(1, { state: "working", work: workStatus({ attempt: 1 }) }))).toBe(false);
    expect(needsMoves(read, ticket(1, { state: "working", work: workStatus({ attempt: 2 }) }))).toBe(true);
    expect(needsMoves(read, ticket(1, { state: "working", work: workStatus({ attempt: 1, state: "unavailable" }) }))).toBe(true);
  });

  it("calls only the latest running, reachable, unended attempt live", () => {
    const base = receiveDetail(openDetail(1), { ticket: ticket(1, { state: "working" }), moves: [], attempts: [workStatus({ attempt: 1, state: "running" })], rounds: [], switches: [] });
    const entry = (state: typeof base) => {
      const found = timeline(state).find((item) => item.kind === "attempt");
      if (found?.kind !== "attempt") {
        throw new Error("no attempt");
      }
      return found;
    };
    expect(isWorkLive(entry(base))).toBe(true);
    expect(isWorkLive(entry({ ...base, attempts: [workStatus({ unreachableSince: 4 })] }))).toBe(false);
    expect(isWorkLive(entry(receiveDetailWork(base, [workEvent(1, { kind: "failed", failure: "program", reason: "x" })])))).toBe(false);
  });

  it("names each move", () => {
    expect(moveLabel(move(2, "pending", "working", 1))).toBe("started");
    expect(moveLabel(move(2, "pending", "waiting", 1))).toBe("queuedBehind");
    expect(moveLabel(move(2, "waiting", "working", 1))).toBe("began");
    expect(moveLabel(move(2, "verifying", "working", 1))).toBe("returned");
    expect(moveLabel(move(2, "working", "verifying", 1))).toBe("verifying");
    expect(moveLabel(move(2, "working", "delivered", 1))).toBe("delivered");
    expect(moveLabel(move(2, "working", "stopped", 1))).toBe("stopped");
  });
});
