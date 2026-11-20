import { Attachment, ticketReference } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";
import type { TicketTurn } from "./ticket-versions.js";

const QuestionRow = z.object({
  entry: z.string(), ticket: z.number(), code: z.string(), codeDate: z.string(), text: z.string(),
});
const AnswerRow = QuestionRow.extend({ owner: z.string(), body: z.string() });
const OwnerBody = z.object({ text: z.string(), attachments: z.array(Attachment).default([]) });

export function createLightTaskQuestions({ connection }: HubDatabase) {
  const questions = `SELECT q.entry, t.id AS ticket, t.code, t.code_date AS codeDate, json_extract(e.body, '$.text') AS text`;
  const available = `FROM light_task_questions q
    JOIN tickets t ON t.id = q.ticket
    JOIN conversation_entries e ON e.id = q.entry
    JOIN ticket_attempts a ON a.ticket_id = t.id AND a.attempt = q.attempt
    JOIN conversation_entries owner ON owner.conversation_id = e.conversation_id
    WHERE e.conversation_id = ? AND owner.kind = 'owner' AND owner.stream_seq > e.stream_seq
      AND q.answered_by IS NULL AND t.state = 'working' AND a.state IN ('preparing', 'running')
      AND q.attempt = (SELECT MAX(attempt) FROM ticket_attempts WHERE ticket_id = t.id)`;
  const forMessage = connection.prepare(`${questions} ${available} AND owner.id = ? ORDER BY e.stream_seq`);
  const forTurn = connection.prepare(`${questions}, owner.id AS owner, owner.body ${available} AND t.id = ? AND owner.turn_id = ? AND owner.taken = 1
    ORDER BY owner.stream_seq DESC, e.stream_seq DESC LIMIT 1`);
  const exists = connection.prepare("SELECT 1 FROM light_task_questions WHERE entry = ?");
  const insert = connection.prepare("INSERT INTO light_task_questions (entry, ticket, attempt) VALUES (?, ?, ?)");
  const answered = connection.prepare("UPDATE light_task_questions SET answered_by = ? WHERE entry = ?");

  return {
    context: (topic: string, message: string): string => {
      const pending = forMessage.all(topic, message).map((row) => QuestionRow.parse(row));
      return pending.length === 0 ? "" : [
        "",
        "",
        "[hub] These light-task workers asked a question in this topic. If the owner answered a question in this message, use answer_light_task with its internal reference. If the owner requested a stop, use stop_ticket. Keep internal references private.",
        ...pending.map((question) => `${ticketReference(question)}: ${JSON.stringify(question.text)}`),
      ].join("\n");
    },
    ask: (ticket: number, attempt: number, id: string, write: (entry: string) => void): string | undefined => {
      const entry = `light-question-${id}`;
      if (exists.get(entry) !== undefined) return undefined;
      write(entry);
      insert.run(entry, ticket, attempt);
      return entry;
    },
    answer: (ticket: number, turn: TicketTurn) => {
      const row = AnswerRow.optional().parse(forTurn.get(turn.conversation, ticket, turn.id));
      if (row === undefined) return undefined;
      return { ...OwnerBody.parse(JSON.parse(row.body)), record: () => answered.run(row.owner, row.entry) };
    },
  };
}

export type LightTaskQuestions = ReturnType<typeof createLightTaskQuestions>;
