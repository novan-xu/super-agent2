import type { HubDatabase } from "./database.js";
import type { TicketTurn } from "./ticket-versions.js";

export const confirmationLifetime = 24 * 60 * 60 * 1000;

export function ownerConfirmation({ connection }: HubDatabase) {
  const latestOwner = connection.prepare(`SELECT stream_seq FROM conversation_entries
    WHERE conversation_id = ? AND turn_id = ? AND kind = 'owner' AND taken = 1
    ORDER BY stream_seq DESC LIMIT 1`);
  const ownerSequence = connection.prepare("SELECT stream_seq FROM conversation_entries WHERE id = ? AND conversation_id = ? AND kind = 'owner'");
  const after = (streamSequence: unknown, confirmation: number) =>
    typeof streamSequence === "number" && streamSequence > confirmation;
  return {
    turnAfter: (turn: TicketTurn, confirmation: number) => after(latestOwner.get(turn.conversation, turn.id)?.stream_seq, confirmation),
    messageAfter: (topic: string, message: string, confirmation: number) => after(ownerSequence.get(message, topic)?.stream_seq, confirmation),
  };
}
