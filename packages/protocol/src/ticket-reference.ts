import { z } from "zod";

export const TicketCode = z.string().regex(/^[a-z]{3}$/);
export const TicketCodeDate = z.iso.date();
export const ticketReferencePattern = String.raw`^[a-z]{3}(?:-\d{4}-\d{2}-\d{2})?$`;
export const TicketReference = z.string().regex(new RegExp(ticketReferencePattern), "Use a ticket code like aaa or aaa-2026-11-19");

export function ticketReference(ticket: { readonly code: string; readonly codeDate: string }): string {
  return `${ticket.code}-${ticket.codeDate}`;
}
