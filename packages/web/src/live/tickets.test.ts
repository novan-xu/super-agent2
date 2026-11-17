import { ticketStates } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { ticket } from "./fixtures.js";
import { pageReducer, initialPage } from "./page.js";
import { initialTickets, receiveTicket, receiveTickets, ticketTones } from "./tickets.js";

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

  it("give every state a tone", () => {
    for (const state of ticketStates) {
      expect(ticketTones[state]).toBeDefined();
    }
    expect(ticketTones.working.live).toBe(true);
    expect(ticketTones.pending.live).toBe(false);
  });

  it("reach the page state from the socket", () => {
    const snapshot = pageReducer(initialPage, { type: "server", message: { type: "tickets", tickets: [ticket(1)] } });
    expect(ids(snapshot.tickets)).toEqual([1]);
    const changed = pageReducer(snapshot, { type: "server", message: { type: "ticket", ticket: ticket(2) } });
    expect(ids(changed.tickets)).toEqual([2, 1]);
    expect(pageReducer(changed, { type: "server", message: { type: "ticket", ticket: ticket(9, { state: "stopped" }) } })).toBe(changed);
  });
});
