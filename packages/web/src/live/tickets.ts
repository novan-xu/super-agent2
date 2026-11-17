import { isOpenTicket, type Ticket, type TicketState } from "@super-agent2/protocol";

export interface TicketsState {
  readonly known: boolean;
  readonly open: readonly Ticket[];
}

export const initialTickets: TicketsState = { known: false, open: [] };

export type TicketTone = "mute" | "ok" | "info";

export const ticketTones: Readonly<Record<TicketState, { readonly tone: TicketTone; readonly live: boolean }>> = {
  pending: { tone: "mute", live: false },
  waiting: { tone: "mute", live: false },
  working: { tone: "ok", live: true },
  verifying: { tone: "info", live: true },
  merged: { tone: "ok", live: false },
  delivered: { tone: "info", live: false },
  stopped: { tone: "mute", live: false },
};

function ordered(tickets: readonly Ticket[]): Ticket[] {
  const byId = new Map<number, Ticket>();
  for (const ticket of tickets) {
    const before = byId.get(ticket.id);
    if (before === undefined || before.updatedAt <= ticket.updatedAt) {
      byId.set(ticket.id, ticket);
    }
  }
  return [...byId.values()].filter((ticket) => isOpenTicket(ticket.state)).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

export function receiveTickets(tickets: readonly Ticket[]): TicketsState {
  return { known: true, open: ordered(tickets) };
}

export function receiveTicket(state: TicketsState, ticket: Ticket): TicketsState {
  const before = state.open.find((entry) => entry.id === ticket.id);
  if (before !== undefined && before.updatedAt > ticket.updatedAt) {
    return state;
  }
  if (before === undefined && !isOpenTicket(ticket.state)) {
    return state;
  }
  return { ...state, open: ordered([...state.open.filter((entry) => entry.id !== ticket.id), ticket]) };
}
