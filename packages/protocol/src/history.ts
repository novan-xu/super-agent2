import { z } from "zod";
import { finishedTicketStates, Ticket, ticketProject } from "./tickets.js";

export const historyPageSize = 30;

export const historyLargestPage = 100;

export const historyQueryLength = 200;

export const historyTermLimit = 8;

export const HistoryCursor = z.string().regex(/^[0-9]{1,16}\.[0-9]{1,16}$/);
export type HistoryCursor = z.infer<typeof HistoryCursor>;

export const TicketHistory = z.object({
  tickets: z.array(Ticket),
  next: HistoryCursor.nullable(),
});
export type TicketHistory = z.infer<typeof TicketHistory>;

export interface HistoryPosition {
  readonly endedAt: number;
  readonly id: number;
}

export function cursorAt(position: HistoryPosition): HistoryCursor {
  return `${position.endedAt}.${position.id}`;
}

export function positionOfCursor(cursor: string): HistoryPosition | undefined {
  if (!HistoryCursor.safeParse(cursor).success) {
    return undefined;
  }
  const [endedAt, id] = cursor.split(".").map(Number);
  return endedAt === undefined || id === undefined || !Number.isSafeInteger(endedAt) || !Number.isSafeInteger(id) ? undefined : { endedAt, id };
}

export function isInHistory(ticket: Ticket): boolean {
  return finishedTicketStates.includes(ticket.state) && ticket.endedAt !== null && ticket.joinedInto === null;
}

export function positionOf(ticket: Ticket): HistoryPosition | undefined {
  return ticket.endedAt === null ? undefined : { endedAt: ticket.endedAt, id: ticket.id };
}

export function newerPosition(a: HistoryPosition, b: HistoryPosition): number {
  return b.endedAt - a.endedAt || b.id - a.id;
}

export function foldedText(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

export function searchTerms(query: string): string[] {
  const terms = new Map<string, string>();
  for (const term of query.split(/\s+/u)) {
    if (term !== "" && !terms.has(foldedText(term))) {
      terms.set(foldedText(term), term);
    }
  }
  return [...terms.values()].slice(0, historyTermLimit);
}

export function normalisedQuery(query: string): string {
  return searchTerms(query).join(" ");
}

export function searchedTexts(ticket: Ticket): string[] {
  return [
    ticket.title.zh,
    ticket.title.en,
    ticket.summary.zh,
    ticket.summary.en,
    ticketProject(ticket) ?? "",
    ...ticket.issues.flatMap((issue) => [issue.title.zh, issue.title.en, issue.summary.zh, issue.summary.en]),
  ].filter((entry) => entry !== "");
}

export function matchesTerms(ticket: Ticket, terms: readonly string[]): boolean {
  const texts = searchedTexts(ticket).map(foldedText);
  return terms.every((term) => texts.some((entry) => entry.includes(foldedText(term))));
}
