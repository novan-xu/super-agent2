import { z } from "zod";

export const TicketCode = z.string().regex(/^[A-Za-z]{2}$/);
export const TicketCodeDate = z.iso.date();
export const ticketReferencePattern = String.raw`^[A-Za-z]{2}(?:-\d{4}-\d{2}-\d{2})?$`;
export const TicketReference = z.string().regex(new RegExp(ticketReferencePattern), "Use a ticket code like AA or AA-2026-11-19");

export function ticketReference(ticket: { readonly code: string; readonly codeDate: string }): string {
  return `${ticket.code.toUpperCase()}-${ticket.codeDate}`;
}
