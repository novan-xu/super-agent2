import { randomBytes, randomUUID } from "node:crypto";
import { text } from "@super-agent2/catalog";
import {
  activeWorkStates,
  finishedTicketStates,
  type RunnerWorkEvent,
  StoredWorkEvent,
  type Ticket,
  WorkEngine,
  WorkEvent,
  type WorkFailure,
  type WorkHeld,
  type WorkSender,
  type WorkState,
  type WorkTask,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Tell } from "./chains.js";
import type { Clock } from "./clock.js";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import { accountFor } from "./filing.js";
import { clip } from "./reports.js";
import type { Runners, WorkMessageToRunner } from "./runners.js";
import type { TicketService, TicketWork } from "./tickets.js";

export type WorkRunners = Pick<Runners, "bindWork" | "sendWork" | "report" | "subscribe">;

export interface WorkServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly tickets: TicketService;
  readonly runners: WorkRunners;
  readonly credentials: CredentialSource;
  readonly tell?: Tell;
  readonly branchSuffix?: () => string;
}

export type WorkOutcome = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly reason: string };

export type MessageOutcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string };

export type WorkListener = (event: StoredWorkEvent) => void;

export interface WorkService extends TicketWork {
  begin(ticket: Ticket): void;
  stop(ticket: Ticket): void;
  reassign(ticket: Ticket): void;
  again(ticket: number, note: string): WorkOutcome;
  message(ticket: number, text: string, from: WorkSender): MessageOutcome;
  events(ticket: number, after?: number, limit?: number): StoredWorkEvent[];
  output(ticket: number, limit?: number): string;
  subscribe(listener: WorkListener): () => void;
  resume(): void;
  close(): void;
}

const Attempt = z.object({
  ticket_id: z.number().int(),
  attempt: z.number().int(),
  machine: z.string(),
  engine: WorkEngine,
  model: z.string(),
  effort: z.string(),
  state: z.string(),
  session: z.string().nullable(),
  resume_session: z.string().nullable(),
  note: z.string().nullable(),
  handover: z.number().int(),
  failure: z.string().nullable(),
  reason: z.string().nullable(),
  unreachable_since: z.number().int().nullable(),
  last_seq: z.number().int(),
  created_at: z.number().int(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
});
type Attempt = z.infer<typeof Attempt>;

const EventRow = z.object({ id: z.number().int(), ticket_id: z.number().int(), attempt: z.number().int(), seq: z.number().int(), at: z.number().int(), event: z.string() });

const CountRow = z.object({ count: z.number().int() });

const defaultEventLimit = 5_000;

function isActive(state: string): boolean {
  return (activeWorkStates as readonly string[]).includes(state);
}

function isFinal(ticket: Ticket): boolean {
  return finishedTicketStates.includes(ticket.state);
}

export function branchFor(ticket: number, suffix: string): string {
  return `sa2/ticket-${ticket}-${suffix}`;
}

const failureWords: Readonly<Record<WorkFailure, string>> = {
  prepare: "could not prepare its worktree",
  program: "failed",
  "no-pull-request": "ended without a pull request",
  lost: "was lost",
};

export function createWorkService(options: WorkServiceOptions): WorkService {
  const { tickets, clock, runners } = options;
  const { connection } = options.database;
  const tell: Tell = options.tell ?? (() => undefined);
  const suffix = options.branchSuffix ?? (() => randomBytes(2).toString("hex"));
  const listeners = new Set<WorkListener>();
  const removalsSent = new Set<string>();
  let closed = false;

  const selectAttempt = connection.prepare("SELECT * FROM ticket_attempts WHERE ticket_id = ? AND attempt = ?");
  const selectLatest = connection.prepare("SELECT * FROM ticket_attempts WHERE ticket_id = ? ORDER BY attempt DESC LIMIT 1");
  const selectMachines = connection.prepare("SELECT DISTINCT machine FROM ticket_attempts WHERE ticket_id = ?");
  const selectQueued = connection.prepare(
    "SELECT a.* FROM ticket_attempts a WHERE a.state = 'queued' AND a.attempt = (SELECT MAX(attempt) FROM ticket_attempts b WHERE b.ticket_id = a.ticket_id) ORDER BY a.created_at, a.ticket_id",
  );
  const selectActiveOn = connection.prepare("SELECT * FROM ticket_attempts WHERE machine = ? AND state IN ('preparing', 'running')");
  const selectActive = connection.prepare("SELECT * FROM ticket_attempts WHERE state IN ('preparing', 'running')");
  const countActiveOn = connection.prepare("SELECT COUNT(*) AS count FROM ticket_attempts WHERE machine = ? AND state IN ('preparing', 'running')");
  const insertAttempt = connection.prepare(
    "INSERT INTO ticket_attempts (ticket_id, attempt, machine, engine, model, effort, state, resume_session, note, handover, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
  );
  const updateState = connection.prepare("UPDATE ticket_attempts SET state = ? WHERE ticket_id = ? AND attempt = ?");
  const updateStarted = connection.prepare("UPDATE ticket_attempts SET state = 'preparing', started_at = COALESCE(started_at, ?), unreachable_since = NULL WHERE ticket_id = ? AND attempt = ?");
  const updateEnded = connection.prepare("UPDATE ticket_attempts SET state = ?, ended_at = ?, failure = ?, reason = ? WHERE ticket_id = ? AND attempt = ?");
  const updateSession = connection.prepare("UPDATE ticket_attempts SET session = ? WHERE ticket_id = ? AND attempt = ?");
  const updateSeq = connection.prepare("UPDATE ticket_attempts SET last_seq = ? WHERE ticket_id = ? AND attempt = ?");
  const updateHandover = connection.prepare("UPDATE ticket_attempts SET handover = 0 WHERE ticket_id = ? AND handover = 1");
  const markUnreachable = connection.prepare(
    "UPDATE ticket_attempts SET unreachable_since = ? WHERE machine = ? AND state IN ('preparing', 'running') AND unreachable_since IS NULL",
  );
  const markAllUnreachable = connection.prepare("UPDATE ticket_attempts SET unreachable_since = ? WHERE state IN ('preparing', 'running') AND unreachable_since IS NULL");
  const clearUnreachable = connection.prepare("UPDATE ticket_attempts SET unreachable_since = NULL WHERE machine = ? AND unreachable_since IS NOT NULL");
  const insertEvent = connection.prepare("INSERT OR IGNORE INTO ticket_work_events (ticket_id, attempt, seq, at, event) VALUES (?, ?, ?, ?, ?)");
  const selectEvents = connection.prepare("SELECT * FROM ticket_work_events WHERE ticket_id = ? AND id > ? ORDER BY id LIMIT ?");
  const selectRecent = connection.prepare("SELECT * FROM ticket_work_events WHERE ticket_id = ? AND attempt = ? ORDER BY id DESC LIMIT ?");

  const attemptOf = (ticket: number, attempt: number): Attempt | undefined => {
    const row = selectAttempt.get(ticket, attempt);
    return row === undefined ? undefined : Attempt.parse(row);
  };

  const latestOf = (ticket: number): Attempt | undefined => {
    const row = selectLatest.get(ticket);
    return row === undefined ? undefined : Attempt.parse(row);
  };

  const touch = (ticket: number, body: () => void = () => undefined) => {
    tickets.change((writes) => {
      body();
      writes.touched(ticket);
    });
  };

  const announce = (event: StoredWorkEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  };

  const storedOf = (row: unknown): StoredWorkEvent | undefined => {
    const value = EventRow.parse(row);
    const event = WorkEvent.safeParse(JSON.parse(value.event));
    if (!event.success) {
      return undefined;
    }
    return StoredWorkEvent.parse({ id: value.id, ticket: value.ticket_id, attempt: value.attempt, seq: value.seq, at: value.at, event: event.data });
  };

  const outputOf = (ticket: number, attempt: number, limit: number): string => {
    const rows = selectRecent.all(ticket, attempt, defaultEventLimit).reverse();
    const parts: string[] = [];
    for (const row of rows) {
      const stored = storedOf(row);
      if (stored === undefined) {
        continue;
      }
      const event = stored.event;
      if (event.kind === "text") {
        parts.push(event.delta);
      } else if (event.kind === "tool.started") {
        parts.push(`\n[${event.name}] ${event.input}\n`);
      } else if (event.kind === "tool.finished" && event.output !== null) {
        parts.push(`${event.output}\n`);
      } else if (event.kind === "phase" || event.kind === "failed") {
        parts.push(`\n[${event.kind === "phase" ? event.phase : "failed"}] ${event.kind === "phase" ? event.detail : event.reason}\n`);
      }
    }
    const joined = parts.join("");
    return joined.length <= limit ? joined : clip(joined, limit);
  };

  const failed = (ticket: Ticket, attempt: Attempt, failure: WorkFailure, reason: string) => {
    if (closed) {
      return;
    }
    tell(
      ticket.conversation,
      text("notice.workerFailed", { ticket: ticket.id }),
      [
        `[hub] The worker of ticket ${ticket.id} (${ticket.title.en}) on ${attempt.machine} with ${attempt.engine} ${attempt.model} ${attempt.effort} ${failureWords[failure]}: ${reason}`,
        `The ticket stays working with this failure recorded, on branch ${ticket.branch ?? "(none)"}, and nothing is running for it now.`,
        "Its output ends with:",
        outputOf(ticket.id, attempt.attempt, 6_000) || "(no output)",
        "Tell the owner what happened and what you think should be done. The owner can reassign it to start it again; stop it with stop_ticket if it cannot be done.",
      ].join("\n"),
    );
  };

  const end = (ticket: number, attempt: number, state: WorkState, failure: WorkFailure | null, reason: string | null) => {
    updateEnded.run(state, clock.now(), failure, reason, ticket, attempt);
  };

  const taskOf = (ticket: Ticket, attempt: Attempt): WorkTask | string => {
    if (ticket.repository === null) {
      return `Ticket ${ticket.id} has no repository`;
    }
    const credentials = options.credentials(accountFor(ticket.repository));
    if (!credentials.ok) {
      return credentials.reason;
    }
    const token = credentials.credentials["GH_TOKEN"];
    if (token === undefined) {
      return `There is no GitHub token for ${ticket.repository}`;
    }
    return {
      ticket: ticket.id,
      attempt: attempt.attempt,
      repository: ticket.repository,
      account: accountFor(ticket.repository),
      branch: ticket.branch ?? branchFor(ticket.id, suffix()),
      title: ticket.title.en,
      issues: ticket.issues.map((issue) => ({ number: issue.number, title: issue.title.en, url: issue.url })),
      engine: attempt.engine,
      model: attempt.model,
      effort: attempt.effort,
      session: attempt.session ?? attempt.resume_session,
      note: attempt.note,
      environment: { GH_TOKEN: token, GITHUB_TOKEN: token },
    };
  };

  const send = (machine: string, message: WorkMessageToRunner): boolean => {
    try {
      return runners.sendWork(machine, message);
    } catch {
      return false;
    }
  };

  const dispatch = () => {
    if (closed) {
      return;
    }
    for (const row of selectQueued.all()) {
      const attempt = Attempt.parse(row);
      if (attempt.handover === 1) {
        continue;
      }
      const ticket = tickets.get(attempt.ticket_id);
      if (ticket === undefined || ticket.state !== "working") {
        continue;
      }
      const report = runners.report(attempt.machine);
      if (report === undefined) {
        continue;
      }
      const busy = CountRow.parse(countActiveOn.get(attempt.machine)).count;
      if (busy >= report.slots.total) {
        continue;
      }
      const task = taskOf(ticket, attempt);
      if (typeof task === "string") {
        touch(ticket.id, () => end(ticket.id, attempt.attempt, "failed", "prepare", task));
        failed(ticket, attempt, "prepare", task);
        continue;
      }
      if (send(attempt.machine, { type: "work.start", task })) {
        touch(ticket.id, () => updateStarted.run(clock.now(), ticket.id, attempt.attempt));
      }
    }
  };

  const machinesOf = (ticket: number): string[] => selectMachines.all(ticket).map((row) => z.object({ machine: z.string() }).parse(row).machine);

  const removeEverywhere = (ticket: Ticket) => {
    for (const machine of machinesOf(ticket.id)) {
      const key = `${machine}:${ticket.id}`;
      if (removalsSent.has(key)) {
        continue;
      }
      if (send(machine, { type: "work.stop", ticket: ticket.id, save: false, remove: true })) {
        removalsSent.add(key);
      }
    }
  };

  const finish = (ticket: Ticket) => {
    const latest = latestOf(ticket.id);
    if (latest !== undefined && (latest.state === "queued" || isActive(latest.state))) {
      touch(ticket.id, () => end(ticket.id, latest.attempt, "stopped", null, ticket.stopReason?.en ?? `The ticket is ${ticket.state}`));
    }
    removeEverywhere(ticket);
  };

  const nextAttempt = (ticket: Ticket, note: string | null, previous: Attempt | undefined): void => {
    if (ticket.machine === null || ticket.engine === null || ticket.model === null || ticket.effort === null) {
      throw new Error(`Ticket ${ticket.id} has no machine, engine, model and effort chosen`);
    }
    const engine = WorkEngine.safeParse(ticket.engine);
    if (!engine.success) {
      throw new Error(`${ticket.engine} is not an engine for code`);
    }
    const machine = ticket.machine;
    const sameMachine = previous?.machine === machine;
    const resume = previous !== undefined && sameMachine && previous.engine === engine.data ? (previous.session ?? previous.resume_session) : null;
    let handover = 0;
    if (previous !== undefined && !sameMachine) {
      const wasActive = isActive(previous.state);
      if (send(previous.machine, { type: "work.stop", ticket: ticket.id, save: true, remove: true })) {
        removalsSent.add(`${previous.machine}:${ticket.id}`);
        handover = wasActive ? 1 : 0;
      }
    }
    const number = (previous?.attempt ?? 0) + 1;
    tickets.change((writes) => {
      if (previous !== undefined && (previous.state === "queued" || isActive(previous.state))) {
        end(ticket.id, previous.attempt, "replaced", null, null);
      }
      if (ticket.branch === null) {
        writes.setBranch(ticket.id, branchFor(ticket.id, suffix()));
      }
      insertAttempt.run(ticket.id, number, machine, engine.data, ticket.model, ticket.effort, resume, note, handover, clock.now());
      writes.touched(ticket.id);
    });
    dispatch();
  };

  const begin = (ticket: Ticket) => {
    if (ticket.kind === "writing") {
      throw new Error("A writing ticket has no worker for code; writing work is not built yet");
    }
    if (ticket.repository === null || ticket.issues.length === 0) {
      throw new Error(`Ticket ${ticket.id} has no repository or no issues`);
    }
    if (latestOf(ticket.id) !== undefined) {
      dispatch();
      return;
    }
    const current = tickets.get(ticket.id) ?? ticket;
    if (current.state !== "working") {
      return;
    }
    nextAttempt(current, null, undefined);
  };

  const apply = (machine: string, message: RunnerWorkEvent) => {
    const attempt = attemptOf(message.ticket, message.attempt);
    if (attempt === undefined || attempt.machine !== machine) {
      return;
    }
    if (message.seq <= attempt.last_seq) {
      return;
    }
    if (message.seq > attempt.last_seq + 1) {
      send(machine, { type: "work.sync", ticket: attempt.ticket_id, attempt: attempt.attempt, after: attempt.last_seq });
      return;
    }
    const event = message.event;
    const latest = latestOf(attempt.ticket_id);
    const current = latest?.attempt === attempt.attempt;
    let told: { readonly failure: WorkFailure; readonly reason: string } | undefined;
    let handedOver = false;
    let id = 0;
    tickets.change((writes) => {
      id = Number(insertEvent.run(attempt.ticket_id, attempt.attempt, message.seq, message.at, JSON.stringify(event)).lastInsertRowid);
      updateSeq.run(message.seq, attempt.ticket_id, attempt.attempt);
      const live = attempt.state === "preparing" || attempt.state === "running";
      switch (event.kind) {
        case "phase":
          if (attempt.state === "preparing" && (event.phase === "started" || event.phase === "resumed" || event.phase === "turn")) {
            updateState.run("running", attempt.ticket_id, attempt.attempt);
            writes.touched(attempt.ticket_id);
          }
          return;
        case "session":
          updateSession.run(event.session, attempt.ticket_id, attempt.attempt);
          writes.touched(attempt.ticket_id);
          return;
        case "ran":
          if (current) {
            writes.ran(attempt.ticket_id, { machine, engine: attempt.engine, model: event.model, effort: event.effort, at: message.at });
          }
          return;
        case "finished": {
          if (live) {
            end(attempt.ticket_id, attempt.attempt, "finished", null, null);
          }
          const ticket = writes.get(attempt.ticket_id);
          if (current && ticket !== undefined) {
            writes.setPullRequest(ticket.id, event.pullRequest, event.report);
            if (ticket.state === "working") {
              writes.move(ticket.id, "verifying");
            }
          }
          writes.touched(attempt.ticket_id);
          return;
        }
        case "failed":
          if (live) {
            end(attempt.ticket_id, attempt.attempt, "failed", event.failure, event.reason);
            if (current) {
              told = { failure: event.failure, reason: event.reason };
            }
          }
          writes.touched(attempt.ticket_id);
          return;
        case "stopped":
          if (live) {
            end(attempt.ticket_id, attempt.attempt, "stopped", null, event.detail);
          }
          if (updateHandover.run(attempt.ticket_id).changes > 0) {
            handedOver = true;
          }
          writes.touched(attempt.ticket_id);
          return;
        default:
          return;
      }
    });
    const stored: StoredWorkEvent = { id, ticket: attempt.ticket_id, attempt: attempt.attempt, seq: message.seq, at: message.at, event };
    announce(stored);
    if (told !== undefined) {
      const ticket = tickets.get(attempt.ticket_id);
      const now = attemptOf(attempt.ticket_id, attempt.attempt);
      if (ticket !== undefined && now !== undefined && !isFinal(ticket)) {
        failed(ticket, now, told.failure, told.reason);
      }
    }
    if (handedOver || event.kind === "finished" || event.kind === "failed" || event.kind === "stopped") {
      dispatch();
    }
  };

  const hello = (machine: string, held: readonly WorkHeld[]) => {
    clearUnreachable.run(machine);
    const seen = new Set<string>();
    const lost: { ticket: Ticket; attempt: Attempt }[] = [];
    for (const work of held) {
      seen.add(`${work.ticket}:${work.attempt}`);
      const ticket = tickets.get(work.ticket);
      const row = attemptOf(work.ticket, work.attempt);
      const latest = latestOf(work.ticket);
      if (ticket === undefined || row === undefined || row.machine !== machine || isFinal(ticket)) {
        send(machine, { type: "work.stop", ticket: work.ticket, save: false, remove: true });
        continue;
      }
      if (latest === undefined || latest.attempt !== row.attempt) {
        if (latest !== undefined && latest.machine !== machine) {
          send(machine, { type: "work.stop", ticket: work.ticket, save: false, remove: true });
        } else if (work.live) {
          send(machine, { type: "work.stop", ticket: work.ticket, save: false, remove: false });
        }
        continue;
      }
      send(machine, { type: "work.sync", ticket: row.ticket_id, attempt: row.attempt, after: row.last_seq });
      if (isActive(row.state) && !work.live && !work.ended) {
        const task = taskOf(ticket, row);
        if (typeof task !== "string") {
          send(machine, { type: "work.start", task });
        }
      } else if (!isActive(row.state) && work.live) {
        send(machine, { type: "work.stop", ticket: work.ticket, save: false, remove: false });
      }
    }
    for (const value of selectActiveOn.all(machine)) {
      const row = Attempt.parse(value);
      if (seen.has(`${row.ticket_id}:${row.attempt}`)) {
        continue;
      }
      const ticket = tickets.get(row.ticket_id);
      if (ticket === undefined) {
        continue;
      }
      if (row.state === "preparing" && row.last_seq === 0) {
        const task = taskOf(ticket, row);
        if (typeof task !== "string") {
          send(machine, { type: "work.start", task });
        }
        continue;
      }
      lost.push({ ticket, attempt: row });
    }
    for (const { ticket, attempt } of lost) {
      const reason = `The runner on ${machine} came back without this work, so the worker and its session are gone`;
      touch(ticket.id, () => end(ticket.id, attempt.attempt, "failed", "lost", reason));
      failed(ticket, attempt, "lost", reason);
    }
    for (const value of selectActive.all()) {
      const row = Attempt.parse(value);
      if (row.machine === machine) {
        tickets.change((writes) => writes.touched(row.ticket_id));
      }
    }
    dispatch();
  };

  const unsubscribeTickets = tickets.subscribe((ticket) => {
    if (isFinal(ticket) && ticket.kind !== "writing") {
      finish(ticket);
    }
  });

  const unsubscribeRunners = runners.subscribe(() => dispatch());

  runners.bindWork({
    hello: (machine, held) => {
      if (!closed) {
        hello(machine, held);
      }
    },
    event: (machine, message) => {
      if (!closed) {
        apply(machine, message);
      }
    },
    closed: (machine) => {
      if (closed) {
        return;
      }
      const rows = selectActiveOn.all(machine).map((row) => Attempt.parse(row));
      markUnreachable.run(clock.now(), machine);
      for (const row of rows) {
        tickets.change((writes) => writes.touched(row.ticket_id));
      }
      for (const key of [...removalsSent]) {
        if (key.startsWith(`${machine}:`)) {
          removalsSent.delete(key);
        }
      }
    },
  });

  return {
    begin,
    stop: (ticket) => finish(tickets.get(ticket.id) ?? ticket),
    reassign: (given) => {
      const ticket = tickets.get(given.id) ?? given;
      const latest = latestOf(ticket.id);
      if (ticket.state !== "working") {
        return;
      }
      if (latest === undefined) {
        nextAttempt(ticket, null, undefined);
        return;
      }
      const note = latest.machine === ticket.machine
        ? `The owner reassigned this ticket to ${ticket.engine ?? "?"} with ${ticket.model ?? "?"} at ${ticket.effort ?? "?"}. Continue the task from the work already in this folder and on the branch.`
        : `The owner moved this ticket here from ${latest.machine}, now with ${ticket.engine ?? "?"} ${ticket.model ?? "?"} at ${ticket.effort ?? "?"}. The earlier work was pushed to the branch where it could be; continue from there.`;
      nextAttempt(ticket, note, latest);
    },
    again: (id, note) => {
      const ticket = tickets.get(id);
      if (ticket === undefined) {
        return { ok: false, reason: `There is no ticket ${id}` };
      }
      if (ticket.state !== "working" && ticket.state !== "verifying") {
        return { ok: false, reason: `Ticket ${id} is ${ticket.state}` };
      }
      const latest = latestOf(id);
      if (latest !== undefined && (latest.state === "queued" || isActive(latest.state))) {
        return { ok: false, reason: `Ticket ${id} already has a worker` };
      }
      if (ticket.state === "verifying") {
        const moved = tickets.move(id, "working");
        if (!moved.ok) {
          return { ok: false, reason: `Ticket ${id} could not go back to working` };
        }
      }
      try {
        nextAttempt(tickets.get(id) ?? ticket, note, latest);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const now = tickets.get(id);
      return now === undefined ? { ok: false, reason: `There is no ticket ${id}` } : { ok: true, ticket: now };
    },
    message: (id, body, from) => {
      const latest = latestOf(id);
      if (latest === undefined || !isActive(latest.state)) {
        return { ok: false, reason: `Ticket ${id} has no running worker` };
      }
      const messageId = randomUUID();
      if (!send(latest.machine, { type: "work.message", ticket: id, attempt: latest.attempt, id: messageId, from, text: body })) {
        return { ok: false, reason: `The machine ${latest.machine} is not connected, so the worker cannot be reached now` };
      }
      return { ok: true, id: messageId };
    },
    events: (ticket, after = 0, limit = defaultEventLimit) =>
      selectEvents.all(ticket, after, limit).flatMap((row) => {
        const stored = storedOf(row);
        return stored === undefined ? [] : [stored];
      }),
    output: (ticket, limit = 6_000) => {
      const latest = latestOf(ticket);
      return latest === undefined ? "" : outputOf(ticket, latest.attempt, limit);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resume: () => {
      markAllUnreachable.run(clock.now());
      dispatch();
    },
    close: () => {
      closed = true;
      unsubscribeTickets();
      unsubscribeRunners();
      listeners.clear();
    },
  };
}
