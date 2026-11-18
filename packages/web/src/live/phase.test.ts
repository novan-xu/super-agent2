import { describe, expect, it } from "vitest";
import { ticket, verification, workStatus } from "./fixtures.js";
import { panelOffers, phaseLooks, ticketGroups, ticketPhase, ticketProblem, whereOf } from "./phase.js";

const none = new Map();

describe("what a ticket's row and panel say", () => {
  it("names the state of the worker, not only the ticket's", () => {
    expect(ticketPhase(ticket(1, { state: "working" }))).toBe("starting");
    expect(ticketPhase(ticket(1, { state: "working", beginFailure: "boom" }))).toBe("beginFailed");
    expect(ticketPhase(ticket(1, { state: "working", work: workStatus({ state: "queued" }) }))).toBe("queued");
    expect(ticketPhase(ticket(1, { state: "working", work: workStatus({ state: "preparing" }) }))).toBe("preparing");
    expect(ticketPhase(ticket(1, { state: "working", work: workStatus() }))).toBe("running");
    expect(ticketPhase(ticket(1, { state: "working", work: workStatus({ unreachableSince: 5 }) }))).toBe("unreachable");
    expect(ticketPhase(ticket(1, { state: "working", work: workStatus({ state: "failed" }) }))).toBe("failed");
    expect(ticketPhase(ticket(1, { state: "working", work: workStatus({ state: "stopped" }) }))).toBe("halted");
    expect(ticketPhase(ticket(1, { state: "waiting" }))).toBe("waiting");
    expect(ticketPhase(ticket(1, { state: "verifying", work: workStatus({ state: "finished" }) }))).toBe("verifying");
  });

  it("says a ticket waits for a provider when its program was unavailable and nothing could take over", () => {
    const waiting = ticket(1, { state: "working", work: workStatus({ state: "unavailable", reason: "You've hit your limit" }) });
    expect(ticketPhase(waiting)).toBe("providerWaiting");
    expect(phaseLooks.providerWaiting).toEqual({ tone: "warn", live: false });
    expect(ticketProblem(waiting, none)).toEqual({ kind: "providerWaiting", reason: "You've hit your limit" });
    expect(panelOffers(waiting)).toEqual({ stop: true, reassign: true, reply: true });
  });

  it("shows motion only for a worker that is running and reachable", () => {
    const moving = Object.entries(phaseLooks)
      .filter(([, look]) => look.live)
      .map(([phase]) => phase);
    expect(moving).toEqual(["preparing", "running"]);
    expect(phaseLooks.failed.tone).toBe("bad");
    expect(phaseLooks.beginFailed.tone).toBe("bad");
    expect(phaseLooks.unreachable.tone).toBe("warn");
  });

  it("gives what the hub recorded for a problem", () => {
    expect(ticketProblem(ticket(1, { state: "working", beginFailure: "no task" }), none)).toEqual({ kind: "beginFailed", reason: "no task" });
    expect(ticketProblem(ticket(1, { state: "working", work: workStatus({ state: "failed", failure: "lost", reason: "gone" }) }), none)).toEqual({
      kind: "failed",
      failure: "lost",
      reason: "gone",
    });
    expect(ticketProblem(ticket(1, { state: "working", work: workStatus({ unreachableSince: 7, machine: "mini" }) }), none)).toEqual({ kind: "unreachable", machine: "mini", since: 7 });
    expect(ticketProblem(ticket(1, { state: "working", work: workStatus({ state: "queued", machine: "pc" }) }), none)).toEqual({ kind: "queued", machine: "pc" });
    expect(ticketProblem(ticket(1, { state: "stopped", stopReason: { en: "x", zh: "你停止了它" } }), none)).toEqual({ kind: "stopped", reason: "你停止了它" });
    expect(ticketProblem(ticket(1, { state: "working", work: workStatus() }), none)).toBeNull();
  });

  it("says what verification waits for, what failed, and a conflict", () => {
    const waiting = ticket(1, { state: "verifying", verification: verification({ reason: "Woodpecker has no pipeline for the head abcdef1 yet" }) });
    expect(ticketPhase(waiting)).toBe("verifying");
    expect(ticketProblem(waiting, none)).toEqual({ kind: "verifyWaiting", wait: "pipeline", commit: "abcdef1", reason: "Woodpecker has no pipeline for the head abcdef1 yet" });
    const failed = ticket(1, { state: "verifying", verification: verification({ state: "failed", waiting: null, failures: [{ workflow: "check-windows", step: "check", exitCode: 1 }] }) });
    expect(ticketPhase(failed)).toBe("verifyFailed");
    expect(phaseLooks.verifyFailed.tone).toBe("bad");
    expect(ticketProblem(failed, none)).toEqual({ kind: "verifyFailed", failures: [{ workflow: "check-windows", step: "check", exitCode: 1 }], reason: null });
    const conflicted = ticket(1, { state: "verifying", verification: verification({ state: "conflict", waiting: null, reason: "still conflicts" }) });
    expect(ticketPhase(conflicted)).toBe("conflicted");
    expect(ticketProblem(conflicted, none)).toEqual({ kind: "conflicted", reason: "still conflicts" });
    expect(ticketProblem(ticket(1, { state: "verifying", verification: verification({ state: "checking", waiting: null }) }), none)).toBeNull();
  });

  it("lists what a waiting ticket still waits for, by title when it is known", () => {
    const first = ticket(1, { state: "working", title: { en: "A", zh: "甲" } });
    const waiting = ticket(3, {
      state: "waiting",
      waits: [
        { ticket: 1, deployment: false, waived: false },
        { ticket: 2, deployment: false, waived: false },
        { ticket: 4, deployment: false, waived: true },
      ],
    });
    expect(ticketProblem(waiting, new Map([[1, first]]))).toEqual({
      kind: "waits",
      before: [
        { id: 1, title: "甲", state: "working" },
        { id: 2, title: null, state: null },
      ],
    });
  });

  it("offers 停止 and 改派 on an open ticket, and the reply box only while a reachable worker runs", () => {
    expect(panelOffers(ticket(1, { state: "working", work: workStatus() }))).toEqual({ stop: true, reassign: true, reply: true });
    expect(panelOffers(ticket(1, { state: "working", work: workStatus({ unreachableSince: 3 }) }))).toEqual({ stop: true, reassign: true, reply: false });
    expect(panelOffers(ticket(1, { state: "working", work: workStatus({ state: "failed" }) }))).toEqual({ stop: true, reassign: true, reply: false });
    expect(panelOffers(ticket(1, { state: "waiting" }))).toEqual({ stop: true, reassign: true, reply: false });
    for (const state of ["pending", "merged", "delivered", "stopped"] as const) {
      expect(panelOffers(ticket(1, { state, work: workStatus() }))).toEqual({ stop: false, reassign: false, reply: false });
    }
  });

  it("groups open tickets by repository in name order, writing last, and leaves pending ones to their cards", () => {
    const groups = ticketGroups([
      ticket(1, { state: "working", repository: "novan-xu/b" }),
      ticket(2, { state: "working", kind: "writing", repository: null, issues: [] }),
      ticket(3, { state: "working", repository: "novan-xu/a" }),
      ticket(4, { state: "pending", repository: "novan-xu/c" }),
      ticket(5, { state: "waiting", repository: "novan-xu/b" }),
    ]);
    expect(groups.map((group) => [group.repository, group.tickets.map((entry) => entry.id)])).toEqual([
      ["novan-xu/a", [3]],
      ["novan-xu/b", [1, 5]],
      [null, [2]],
    ]);
  });

  it("says where the work runs, from the worker when there is one", () => {
    expect(whereOf(ticket(1, { state: "working", machine: "pc", engine: "codex", work: workStatus({ machine: "mini", engine: "claude" }) }))).toEqual({ machine: "mini", engine: "claude" });
    expect(whereOf(ticket(1, { state: "waiting", machine: "pc", engine: "codex" }))).toEqual({ machine: "pc", engine: "codex" });
    expect(whereOf(ticket(1, { state: "waiting" }))).toBeNull();
  });
});
