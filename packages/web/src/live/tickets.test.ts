import { describe, expect, it } from "vitest";
import { ticket } from "./fixtures.js";
import { pageReducer, initialPage } from "./page.js";
import { initialTickets, receiveTicket, receiveTickets, reviewCount, toReview } from "./tickets.js";

const ids = (state: { readonly open: readonly { readonly id: number }[] }) => state.open.map((entry) => entry.id);

describe("the open tickets", () => {
  it("are unknown until the hub has sent them", () => {
    expect(initialTickets.known).toBe(false);
    expect(receiveTickets([]).known).toBe(true);
  });

  it("are kept newest first, without finished ones", () => {
    const state = receiveTickets([ticket(1), ticket(3), ticket(2, { state: "stopped" }), ticket(4, { state: "working" })]);
    expect(ids(state)).toEqual([4, 3, 1]);
  });

  it("take in a new ticket and a change of state", () => {
    let state = receiveTickets([ticket(1)]);
    state = receiveTicket(state, ticket(2));
    expect(ids(state)).toEqual([2, 1]);
    state = receiveTicket(state, ticket(1, { state: "working", updatedAt: 5000 }));
    expect(state.open.find((entry) => entry.id === 1)?.state).toBe("working");
  });

  it("drop a ticket that finishes", () => {
    const state = receiveTicket(receiveTickets([ticket(1), ticket(2)]), ticket(1, { state: "stopped", updatedAt: 9000 }));
    expect(ids(state)).toEqual([2]);
  });

  it("ignore an older copy of a ticket, and a finished ticket they never held", () => {
    const state = receiveTickets([ticket(1, { state: "working", updatedAt: 5000 })]);
    expect(receiveTicket(state, ticket(1, { updatedAt: 1000 }))).toBe(state);
    expect(receiveTicket(state, ticket(7, { state: "merged" }))).toBe(state);
  });

  it("reach the page state from the socket", () => {
    const snapshot = pageReducer(initialPage, { type: "server", message: { type: "tickets", tickets: [ticket(1)], reviews: [] } });
    expect(ids(snapshot.tickets)).toEqual([1]);
    const changed = pageReducer(snapshot, { type: "server", message: { type: "ticket", ticket: ticket(2) } });
    expect(ids(changed.tickets)).toEqual([2, 1]);
    expect(pageReducer(changed, { type: "server", message: { type: "ticket", ticket: ticket(9, { state: "stopped" }) } })).toBe(changed);
  });
});

describe("the decisions to review", () => {
  const decision = (id: number, verdict: "ok" | "opinion" | null = null) => ({
    id,
    source: "worker" as const,
    attempt: 1,
    pullRequest: null,
    chosen: { en: "c", zh: "选了" },
    why: { en: "w", zh: "因为" },
    otherOptions: { en: "o", zh: "不选" },
    at: 1,
    verdict,
    opinion: verdict === "opinion" ? "不对" : null,
    reviewedAt: verdict === null ? null : 2,
    sentAt: null,
  });

  it("are counted only on finished tickets, from the hub's list and then from each change", () => {
    expect(toReview(ticket(1, { state: "working", decisions: [decision(1)] }))).toBe(0);
    expect(toReview(ticket(1, { state: "merged", endedAt: 9, decisions: [decision(1), decision(2, "ok")] }))).toBe(1);
    let state = receiveTickets([], [{ ticket: 5, count: 2 }]);
    expect(reviewCount(state)).toBe(2);
    state = receiveTicket(state, ticket(6, { state: "merged", endedAt: 9, decisions: [decision(3), decision(4), decision(5)] }));
    expect(reviewCount(state)).toBe(5);
    state = receiveTicket(state, ticket(5, { state: "merged", endedAt: 9, decisions: [decision(1, "ok"), decision(2, "opinion")] }));
    expect(state.reviews).toEqual([{ ticket: 6, count: 3 }]);
    const same = receiveTicket(state, ticket(6, { state: "merged", endedAt: 9, decisions: [decision(3), decision(4), decision(5)] }));
    expect(same).toBe(state);
  });

  it("reach the page state from the socket", () => {
    const state = pageReducer(initialPage, { type: "server", message: { type: "tickets", tickets: [], reviews: [{ ticket: 3, count: 4 }] } });
    expect(reviewCount(state.tickets)).toBe(4);
  });
});
