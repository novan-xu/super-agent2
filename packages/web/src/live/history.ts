import { foldedText, isInHistory, newerPosition, normalisedQuery, positionOf, searchTerms, type Ticket, type TicketHistory, ticketProject } from "@super-agent2/protocol";

export type HistoryStatus = "idle" | "loading" | "ready" | "failed";

export type MoreStatus = "idle" | "loading" | "failed";

export interface HistoryState {
  readonly query: string;
  readonly applied: string;
  readonly stale: boolean;
  readonly status: HistoryStatus;
  readonly tickets: readonly Ticket[];
  readonly next: string | null;
  readonly more: MoreStatus;
}

export const initialHistory: HistoryState = { query: "", applied: "", stale: false, status: "idle", tickets: [], next: null, more: "idle" };

const excerptLength = 60;

function ordered(tickets: Iterable<Ticket>): Ticket[] {
  return [...tickets].sort((a, b) => {
    const left = positionOf(a);
    const right = positionOf(b);
    return left === undefined || right === undefined ? b.id - a.id : newerPosition(left, right);
  });
}

function withTicket(tickets: readonly Ticket[], ticket: Ticket): Ticket[] {
  return ordered([...tickets.filter((entry) => entry.id !== ticket.id), ticket]);
}

export function startLoading(state: HistoryState): HistoryState {
  if (state.status === "loading") {
    return state;
  }
  return { ...state, status: "loading", more: "idle" };
}

export function typeQuery(state: HistoryState, query: string): HistoryState {
  if (query === state.query) {
    return state;
  }
  const applied = normalisedQuery(query);
  if (applied === state.applied) {
    return { ...state, query };
  }
  return { ...state, query, applied, stale: true, status: "loading", more: "idle" };
}

function isOlder(state: HistoryState, ticket: Ticket): boolean {
  const last = state.tickets.at(-1);
  const at = positionOf(ticket);
  const end = last === undefined ? undefined : positionOf(last);
  return state.next !== null && at !== undefined && end !== undefined && newerPosition(at, end) > 0;
}

export function receivePage(state: HistoryState, applied: string, page: TicketHistory): HistoryState {
  if (applied !== state.applied) {
    return state;
  }
  if (state.stale || state.tickets.length === 0) {
    return { ...state, stale: false, status: "ready", tickets: page.tickets, next: page.next, more: "idle" };
  }
  const known = new Set(state.tickets.map((ticket) => ticket.id));
  const head = state.tickets[0];
  const first = head === undefined ? undefined : positionOf(head);
  const last = page.tickets.at(-1);
  const end = last === undefined ? undefined : positionOf(last);
  const apart = page.next !== null && !page.tickets.some((ticket) => known.has(ticket.id)) && first !== undefined && end !== undefined && newerPosition(end, first) < 0;
  if (apart) {
    return { ...state, status: "ready", tickets: page.tickets, next: page.next, more: "idle" };
  }
  const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
  for (const ticket of page.tickets) {
    byId.set(ticket.id, ticket);
  }
  return { ...state, status: "ready", tickets: ordered(byId.values()), next: page.next === null ? null : state.next, more: "idle" };
}

export function receiveMore(state: HistoryState, applied: string, before: string, page: TicketHistory): HistoryState {
  if (applied !== state.applied || state.stale || state.next !== before) {
    return state;
  }
  const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
  for (const ticket of page.tickets) {
    if (!byId.has(ticket.id)) {
      byId.set(ticket.id, ticket);
    }
  }
  return { ...state, tickets: ordered(byId.values()), next: page.next, more: "idle" };
}

export function pageFailed(state: HistoryState, applied: string): HistoryState {
  return applied === state.applied && state.status === "loading" ? { ...state, status: "failed" } : state;
}

export function moreStarted(state: HistoryState): HistoryState {
  return state.more === "loading" ? state : { ...state, more: "loading" };
}

export function moreFailed(state: HistoryState, applied: string): HistoryState {
  return applied === state.applied && state.more === "loading" ? { ...state, more: "failed" } : state;
}

export function canLoadMore(state: HistoryState): boolean {
  return state.status === "ready" && !state.stale && state.next !== null && state.more !== "loading";
}

export function receiveEnded(state: HistoryState, ticket: Ticket): HistoryState {
  if (state.status === "idle" || state.stale || !isInHistory(ticket)) {
    return state;
  }
  const before = state.tickets.find((entry) => entry.id === ticket.id);
  if (before !== undefined) {
    return before.updatedAt > ticket.updatedAt ? state : { ...state, tickets: withTicket(state.tickets, ticket) };
  }
  if (state.applied !== "" || isOlder(state, ticket)) {
    return state;
  }
  return { ...state, tickets: withTicket(state.tickets, ticket) };
}

export function needsCatchUp(state: HistoryState, ticket: Ticket): boolean {
  return (
    state.status === "ready" &&
    !state.stale &&
    state.applied !== "" &&
    isInHistory(ticket) &&
    !state.tickets.some((entry) => entry.id === ticket.id) &&
    !isOlder(state, ticket)
  );
}

export type HistoryAppearance = "merged" | "delivered" | "stopped";

export interface HistoryLine {
  readonly how: HistoryAppearance;
  readonly reason: string | null;
}

export function historyLine(ticket: Ticket): HistoryLine {
  if (ticket.state === "merged" || ticket.state === "delivered") {
    return { how: ticket.state, reason: null };
  }
  const reason = ticket.stopReason === null ? "" : ticket.stopReason.zh.trim();
  return { how: "stopped", reason: reason === "" ? null : reason };
}

function excerpt(text: string, at: number, length: number): string {
  const letters = Array.from(text);
  if (letters.length <= excerptLength) {
    return text;
  }
  const start = Array.from(text.slice(0, at)).length;
  const from = Math.max(0, Math.min(start - Math.floor((excerptLength - length) / 2), letters.length - excerptLength));
  const to = Math.min(letters.length, from + excerptLength);
  return `${from > 0 ? "…" : ""}${letters.slice(from, to).join("")}${to < letters.length ? "…" : ""}`;
}

export function matchNote(ticket: Ticket, query: string): string | null {
  const terms = searchTerms(query);
  const shown = [ticket.title.zh, ticketProject(ticket) ?? ""].map(foldedText);
  const term = terms.find((entry) => !shown.some((text) => text.includes(foldedText(entry))));
  if (term === undefined) {
    return null;
  }
  const wanted = foldedText(term);
  const sources = [
    ticket.summary.zh,
    ...ticket.issues.flatMap((issue) => [issue.title.zh, issue.summary.zh]),
    ticket.title.en,
    ticket.summary.en,
    ...ticket.issues.flatMap((issue) => [issue.title.en, issue.summary.en]),
  ];
  for (const source of sources) {
    const at = foldedText(source).indexOf(wanted);
    if (at >= 0) {
      return excerpt(source, at, term.length);
    }
  }
  return null;
}
