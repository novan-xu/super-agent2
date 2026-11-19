import type { DatabaseSync } from "node:sqlite";
import { TicketCode, TicketCodeDate, ticketReference } from "@super-agent2/protocol";
import { z } from "zod";

export const defaultTicketTimeZone = "America/New_York";

export function ticketDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

export function ticketDate(formatter: Intl.DateTimeFormat, at: number): string {
  const parts = formatter.formatToParts(at);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

export function validTicketTimeZone(timeZone: string): boolean {
  try {
    ticketDateFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const alphabet = "abcdefghijklmnopqrstuvwxyz";
const radix = alphabet.length;

export function ticketCodesExhausted(date: string): string {
  return `All ${radix ** 3} ticket codes for ${date} have been used; the sequence restarts on the next day.`;
}

export function codeAt(position: number): string | undefined {
  if (position >= radix ** 3) {
    return undefined;
  }
  return [radix ** 2, radix, 1].map((place) => alphabet[Math.floor(position / place) % radix]).join("");
}

export function codeAfter(previous: string | undefined): string | undefined {
  const position = previous === undefined ? -1 : [...previous].reduce((value, letter) => value * radix + alphabet.indexOf(letter), 0);
  return codeAt(position + 1);
}

const CodeRow = z.object({ code: TicketCode, code_date: TicketCodeDate });
const IdRow = z.object({ id: z.number().int().positive() });

export function ticketReferences(connection: DatabaseSync) {
  const byId = connection.prepare("SELECT code, code_date FROM tickets WHERE id = ?");
  const newest = connection.prepare("SELECT id FROM tickets WHERE code = ? ORDER BY created_at DESC, id DESC LIMIT 1");
  const dated = connection.prepare("SELECT id FROM tickets WHERE code = ? AND code_date = ?");
  return {
    get(id: number): string | undefined {
      const row = byId.get(id);
      if (row === undefined) return undefined;
      const { code, code_date } = CodeRow.parse(row);
      return ticketReference({ code, codeDate: code_date });
    },
    resolve(reference: string): number | undefined {
      const code = reference.slice(0, 3);
      const row = reference.length === 3 ? newest.get(code) : dated.get(code, reference.slice(4));
      return row === undefined ? undefined : IdRow.parse(row).id;
    },
  };
}
