import { Attachment, type MessageWork, WorkSender } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";

export interface WorkerMessages {
  add(message: MessageWork): void;
  delivered(ticket: number, id: string): void;
  waiting(ticket: number): MessageWork[];
}

const Row = z.object({
  id: z.string(),
  ticket_id: z.number().int(),
  attempt: z.number().int(),
  sender: WorkSender,
  text: z.string(),
  attachments: z.string(),
});

export function createWorkerMessages(database: HubDatabase, clock: Clock): WorkerMessages {
  const { connection } = database;
  const insert = connection.prepare(
    "INSERT INTO worker_messages (id, ticket_id, attempt, sender, text, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
  );
  const markDelivered = connection.prepare("UPDATE worker_messages SET delivered_at = ? WHERE ticket_id = ? AND id = ? AND delivered_at IS NULL");
  const selectWaiting = connection.prepare(
    "SELECT id, ticket_id, attempt, sender, text, attachments FROM worker_messages WHERE ticket_id = ? AND delivered_at IS NULL ORDER BY created_at, rowid",
  );
  return {
    add: (message) => {
      insert.run(message.id, message.ticket, message.attempt, message.from, message.text, JSON.stringify(message.attachments ?? []), clock.now());
    },
    delivered: (ticket, id) => {
      markDelivered.run(clock.now(), ticket, id);
    },
    waiting: (ticket) =>
      selectWaiting.all(ticket).map((value) => {
        const row = Row.parse(value);
        return {
          type: "work.message",
          ticket: row.ticket_id,
          attempt: row.attempt,
          id: row.id,
          from: row.sender,
          text: row.text,
          attachments: z.array(Attachment).parse(JSON.parse(row.attachments)),
        };
      }),
  };
}
