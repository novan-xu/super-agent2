import { randomUUID } from "node:crypto";
import { text } from "@super-agent2/catalog";
import { ScheduleFields, ScheduleState, TicketState, type ScheduleList, type ScheduleRun, type ScheduleAction, type ScheduleRecurrence } from "@super-agent2/protocol";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Chains } from "./chains.js";
import type { Clock } from "./clock.js";
import { storeTopic, type ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import { confirmationLifetime, ownerConfirmation } from "./owner-confirmation.js";
import { TicketWriteRefused, type TicketTurn } from "./ticket-versions.js";
import type { TicketService } from "./tickets.js";
import { intervalTicker, type Ticker } from "./verification.js";

const ScheduleRow = z.object({
  id: z.string(), topic: z.string(), fields: z.string(), next_at: z.number().nullable(),
  state: ScheduleState, confirmed_at: z.number(), revision: z.number(),
});
const ProposalRow = z.object({
  id: z.string(), fields: z.string(), target: z.string().nullable(), target_revision: z.number().nullable(),
  created_at: z.number(), stream_seq: z.number(), confirmed_schedule: z.string().nullable(),
});
const RunRow = z.object({
  id: z.string(), schedule: z.string(), revision: z.number(), due_at: z.number(), entry: z.string(),
  result_entry: z.string().nullable(),
  state: z.enum(["pending", "completed", "skipped", "failed", "interrupted", "cancelled"]),
  topic: z.string(), at: z.number(), turn_state: z.string().nullable(), reply: z.string().nullable(), delivery: z.string().nullable(),
});
const RunTicket = z.object({ id: z.number(), title: z.string(), light: z.number(), state: TicketState });

interface ScheduleOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly conversations: ConversationService;
  readonly tickets: TicketService;
  readonly chains: Chains;
  readonly owner: string;
  readonly ticker?: Ticker | undefined;
  readonly report: (line: string) => void;
}

export class ScheduleRefused extends Error {}

function nextOccurrence(recurrence: ScheduleRecurrence, now: number, timeZone: string): number {
  if ("at" in recurrence) return recurrence.at;
  try {
    return CronExpressionParser.parse(recurrence.cron, { currentDate: new Date(now), tz: timeZone }).next().getTime();
  } catch {
    throw new ScheduleRefused("Give a valid five-field cron expression with a future occurrence.");
  }
}

export function createSchedules({ database, clock, conversations, tickets, chains, owner, ticker, report }: ScheduleOptions) {
  const { connection, ticketTimeZone: timeZone } = database;
  const confirmation = ownerConfirmation(database);
  const selectAll = connection.prepare("SELECT * FROM schedules WHERE state <> 'deleted' ORDER BY confirmed_at DESC, rowid DESC");
  const selectSchedule = connection.prepare("SELECT * FROM schedules WHERE id = ? AND state <> 'deleted'");
  const due = connection.prepare("SELECT * FROM schedules WHERE state = 'active' AND next_at <= ? ORDER BY next_at, rowid");
  const insertSchedule = connection.prepare(`INSERT INTO schedules (id, topic, fields, state, next_at, confirmed_at, confirmed_by)
    VALUES (?, ?, ?, 'active', ?, ?, ?)`);
  const updateSchedule = connection.prepare(`UPDATE schedules SET fields = ?, state = ?, next_at = ?, confirmed_at = ?, confirmed_by = ?, revision = revision + 1
    WHERE id = ?`);
  const changeState = connection.prepare("UPDATE schedules SET state = ?, next_at = ?, revision = revision + 1 WHERE id = ?");
  const advance = connection.prepare("UPDATE schedules SET next_at = ? WHERE id = ?");
  const completeOnce = connection.prepare("UPDATE schedules SET state = 'completed' WHERE id = ? AND revision = ? AND state = 'active' AND next_at IS NULL");
  const insertProposal = connection.prepare(`INSERT INTO schedule_proposals (id, topic, fields, target, target_revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const latestProposal = connection.prepare(`SELECT p.*, e.stream_seq FROM schedule_proposals p
    JOIN conversation_entries e ON e.id = p.id AND e.conversation_id = p.topic
    WHERE p.topic = ? ORDER BY e.stream_seq DESC LIMIT 1`);
  const confirmProposal = connection.prepare("UPDATE schedule_proposals SET confirmed_schedule = ? WHERE id = ?");
  const insertRun = connection.prepare("INSERT INTO schedule_runs (id, schedule, revision, due_at, entry, state) VALUES (?, ?, ?, ?, ?, ?)");
  const runView = `SELECT r.*, e.conversation_id AS topic, e.created_at AS at, t.state AS turn_state,
    (SELECT reply.id FROM conversation_entries reply WHERE reply.turn_id = t.id AND reply.kind = 'text' AND reply.hidden = 0
      AND json_extract(reply.body, '$.text') <> '' ORDER BY reply.seq DESC LIMIT 1) AS reply,
    (SELECT delivery.id FROM conversation_entries delivery WHERE delivery.conversation_id = e.conversation_id AND delivery.kind = 'delivery'
      AND json_extract(delivery.body, '$.ticket') IN (SELECT id FROM tickets WHERE schedule_run = r.id)
      ORDER BY delivery.seq DESC LIMIT 1) AS delivery
    FROM schedule_runs r JOIN conversation_entries e ON e.id = r.entry LEFT JOIN turns t ON t.id = e.turn_id`;
  const recent = connection.prepare(`${runView} WHERE r.schedule = ? ORDER BY r.due_at DESC, r.rowid DESC LIMIT ?`);
  const finished = connection.prepare(`${runView} WHERE r.state = 'pending' AND t.state IN ('completed', 'failed', 'interrupted')`);
  const runTickets = connection.prepare(`SELECT id, title_zh AS title, light IS NOT NULL AS light, state FROM tickets
    WHERE schedule_run = ? AND joined_into IS NULL ORDER BY id`);
  const stagedLight = connection.prepare("SELECT id FROM tickets WHERE schedule_run = ? AND state = 'pending' AND light IS NOT NULL");
  const pendingVisible = connection.prepare("SELECT id FROM tickets WHERE schedule_run = ? AND state = 'pending' AND light IS NULL");
  const inFlight = connection.prepare(`SELECT 1 FROM schedule_runs r WHERE r.schedule = ? AND (
    r.state = 'pending' OR EXISTS (SELECT 1 FROM tickets WHERE schedule_run = r.id AND state IN ('waiting', 'working', 'verifying'))
  ) LIMIT 1`);
  const finish = connection.prepare("UPDATE schedule_runs SET state = ?, result_entry = ? WHERE id = ? AND state = 'pending'");
  let stopTicker: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const transaction = <T>(write: () => T): T => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  };

  const rowOf = (id: string) => ScheduleRow.optional().parse(selectSchedule.get(id));
  const fieldsOf = (row: { fields: string }): ScheduleFields => ScheduleFields.parse(JSON.parse(row.fields));
  const proposalOf = (topic: string) => ProposalRow.optional().parse(latestProposal.get(topic));
  const runOf = (raw: unknown): ScheduleRun => {
    const run = RunRow.parse(raw);
    const related = runTickets.all(run.id).map((item) => {
      const ticket = RunTicket.parse(item);
      return { ...ticket, light: ticket.light === 1 };
    });
    let state: ScheduleRun["state"] = run.state === "pending" ? run.turn_state === "running" ? "running" : "queued" : run.state;
    if (state === "completed") {
      if (related.some((ticket) => ticket.state === "waiting" || ticket.state === "working" || ticket.state === "verifying")) state = "running";
      else if (related.some((ticket) => ticket.state === "stopped")) state = "failed";
    }
    return {
      id: run.id,
      dueAt: run.due_at,
      at: run.at,
      state,
      topic: run.topic,
      entry: run.delivery ?? run.result_entry ?? run.reply ?? run.entry,
      tickets: related,
    };
  };

  const list = (): ScheduleList => ({
    timeZone,
    schedules: selectAll.all().map((raw) => {
      const row = ScheduleRow.parse(raw);
      const topic = conversations.get(row.topic);
      const last = recent.get(row.id, 1);
      return {
        ...fieldsOf(row),
        id: row.id, topic: topic?.id ?? row.topic, topicRepository: topic?.repository ?? null,
        state: row.state, nextAt: row.state === "active" ? row.next_at : null,
        confirmedAt: row.confirmed_at, revision: row.revision, lastRun: last === undefined ? null : runOf(last),
      };
    }),
  });

  const validate = (fields: ScheduleFields): number => {
    const now = clock.now();
    const next = nextOccurrence(fields.recurrence, now, timeZone);
    if (next <= now) throw new ScheduleRefused("Choose a future time for the one-time schedule.");
    return next;
  };

  const save = (fields: ScheduleFields, topic: string | undefined, target?: string, revision?: number): { id: string; topic: string } => {
    const next = validate(fields);
    if (target !== undefined) {
      const row = rowOf(target);
      if (row === undefined || (revision !== undefined && row.revision !== revision)) throw new ScheduleRefused("The schedule changed or was deleted. Read it again.");
      updateSchedule.run(JSON.stringify(fields), row.state === "paused" ? "paused" : "active", next, clock.now(), owner, target);
      return { id: target, topic: row.topic };
    }
    const id = randomUUID();
    const destination = topic === undefined ? storeTopic(database, clock.now(), fields.title, { repository: fields.repository ?? null }) : topic;
    insertSchedule.run(id, destination, JSON.stringify(fields), next, clock.now(), owner);
    return { id, topic: destination };
  };

  const change = (id: string, action: ScheduleAction): void => {
    const row = rowOf(id);
    if (row === undefined) throw new ScheduleRefused("This schedule was deleted.");
    if (action === "delete") {
      changeState.run("deleted", null, id);
    } else if (action === "pause" && row.state === "active") {
      changeState.run(row.next_at === null ? "completed" : "paused", row.next_at, id);
    } else if (action === "resume" && row.state === "paused") {
      const { recurrence } = fieldsOf(row);
      changeState.run("active", nextOccurrence(recurrence, clock.now(), timeZone), id);
    }
  };

  const requireOwner = (turn: TicketTurn, after = 0): void => {
    tickets.versions.requireActive(turn);
    if (!confirmation.turnAfter(turn, after)) throw new TicketWriteRefused("A newer owner message must be taken into the active turn of this topic.");
  };

  const finishRuns = () => {
    for (const raw of finished.all()) {
      const run = RunRow.parse(raw);
      const started = run.turn_state === "completed" ? chains.startScheduled(run.id) : undefined;
      const state = run.turn_state === "completed" ? started === undefined ? "cancelled" : started > 0 ? "failed" : "completed" : run.turn_state;
      const unused = stagedLight.all(run.id).map((row) => z.number().parse(row.id));
      if (unused.length > 0) tickets.change((writes) => {
        for (const id of unused) writes.move(id, "stopped", { en: "The scheduled turn did not start this task.", zh: text("schedule.notice.discardedTask") });
      });
      const notice = state === "completed" && run.reply !== null ? undefined : randomUUID();
      transaction(() => {
        if (notice !== undefined) {
          const key = started !== undefined && started > 0 ? "schedule.notice.incomplete"
            : state === "completed" ? "schedule.notice.completed"
              : state === "cancelled" ? "schedule.notice.cancelled" : "schedule.notice.failed";
          conversations.writeScheduleNotice(notice, run.topic, text(key));
        }
        finish.run(state, notice ?? run.reply, run.id);
        completeOnce.run(run.schedule, run.revision);
      });
      if (notice !== undefined) conversations.publishScheduleNotice(notice);
      tickets.announce(pendingVisible.all(run.id).map((row) => z.number().parse(row.id)));
    }
  };

  const tick = () => {
    if (closed) return;
    finishRuns();
    if (!conversations.brainReady()) return;
    const now = clock.now();
    for (const raw of due.all(now)) {
      const row = ScheduleRow.parse(raw);
      const topic = conversations.get(row.topic);
      if (topic === undefined || topic.mergePending === true || row.next_at === null) continue;
      const fields = fieldsOf(row);
      const { recurrence } = fields;
      const skip = inFlight.get(row.id) !== undefined;
      const id = randomUUID();
      const prompt = skip ? undefined : [
        `[hub] Scheduled run ${id} for ${JSON.stringify(fields.title)}. The owner has already confirmed this plan.`,
        ...(fields.repository === undefined ? [] : [`Related repository: ${fields.repository}.`]),
        ...(fields.machine === undefined ? [] : [`Requested work machine: ${fields.machine}.`]),
        "Choose how to carry out the instruction now. Use run_scheduled_light_task for quiet worker work, or use the regular issue, chain and task tools and state defaults. The hub starts work from this run after you finish the turn. Report the result or what you arranged in Chinese.",
        `Instruction:\n${fields.instruction}`,
      ].join("\n");
      transaction(() => {
        conversations.writeScheduleNotice(id, topic.id, text(skip ? "schedule.notice.skipped" : "schedule.notice.started", { title: fields.title }), prompt);
        insertRun.run(id, row.id, row.revision, row.next_at, id, skip ? "skipped" : "pending");
        advance.run("at" in recurrence ? null : nextOccurrence(recurrence, now, timeZone), row.id);
        if (skip) completeOnce.run(row.id, row.revision);
      });
      conversations.publishScheduleNotice(id);
    }
  };

  const poll = () => {
    try {
      tick();
    } catch (error) {
      report(`Scheduling could not advance: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    list,
    history: (id: string) => rowOf(id) === undefined ? undefined : { runs: recent.all(id, -1).map(runOf) },
    save: (fields: ScheduleFields, target?: string, revision?: number): string => {
      const saved = transaction(() => save(fields, undefined, target, revision));
      if (target === undefined) conversations.announce(saved.topic);
      return saved.id;
    },
    change,
    propose: (fields: ScheduleFields, summary: string, turn: TicketTurn, target?: string): string => {
      const previous = proposalOf(turn.conversation);
      requireOwner(turn, previous?.stream_seq ?? 0);
      validate(fields);
      const row = target === undefined ? undefined : rowOf(target);
      if (target !== undefined && row === undefined) throw new ScheduleRefused("This schedule was deleted.");
      const id = transaction(() => {
        const entry = conversations.writeConfirmation(turn.conversation, turn.id, summary);
        insertProposal.run(entry, turn.conversation, JSON.stringify(fields), target ?? null, row?.revision ?? null, clock.now());
        return entry;
      });
      conversations.announceEntry(id);
      return id;
    },
    confirm: (id: string, turn: TicketTurn): string => {
      tickets.versions.requireActive(turn);
      return transaction(() => {
        const proposal = proposalOf(turn.conversation);
        if (proposal?.id !== id) throw new TicketWriteRefused("This is not the current schedule proposal in this topic.");
        if (proposal.confirmed_schedule !== null) return proposal.confirmed_schedule;
        if (clock.now() - proposal.created_at >= confirmationLifetime) throw new TicketWriteRefused("The schedule proposal expired. Ask for confirmation again.");
        requireOwner(turn, proposal.stream_seq);
        const saved = save(fieldsOf(proposal), turn.conversation, proposal.target ?? undefined, proposal.target_revision ?? undefined);
        confirmProposal.run(saved.id, id);
        return saved.id;
      });
    },
    changeFromTurn: (id: string, action: ScheduleAction, turn: TicketTurn): void => {
      requireOwner(turn);
      change(id, action);
    },
    context: (topic: string, message: string): string => {
      const proposal = proposalOf(topic);
      if (proposal?.confirmed_schedule !== null || !confirmation.messageAfter(topic, message, proposal.stream_seq)) return "";
      const title = JSON.stringify(fieldsOf(proposal).title);
      return clock.now() - proposal.created_at >= confirmationLifetime
        ? `\n\n[hub] The schedule proposal for ${title} expired. Propose it again if the owner still wants it.`
        : `\n\n[hub] Current schedule proposal ${proposal.id}: ${title}. Call create_schedule only if this owner message agrees to the proposed plan.`;
    },
    tick,
    resume: () => {
      stopTicker ??= (ticker ?? intervalTicker(5_000))(poll);
      unsubscribe ??= conversations.subscribe((event) => {
        if (event.type === "turn" && event.turn.state !== "running") queueMicrotask(poll);
      });
      poll();
    },
    close: () => {
      closed = true;
      stopTicker?.();
      unsubscribe?.();
    },
  };
}

export type Schedules = ReturnType<typeof createSchedules>;
