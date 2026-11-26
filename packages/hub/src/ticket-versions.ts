import { z } from "zod";
import type { HubDatabase } from "./database.js";
import { ticketReferences } from "./ticket-codes.js";

export interface TicketTurn {
  readonly conversation: string;
  readonly id: string;
  available(): boolean;
}

export class TicketWriteRefused extends Error {}

const Changed = z.object({ ticket_id: z.number(), before: z.number().nullable() });
const Holder = z.object({ turn_id: z.string(), conversation_id: z.string(), title: z.string() });

export function createTicketVersions({ connection }: HubDatabase) {
  const references = ticketReferences(connection);
  connection.exec(`
    CREATE TEMP TABLE IF NOT EXISTS capture_ticket_changes (active INTEGER PRIMARY KEY) STRICT;
    CREATE TEMP TABLE IF NOT EXISTS changed_tickets (ticket_id INTEGER PRIMARY KEY, before INTEGER) STRICT;
    CREATE TEMP TRIGGER IF NOT EXISTS capture_new_ticket AFTER INSERT ON main.tickets
      WHEN EXISTS (SELECT 1 FROM capture_ticket_changes) BEGIN
        INSERT INTO changed_tickets VALUES (NEW.id, NULL) ON CONFLICT (ticket_id) DO NOTHING;
      END;
    CREATE TEMP TRIGGER IF NOT EXISTS capture_ticket_version AFTER UPDATE OF version ON main.tickets
      WHEN EXISTS (SELECT 1 FROM capture_ticket_changes) BEGIN
        INSERT INTO changed_tickets VALUES (OLD.id, OLD.version) ON CONFLICT (ticket_id) DO NOTHING;
      END;
  `);
  const active = connection.prepare("SELECT 1 FROM turns WHERE id = ? AND conversation_id = ? AND state = 'running' AND ticket_writes_revoked = 0");
  const changes = connection.prepare("SELECT ticket_id, before FROM changed_tickets ORDER BY ticket_id");
  const holderOf = connection.prepare(
    `SELECT l.turn_id, t.conversation_id, c.title FROM ticket_locks l
     JOIN turns t ON t.id = l.turn_id JOIN conversations c ON c.id = t.conversation_id WHERE l.ticket_id = ?`,
  );
  const lock = connection.prepare("INSERT INTO ticket_locks VALUES (?, ?) ON CONFLICT (ticket_id) DO NOTHING");
  const selectSeen = connection.prepare("SELECT version FROM topic_ticket_versions WHERE conversation_id = ? AND ticket_id = ?");
  const remember = connection.prepare(
    `INSERT INTO topic_ticket_versions (conversation_id, ticket_id, version)
     SELECT ?, id, version FROM tickets WHERE id = ?
     ON CONFLICT (conversation_id, ticket_id) DO UPDATE SET version = excluded.version`,
  );

  const canWrite = (turn: TicketTurn): boolean => turn.available() && active.get(turn.id, turn.conversation) !== undefined;
  const requireActive = (turn: TicketTurn): void => {
    if (!canWrite(turn)) {
      throw new TicketWriteRefused("This topic turn is no longer active. Try the change in an active turn.");
    }
  };

  return {
    requireActive,
    trackStart: (turn: TicketTurn, ids: readonly number[]) => {
      requireActive(turn);
      const insert = connection.prepare("INSERT OR IGNORE INTO turn_start_tickets (turn_id, ticket_id) VALUES (?, ?)");
      for (const id of ids) insert.run(turn.id, id);
    },
    seen: (turn: TicketTurn, ticket: number) => {
      if (canWrite(turn)) {
        remember.run(turn.conversation, ticket);
      }
    },
    start: (turn: TicketTurn) => {
      requireActive(turn);
      connection.exec("INSERT INTO capture_ticket_changes VALUES (1)");
    },
    finish: (turn: TicketTurn) => {
      requireActive(turn);
      const changed = changes.all().map((row) => Changed.parse(row));
      for (const { ticket_id: id, before } of changed) {
        const row = holderOf.get(id);
        if (row !== undefined) {
          const holder = Holder.parse(row);
          if (holder.turn_id !== turn.id) {
            const topic = holder.title === "" ? holder.conversation_id : `"${holder.title}" (${holder.conversation_id})`;
            throw new TicketWriteRefused(`Ticket ${references.get(id) ?? "(unavailable)"} is locked by topic ${topic}, turn ${holder.turn_id}. Wait for that turn to end, then read the ticket again.`);
          }
        }
        if (before === null) {
          continue;
        }
        const seen = selectSeen.get(turn.conversation, id);
        if (seen === undefined) {
          throw new TicketWriteRefused(`Read ticket ${references.get(id) ?? "(unavailable)"} with read_ticket before changing it.`);
        }
        if (seen["version"] !== before) {
          throw new TicketWriteRefused(`Ticket ${references.get(id) ?? "(unavailable)"} changed since this topic last read or wrote it. Read it again with read_ticket before retrying.`);
        }
      }
      for (const { ticket_id: id } of changed) {
        lock.run(id, turn.id);
        remember.run(turn.conversation, id);
      }
      connection.exec("DELETE FROM changed_tickets; DELETE FROM capture_ticket_changes;");
    },
  };
}
