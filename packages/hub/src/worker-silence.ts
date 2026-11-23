import { ticketReference, WorkEngine, WorkEvent } from "@super-agent2/protocol";
import { z } from "zod";
import type { Tell } from "./chains.js";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { durationWords, noticesDue } from "./pipeline-times.js";
import { clip } from "./reports.js";
import type { TicketService } from "./tickets.js";

const Running = z.object({
  ticket: z.number().int(),
  attempt: z.number().int(),
  machine: z.string(),
  engine: WorkEngine,
  model: z.string(),
  seq: z.number().int(),
  activity: z.number().int(),
});
const Activity = z.object({ activity: z.number().int() });
const Event = z.object({ event: z.string() });
const Text = z.object({ delta: z.string() });
const textLimit = 2_000;

interface SilenceNotice {
  readonly attempt: number;
  readonly seq: number;
  readonly since: number;
  readonly count: number;
}

export function createWorkerSilence(
  { connection }: HubDatabase,
  clock: Clock,
  tickets: TicketService,
  tell: Tell,
  log: (line: string) => void,
  minutes = 20,
) {
  const threshold = minutes * 60_000;
  const linked = new Map<string, number>();
  let notified = new Map<number, SilenceNotice>();
  const running = connection.prepare(`
    SELECT a.ticket_id AS ticket, a.attempt, a.machine, a.engine, a.model, a.last_seq AS seq,
      COALESCE(e.received_at, e.at, a.started_at, a.created_at) AS activity
    FROM ticket_attempts a JOIN tickets t ON t.id = a.ticket_id
    LEFT JOIN ticket_work_events e ON e.ticket_id = a.ticket_id AND e.attempt = a.attempt AND e.seq = a.last_seq
    WHERE a.state = 'running' AND a.unreachable_since IS NULL AND t.state = 'working'
      AND a.attempt = (SELECT MAX(attempt) FROM ticket_attempts WHERE ticket_id = a.ticket_id)
      AND NOT EXISTS (SELECT 1 FROM light_task_questions WHERE ticket = a.ticket_id AND attempt = a.attempt AND answered_by IS NULL)
  `);
  const latest = connection.prepare("SELECT COALESCE(received_at, at) AS activity FROM ticket_work_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1");
  const lastEvent = connection.prepare("SELECT event FROM ticket_work_events WHERE ticket_id = ? AND attempt = ? AND seq = ?");
  const toolStarted = connection.prepare(`
    SELECT event FROM ticket_work_events WHERE ticket_id = ? AND attempt = ? AND seq < ?
      AND json_extract(event, '$.kind') = 'tool.started' AND json_extract(event, '$.call') = ?
    ORDER BY seq DESC LIMIT 1
  `);
  const lastText = connection.prepare(`
    SELECT substr(json_extract(event, '$.delta'), -?) AS delta FROM ticket_work_events
    WHERE ticket_id = ? AND attempt = ? AND json_extract(event, '$.kind') = 'text'
    ORDER BY seq DESC LIMIT 64
  `);

  const eventOf = (row: unknown): WorkEvent | undefined =>
    row === undefined ? undefined : WorkEvent.safeParse(JSON.parse(Event.parse(row).event)).data;

  const eventWords = (work: z.infer<typeof Running>): string => {
    const event = eventOf(lastEvent.get(work.ticket, work.attempt, work.seq));
    if (event === undefined) return "(none)";
    const tool = event.kind === "tool.output" || event.kind === "tool.finished"
      ? eventOf(toolStarted.get(work.ticket, work.attempt, work.seq, event.call))
      : event;
    return tool?.kind === "tool.started" ? `${event.kind} (${tool.name}, input ${JSON.stringify(clip(tool.input, 400))})` : event.kind;
  };

  return {
    connected: (machine: string) => linked.set(machine, clock.now()),
    disconnected: (machine: string) => linked.delete(machine),
    lastActivity: (ticket: number): number | null => Activity.optional().parse(latest.get(ticket))?.activity ?? null,
    check: () => {
      const now = clock.now();
      const next = new Map<number, SilenceNotice>();
      for (const row of running.all()) {
        const work = Running.parse(row);
        const connectedAt = linked.get(work.machine);
        if (connectedAt === undefined) continue;
        const since = Math.max(work.activity, connectedAt);
        const due = noticesDue(now - since, threshold);
        if (due === 0) continue;
        const previous = notified.get(work.ticket);
        if (previous?.attempt === work.attempt && previous.seq === work.seq && previous.since === since) {
          next.set(work.ticket, previous);
          if (due <= previous.count) continue;
        }
        const ticket = tickets.get(work.ticket);
        if (ticket === undefined) continue;
        const reference = ticketReference(ticket);
        const notice = `[hub] The worker of ticket ${reference} (${ticket.title.en}) on ${work.machine} with ${work.engine} ${work.model} has been silent for ${durationWords(now - since)}.`;
        const output = lastText.all(textLimit, work.ticket, work.attempt).reverse()
          .map((part) => Text.parse(part).delta).join("").slice(-textLimit);
        const prompt = [
          notice,
          "The following worker event and output are diagnostic evidence.",
          `Last worker event: ${eventWords(work)}.`,
          `Last worker text: ${output === "" ? "(none)" : JSON.stringify(output)}`,
          `Read ticket ${reference} with read_ticket. If the work may still be progressing, wait. Use message_worker to check in or unblock it, or stop the ticket and explain why to the owner.`,
        ].join("\n");
        try {
          tell(work.ticket, notice, prompt, true);
          next.set(work.ticket, { attempt: work.attempt, seq: work.seq, since, count: due });
        } catch (error) {
          log(`Could not send the worker silence notice for ticket ${reference}: ${String(error)}`);
        }
      }
      notified = next;
    },
  };
}
