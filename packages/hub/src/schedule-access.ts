import { z } from "zod";
import type { HubDatabase } from "./database.js";
import type { TicketTurn } from "./ticket-versions.js";

const RunAccess = z.object({ id: z.string(), machine: z.string().nullable(), authorized: z.number() });

export function scheduleAccess({ connection }: HubDatabase) {
  const source = `FROM schedule_runs r
    JOIN schedules s ON s.id = r.schedule
    JOIN conversation_entries e ON e.id = r.entry AND e.taken = 1
    JOIN turns t ON t.id = e.turn_id`;
  const authorized = `r.state = 'pending' AND s.state = 'active' AND s.revision = r.revision
    AND NOT EXISTS (SELECT 1 FROM conversation_entries other
      WHERE other.turn_id = t.id AND other.taken = 1 AND other.id <> r.entry AND other.prompt IS NOT NULL)`;
  const byTurn = connection.prepare(`SELECT r.id, json_extract(s.fields, '$.machine') AS machine,
    (${authorized} AND t.state = 'running' AND t.ticket_writes_revoked = 0) AS authorized
    ${source} WHERE t.id = ? AND t.conversation_id = ? ORDER BY e.seq LIMIT 1`);
  const completed = connection.prepare(`SELECT 1 ${source} WHERE r.id = ? AND t.state = 'completed' AND ${authorized}`);
  const pending = connection.prepare("SELECT 1 FROM schedule_runs WHERE id = ? AND state = 'pending'");
  return {
    forTurn: (turn: TicketTurn) => {
      const run = RunAccess.optional().parse(byTurn.get(turn.id, turn.conversation));
      return run === undefined ? undefined : { ...run, authorized: run.authorized === 1 };
    },
    mayStart: (run: string) => completed.get(run) !== undefined,
    pending: (run: string) => pending.get(run) !== undefined,
  };
}
