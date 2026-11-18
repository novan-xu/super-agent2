import { isInHistory, isOpenTicket, type Ticket, type TicketReviewCount, unsettledDecisions } from "@super-agent2/protocol";

export interface TicketsState {
  readonly known: boolean;
  readonly open: readonly Ticket[];
  readonly reviews: readonly TicketReviewCount[];
}

export const initialTickets: TicketsState = { known: false, open: [], reviews: [] };

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

export function toReview(ticket: Ticket): number {
  return isInHistory(ticket) ? unsettledDecisions(ticket.decisions).length : 0;
}

function withReview(reviews: readonly TicketReviewCount[], ticket: Ticket): readonly TicketReviewCount[] {
  const count = toReview(ticket);
  const before = reviews.find((entry) => entry.ticket === ticket.id);
  if ((before?.count ?? 0) === count) {
    return reviews;
  }
  const rest = reviews.filter((entry) => entry.ticket !== ticket.id);
  return count === 0 ? rest : [...rest, { ticket: ticket.id, count }].sort((a, b) => a.ticket - b.ticket);
}

export function reviewCount(state: TicketsState): number {
  return state.reviews.reduce((sum, entry) => sum + entry.count, 0);
}

export function receiveTickets(tickets: readonly Ticket[], reviews: readonly TicketReviewCount[] = []): TicketsState {
  return { known: true, open: ordered(tickets), reviews };
}

export function receiveTicket(state: TicketsState, ticket: Ticket): TicketsState {
  const reviews = withReview(state.reviews, ticket);
  const before = state.open.find((entry) => entry.id === ticket.id);
  if ((before !== undefined && before.updatedAt > ticket.updatedAt) || (before === undefined && !isOpenTicket(ticket.state))) {
    return reviews === state.reviews ? state : { ...state, reviews };
  }
  return { ...state, reviews, open: ordered([...state.open.filter((entry) => entry.id !== ticket.id), ticket]) };
}
