import type { GitHubAccount } from "@super-agent2/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { text } from "@super-agent2/catalog";
import {
  activeWorkStates,
  type Attachment,
  attachmentPartBytes,
  type FetchAttachment,
  type FilePart,
  filePartBytes,
  finishedTicketStates,
  type GeneratedText,
  guidanceRefusal,
  type LoopFailure,
  mergedIssueNumbers,
  openIssueNumbers,
  mergedCommit,
  type RunnerWorkEvent,
  StoredWorkEvent,
  type TaskAssignment,
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
import type { Delivery } from "./conversations.js";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import { accountFor } from "./filing.js";
import { createTicketFiles, type TicketFiles } from "./files.js";
import type { FailureReport } from "./failure-loop.js";
import { clip, decisionReport, tail } from "./reports.js";
import type { Runners, WorkMessageToRunner } from "./runners.js";
import type { AttachmentStore } from "./attachments.js";
import { mergedCommitFor, short } from "./task-tickets.js";
import { createWorkerMessages } from "./worker-messages.js";
import type { TicketService, TicketWork } from "./tickets.js";

export type WorkRunners = Pick<Runners, "bindWork" | "sendWork" | "report" | "subscribe">;

export interface WorkServiceOptions {
  readonly accountOf?: (repository: string) => GitHubAccount;
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly tickets: TicketService;
  readonly runners: WorkRunners;
  readonly credentials: CredentialSource;
  readonly tell?: Tell;
  readonly files?: TicketFiles;
  readonly deliver?: (conversation: string | null, delivery: Delivery) => void;
  readonly branchSuffix?: () => string;
  readonly report?: (report: FailureReport) => void;
  readonly attachments?: AttachmentStore;
}

export interface GuidedRound {
  readonly guidance: GeneratedText;
  readonly failure: LoopFailure;
}

export type WorkOutcome = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly reason: string };

export type MessageOutcome = { readonly ok: true; readonly id: string; readonly delivered: boolean } | { readonly ok: false; readonly reason: string };

type DeliveredEvent = Extract<WorkEvent, { readonly kind: "delivered" }>;

interface Fetching {
  readonly attempt: number;
  readonly machine: string;
  readonly event: DeliveredEvent;
  asked: { readonly part: number; readonly offset: number } | undefined;
}

export type WorkListener = (event: StoredWorkEvent) => void;

export interface MergedPiece {
  readonly pullRequest: number;
  readonly mergeCommit: string | null;
  readonly closes: readonly number[];
  readonly base: string;
}

export interface WorkService extends TicketWork {
  begin(ticket: Ticket): void;
  stop(ticket: Ticket): void;
  reassign(ticket: Ticket): void;
  again(ticket: number, note: string, reason?: GeneratedText, round?: GuidedRound): WorkOutcome;
  onward(ticket: number, merged: MergedPiece): WorkOutcome;
  message(ticket: number, text: string, from: WorkSender, attachments?: readonly Attachment[]): MessageOutcome;
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

function taskWords(ticket: Ticket): string {
  if (ticket.repository === null) {
    return "It is a task ticket, worked on in a scratch folder.";
  }
  return `It is a task ticket on ${ticket.repository}${ticket.commit === null ? "" : ` at ${ticket.commit}`}${ticket.deploys ? ", which deploys it" : ""}.`;
}

const failureWords: Readonly<Record<WorkFailure, string>> = {
  prepare: "could not prepare its worktree",
  program: "failed",
  "no-pull-request": "ended without a pull request",
  lost: "was lost",
  "task-failed": "handed back that its task failed",
};

export function createWorkService(options: WorkServiceOptions): WorkService {
  const { tickets, clock, runners } = options;
  const { connection } = options.database;
  const tell: Tell = options.tell ?? (() => undefined);
  const suffix = options.branchSuffix ?? (() => randomBytes(2).toString("hex"));
  const listeners = new Set<WorkListener>();
  const files = options.files ?? createTicketFiles(options.database);
  const removalsSent = new Set<string>();
  const fetching = new Map<number, Fetching>();
  const messages = createWorkerMessages(options.database, clock);
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
    const streamed = new Map<string, string>();
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
      } else if (event.kind === "tool.output") {
        streamed.set(event.call, (streamed.get(event.call) ?? "") + event.delta);
      } else if (event.kind === "tool.finished") {
        const output = event.output ?? streamed.get(event.call) ?? "";
        streamed.delete(event.call);
        if (output !== "") {
          parts.push(`${output}\n`);
        }
      } else if (event.kind === "phase" || event.kind === "failed") {
        parts.push(`\n[${event.kind === "phase" ? event.phase : "failed"}] ${event.kind === "phase" ? event.detail : event.reason}\n`);
      }
    }
    for (const output of streamed.values()) {
      parts.push(`${output}\n`);
    }
    return tail(parts.join(""), limit);
  };

  const failed = (ticket: Ticket, attempt: Attempt, failure: WorkFailure, reason: string) => {
    if (closed) {
      return;
    }
    if (options.report !== undefined) {
      options.report({
        ticket: ticket.id,
        failure: { kind: failure, detail: reason },
        evidence: [
          `The worker of ticket ${ticket.id} (${ticket.title.en}), attempt ${attempt.attempt} on ${attempt.machine} with ${attempt.engine} ${attempt.model} ${attempt.effort}, ${failureWords[failure]}: ${reason}`,
          ticket.form === "task" ? taskWords(ticket) : `Branch: ${ticket.branch ?? "(none)"}; pull request: ${ticket.pullRequest === null ? "none yet" : `#${ticket.pullRequest}`}.`,
          ...(ticket.report === null || failure !== "task-failed" ? [] : [`The worker's report: ${ticket.report.en}`]),
          "The worker's output ends with:",
          outputOf(ticket.id, attempt.attempt, 8_000) || "(no output)",
        ].join("\n"),
      });
      return;
    }
    tell(
      ticket.conversation,
      text("notice.workerFailed", { ticket: ticket.id }),
      [
        `[hub] The worker of ticket ${ticket.id} (${ticket.title.en}) on ${attempt.machine} with ${attempt.engine} ${attempt.model} ${attempt.effort} ${failureWords[failure]}: ${reason}`,
        `The ticket stays working with this failure recorded${ticket.form === "task" ? "" : `, on branch ${ticket.branch ?? "(none)"}`}, and nothing is running for it now.`,
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
    const credentials = options.credentials((options.accountOf ?? accountFor)(ticket.repository));
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
      account: (options.accountOf ?? accountFor)(ticket.repository),
      branch: ticket.branch ?? branchFor(ticket.id, suffix()),
      title: ticket.title.en,
      issues: ticket.issues.map((issue) => ({ number: issue.number, title: issue.title.en, url: issue.url })),
      merged: mergedIssueNumbers(ticket),
      engine: attempt.engine,
      model: attempt.model,
      effort: attempt.effort,
      session: attempt.session ?? attempt.resume_session,
      note: attempt.note,
      environment: { GH_TOKEN: token, GITHUB_TOKEN: token },
    };
  };

  const assignmentOf = (ticket: Ticket, attempt: Attempt): TaskAssignment | string => {
    const task = tickets.task(ticket.id);
    if (task === undefined) {
      return `Ticket ${ticket.id} has no task`;
    }
    let checkout: TaskAssignment["checkout"] = null;
    let environment: Record<string, string> = {};
    if (ticket.repository !== null) {
      const account = (options.accountOf ?? accountFor)(ticket.repository);
      const credentials = options.credentials(account);
      if (!credentials.ok) {
        return credentials.reason;
      }
      const token = credentials.credentials["GH_TOKEN"];
      if (token === undefined) {
        return `There is no GitHub token for ${ticket.repository}`;
      }
      environment = { GH_TOKEN: token, GITHUB_TOKEN: token };
      checkout = {
        repository: ticket.repository,
        account,
        commit: task.commit,
        ref: task.commit !== null || task.commitRef === mergedCommit ? null : task.commitRef,
      };
    }
    return {
      ticket: ticket.id,
      attempt: attempt.attempt,
      title: ticket.title.en,
      task: task.task,
      materials: [...task.materials],
      checkout,
      deploys: task.deploys,
      engine: attempt.engine,
      model: attempt.model,
      effort: attempt.effort,
      session: attempt.session ?? attempt.resume_session,
      note: attempt.note,
      environment,
    };
  };

  const startOf = (ticket: Ticket, attempt: Attempt): WorkMessageToRunner | string => {
    if (ticket.form === "task") {
      const task = assignmentOf(ticket, attempt);
      return typeof task === "string" ? task : { type: "work.task", task };
    }
    const task = taskOf(ticket, attempt);
    return typeof task === "string" ? task : { type: "work.start", task };
  };

  const send = (machine: string, message: WorkMessageToRunner): boolean => {
    try {
      return runners.sendWork(machine, message);
    } catch {
      return false;
    }
  };

  const sendWaiting = (machine: string, ticket: number, attempt: number) => {
    for (const waiting of messages.waiting(ticket)) {
      send(machine, { ...waiting, attempt });
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
      const message = startOf(ticket, attempt);
      if (typeof message === "string") {
        touch(ticket.id, () => end(ticket.id, attempt.attempt, "failed", "prepare", message));
        failed(ticket, attempt, "prepare", message);
        continue;
      }
      if (send(attempt.machine, message)) {
        touch(ticket.id, () => updateStarted.run(clock.now(), ticket.id, attempt.attempt));
        sendWaiting(attempt.machine, ticket.id, attempt.attempt);
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

  const forget = (ticket: number) => {
    const pending = fetching.get(ticket);
    if (pending !== undefined) {
      fetching.delete(ticket);
      files.drop(ticket, pending.attempt);
    }
  };

  const finish = (ticket: Ticket) => {
    forget(ticket.id);
    const latest = latestOf(ticket.id);
    if (latest !== undefined && (latest.state === "queued" || isActive(latest.state))) {
      touch(ticket.id, () => end(ticket.id, latest.attempt, "stopped", null, ticket.stopReason?.en ?? `The ticket is ${ticket.state}`));
    }
    removeEverywhere(ticket);
  };

  const nextAttempt = (
    ticket: Ticket,
    note: string | null,
    previous: Attempt | undefined,
    back?: { readonly reason: GeneratedText | undefined; readonly round: GuidedRound | undefined; readonly branch?: string | undefined },
  ): void => {
    if (ticket.machine === null || ticket.engine === null || ticket.model === null || ticket.effort === null) {
      throw new Error(`Ticket ${ticket.id} has no machine, engine, model and effort chosen`);
    }
    const engine = WorkEngine.safeParse(ticket.engine);
    if (!engine.success) {
      throw new Error(`${ticket.engine} is not an engine for work`);
    }
    if (ticket.form === "code" && engine.data === "antigravity") {
      throw new Error("Antigravity never runs a code ticket; it needs Codex, Claude Code or dsh");
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
      if (back !== undefined) {
        const current = writes.get(ticket.id);
        if (current?.state === "verifying") {
          writes.move(ticket.id, "working", back.reason);
        } else if (current?.state !== "working") {
          throw new Error(`Ticket ${ticket.id} is ${current?.state ?? "gone"} and cannot go back to work`);
        }
        if (back.branch !== undefined) {
          writes.nextPiece(ticket.id, back.branch);
        }
        if (back.round !== undefined) {
          writes.startRound(ticket.id, { failure: back.round.failure, guidance: back.round.guidance, attempt: number });
        }
      }
      if (previous !== undefined && (previous.state === "queued" || isActive(previous.state))) {
        end(ticket.id, previous.attempt, "replaced", null, null);
      }
      if (ticket.branch === null && ticket.form === "code") {
        writes.setBranch(ticket.id, branchFor(ticket.id, suffix()));
      }
      insertAttempt.run(ticket.id, number, machine, engine.data, ticket.model, ticket.effort, resume, note, handover, clock.now());
      writes.touched(ticket.id);
    });
    forget(ticket.id);
    dispatch();
  };

  const settleCommit = (ticket: Ticket): Ticket => {
    if (ticket.form !== "task" || ticket.commitRef !== mergedCommit || ticket.commit !== null) {
      return ticket;
    }
    const commit = mergedCommitFor(ticket, tickets.get);
    if (commit === null) {
      return ticket;
    }
    tickets.change((writes) => writes.setCommit(ticket.id, commit));
    return tickets.get(ticket.id) ?? ticket;
  };

  const begin = (ticket: Ticket) => {
    if (ticket.form === "task") {
      if (tickets.task(ticket.id) === undefined) {
        throw new Error(`Ticket ${ticket.id} has no task`);
      }
    } else if (ticket.repository === null || ticket.issues.length === 0) {
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
    nextAttempt(settleCommit(current), null, undefined);
  };

  const handIn = (ticket: Ticket, event: Extract<WorkEvent, { readonly kind: "delivered" }>) => {
    if (closed || options.deliver === undefined) {
      return;
    }
    const files = event.files.map((file) => ({ name: file.name, size: file.size }));
    const commit = ticket.commit ?? event.commit ?? null;
    options.deliver(ticket.conversation, {
      ticket: ticket.id,
      title: ticket.title,
      text: event.text,
      report: event.report,
      files,
      prompt: [
        `[hub] Task ticket ${ticket.id} (${ticket.title.en}) is done. Its result was delivered to the owner in this conversation: the worker's report${event.text === null ? "" : ", the text as written"}${files.length === 0 ? "" : " and the files as downloads"}, so do not repeat it. Nothing was verified.`,
        ...(ticket.deploys && ticket.repository !== null
          ? [
              `It deployed ${ticket.repository}${commit === null ? "" : ` at ${commit}`}. The hub marks the merged tickets of ${ticket.repository} that ${commit === null ? "it" : short(commit)} contains as deployed, so what was arranged after this deployment begins by itself.`,
            ]
          : ticket.repository === null
            ? []
            : [`It worked on ${ticket.repository}${commit === null ? "" : ` at ${commit}`}.`]),
        `The worker's report: ${event.report.en}`,
        files.length === 0 ? "Files: none." : `Files: ${files.map((file) => `${file.name} (${file.size} bytes)`).join(", ")}.`,
        event.text === null ? "There is no text beyond the report." : `The delivered text:\n${clip(event.text, 20_000)}`,
        "Tell the owner in Chinese, in a line or two, that it is done, and mention anything the worker flagged. If the owner wants changes, open a new task ticket with this result as its material.",
        ...decisionReport(ticket),
      ].join("\n"),
    });
  };

  const complete = (id: number, pending: Fetching) => {
    fetching.delete(id);
    let delivered: Ticket | undefined;
    tickets.change((writes) => {
      const attempt = attemptOf(id, pending.attempt);
      if (attempt !== undefined && isActive(attempt.state)) {
        end(id, pending.attempt, "finished", null, null);
      }
      const ticket = writes.get(id);
      if (ticket !== undefined && ticket.form === "task" && ticket.state === "working") {
        files.keep(id, pending.attempt, pending.event.files);
        writes.setReport(id, pending.event.report);
        delivered = writes.move(id, "delivered");
      }
      writes.touched(id);
    });
    if (delivered !== undefined) {
      handIn(delivered, pending.event);
    }
    dispatch();
  };

  const loseDelivery = (id: number, pending: Fetching, reason: string) => {
    forget(id);
    const ticket = tickets.get(id);
    const attempt = attemptOf(id, pending.attempt);
    if (ticket === undefined || attempt === undefined || !isActive(attempt.state) || isFinal(ticket)) {
      return;
    }
    touch(id, () => end(id, attempt.attempt, "failed", "lost", reason));
    failed(ticket, attempt, "lost", reason);
    dispatch();
  };

  const fetchNext = (id: number) => {
    const pending = fetching.get(id);
    if (pending === undefined || closed || pending.asked !== undefined) {
      return;
    }
    const ticket = tickets.get(id);
    if (latestOf(id)?.attempt !== pending.attempt || ticket === undefined || ticket.form !== "task" || ticket.state !== "working") {
      forget(id);
      return;
    }
    for (const [part, file] of pending.event.files.entries()) {
      let have = files.staged(id, pending.attempt, part);
      if (have > file.size || (have === 0 && file.size === 0)) {
        have = files.append(id, pending.attempt, part, 0, Buffer.alloc(0));
      }
      if (have < file.size) {
        if (send(pending.machine, { type: "work.file", ticket: id, attempt: pending.attempt, name: file.name, offset: have, length: Math.min(filePartBytes, file.size - have) })) {
          pending.asked = { part, offset: have };
        }
        return;
      }
    }
    complete(id, pending);
  };

  const fetchFrom = (id: number, attempt: number, machine: string, event: DeliveredEvent) => {
    const known = fetching.get(id);
    if (known === undefined || known.attempt !== attempt || known.machine !== machine) {
      fetching.set(id, { attempt, machine, event, asked: undefined });
    } else {
      known.asked = undefined;
    }
    fetchNext(id);
  };

  const receivePart = (machine: string, message: FilePart) => {
    const pending = fetching.get(message.ticket);
    if (pending === undefined || pending.machine !== machine || pending.attempt !== message.attempt || pending.asked === undefined) {
      return;
    }
    const asked = pending.asked;
    const file = pending.event.files[asked.part];
    if (file === undefined || file.name !== message.name || asked.offset !== message.offset) {
      return;
    }
    pending.asked = undefined;
    const data = message.data === null ? undefined : Buffer.from(message.data, "base64");
    const expected = Math.min(filePartBytes, file.size - asked.offset);
    if (data === undefined || data.length === 0 || data.length > expected) {
      const why = message.problem ?? (data === undefined || data.length === 0 ? "the file ended before its size" : "it sent more than was asked for");
      loseDelivery(message.ticket, pending, `The runner on ${machine} could not send the delivered file ${file.name} from byte ${asked.offset}: ${why}`);
      return;
    }
    files.append(message.ticket, pending.attempt, asked.part, asked.offset, data);
    fetchNext(message.ticket);
  };

  const serveAttachment = async (machine: string, asked: FetchAttachment) => {
    const reply = (data: string | null, problem: string | null) =>
      send(machine, { type: "work.attachment.part", ticket: asked.ticket, attempt: asked.attempt, attachment: asked.attachment, offset: asked.offset, data, problem });
    const store = options.attachments;
    const attempt = attemptOf(asked.ticket, asked.attempt);
    if (store === undefined || attempt === undefined || attempt.machine !== machine || !store.granted(asked.ticket, asked.attachment) || !store.complete(asked.attachment)) {
      reply(null, `The attachment ${asked.attachment} was not given to ticket ${asked.ticket} on ${machine}`);
      return;
    }
    try {
      const data = await store.read(asked.attachment, asked.offset, Math.min(asked.length, attachmentPartBytes));
      reply(data.toString("base64"), null);
    } catch (error) {
      reply(null, error instanceof Error ? error.message : String(error));
    }
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
    let delivered: Ticket | undefined;
    let fetchFiles = false;
    let id = 0;
    tickets.change((writes) => {
      id = Number(insertEvent.run(attempt.ticket_id, attempt.attempt, message.seq, message.at, JSON.stringify(event)).lastInsertRowid);
      updateSeq.run(message.seq, attempt.ticket_id, attempt.attempt);
      if (event.kind === "message") {
        messages.delivered(attempt.ticket_id, event.id);
      }
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
          if (current && ticket !== undefined && ticket.form === "code") {
            writes.setPullRequest(ticket.id, event.pullRequest, event.report, { url: event.url, closes: event.closes ?? [] });
            writes.recordDecisions(ticket.id, "worker", event.decisions ?? [], { attempt: attempt.attempt, pullRequest: event.pullRequest });
            if (ticket.state === "working") {
              writes.move(ticket.id, "verifying");
            }
          }
          writes.touched(attempt.ticket_id);
          return;
        }
        case "delivered": {
          const ticket = writes.get(attempt.ticket_id);
          const accepted = current && ticket !== undefined && ticket.form === "task" && ticket.state === "working";
          if (current && ticket !== undefined && ticket.form === "task") {
            writes.recordDecisions(ticket.id, "worker", event.decisions ?? [], { attempt: attempt.attempt });
          }
          if (accepted && event.commit !== undefined && ticket.commit === null) {
            writes.setCommit(ticket.id, event.commit);
          }
          if (event.outcome === "failed") {
            if (accepted) {
              writes.setReport(ticket.id, event.report);
            }
            if (live) {
              end(attempt.ticket_id, attempt.attempt, "failed", "task-failed", event.report.en);
              if (current) {
                told = { failure: "task-failed", reason: event.report.en };
              }
            }
            writes.touched(attempt.ticket_id);
            return;
          }
          if (accepted && event.files.length > 0) {
            fetchFiles = true;
            writes.touched(attempt.ticket_id);
            return;
          }
          if (live) {
            end(attempt.ticket_id, attempt.attempt, "finished", null, null);
          }
          if (accepted) {
            writes.setReport(ticket.id, event.report);
            delivered = writes.move(ticket.id, "delivered");
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
    if (delivered !== undefined && event.kind === "delivered") {
      handIn(delivered, event);
    }
    if (fetchFiles && event.kind === "delivered" && event.outcome !== "failed") {
      fetchFrom(attempt.ticket_id, attempt.attempt, machine, event);
    }
    if (told !== undefined) {
      const ticket = tickets.get(attempt.ticket_id);
      const now = attemptOf(attempt.ticket_id, attempt.attempt);
      if (ticket !== undefined && now !== undefined && !isFinal(ticket)) {
        failed(ticket, now, told.failure, told.reason);
      }
    }
    if (handedOver || event.kind === "finished" || event.kind === "delivered" || event.kind === "failed" || event.kind === "stopped") {
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
        const message = startOf(ticket, row);
        if (typeof message !== "string") {
          send(machine, message);
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
        const message = startOf(ticket, row);
        if (typeof message !== "string") {
          send(machine, message);
        }
        continue;
      }
      lost.push({ ticket, attempt: row });
    }
    for (const { ticket, attempt } of lost) {
      const reason = `The runner on ${machine} came back without this work, so the worker and its session are gone`;
      forget(ticket.id);
      touch(ticket.id, () => end(ticket.id, attempt.attempt, "failed", "lost", reason));
      failed(ticket, attempt, "lost", reason);
    }
    for (const value of selectActiveOn.all(machine)) {
      const row = Attempt.parse(value);
      const last = selectRecent.all(row.ticket_id, row.attempt, 1).map(storedOf)[0]?.event;
      if (last?.kind === "delivered" && last.outcome !== "failed" && last.files.length > 0 && latestOf(row.ticket_id)?.attempt === row.attempt) {
        fetchFrom(row.ticket_id, row.attempt, machine, last);
      }
    }
    for (const value of selectActive.all()) {
      const row = Attempt.parse(value);
      if (row.machine === machine) {
        tickets.change((writes) => writes.touched(row.ticket_id));
      }
    }
    for (const value of selectActiveOn.all(machine)) {
      const row = Attempt.parse(value);
      if (latestOf(row.ticket_id)?.attempt === row.attempt) {
        sendWaiting(machine, row.ticket_id, row.attempt);
      }
    }
    dispatch();
  };

  const unsubscribeTickets = tickets.subscribe((ticket) => {
    if (isFinal(ticket)) {
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
    part: (machine, message) => {
      if (!closed) {
        receivePart(machine, message);
      }
    },
    attachment: (machine, message) => {
      if (!closed) {
        void serveAttachment(machine, message);
      }
    },
    closed: (machine) => {
      if (closed) {
        return;
      }
      const rows = selectActiveOn.all(machine).map((row) => Attempt.parse(row));
      markUnreachable.run(clock.now(), machine);
      for (const pending of fetching.values()) {
        if (pending.machine === machine) {
          pending.asked = undefined;
        }
      }
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
    again: (id, note, reason, round) => {
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
      if (round !== undefined) {
        const refusal = guidanceRefusal(ticket);
        if (refusal !== null) {
          return { ok: false, reason: `Ticket ${id} cannot have a guided round now (${refusal})` };
        }
      }
      try {
        nextAttempt(ticket, note, latest, { reason, round });
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const now = tickets.get(id);
      return now === undefined ? { ok: false, reason: `There is no ticket ${id}` } : { ok: true, ticket: now };
    },
    onward: (id, merged) => {
      const ticket = tickets.get(id);
      if (ticket === undefined) {
        return { ok: false, reason: `There is no ticket ${id}` };
      }
      if (ticket.state !== "verifying") {
        return { ok: false, reason: `Ticket ${id} is ${ticket.state}` };
      }
      const latest = latestOf(id);
      if (latest !== undefined && (latest.state === "queued" || isActive(latest.state))) {
        return { ok: false, reason: `Ticket ${id} already has a worker` };
      }
      const open = new Set(openIssueNumbers(ticket));
      const remaining = ticket.issues.filter((issue) => open.has(issue.number));
      if (remaining.length === 0) {
        return { ok: false, reason: `Every issue of ticket ${id} is closed by a merged pull request` };
      }
      const branch = branchFor(id, suffix());
      const done = ticket.issues.filter((issue) => !open.has(issue.number));
      const closes = ticket.issues.filter((issue) => merged.closes.includes(issue.number));
      const note = [
        `Pull request #${merged.pullRequest} is merged into ${merged.base}${merged.mergeCommit === null ? "" : ` as commit ${merged.mergeCommit}`}. ${closes.length === 0 ? "It closed no issue of the chain." : `It closed ${closes.map((issue) => `#${issue.number}`).join(", ")}.`}`,
        `Closed so far: ${done.length === 0 ? "none" : done.map((issue) => `#${issue.number}`).join(", ")}. Still open, in working order:`,
        ...remaining.map((issue) => `- #${issue.number} ${issue.title.en} (${issue.url})`),
        `Your folder is now on a new branch, ${branch}, made from the updated ${merged.base}, which contains the merge. Continue with the open issues: open the next pull request from this branch and hand it in as before.`,
      ].join("\n");
      const numbers = remaining.map((issue) => `#${issue.number}`);
      const reason = {
        en: `Pull request #${merged.pullRequest} merged; the worker continues with ${numbers.join(", ")}`,
        zh: text("ticket.reason.nextPiece", { pullRequest: merged.pullRequest, issues: numbers.join("、") }),
      };
      try {
        nextAttempt(ticket, note, latest, { reason, round: undefined, branch });
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const now = tickets.get(id);
      return now === undefined ? { ok: false, reason: `There is no ticket ${id}` } : { ok: true, ticket: now };
    },
    message: (id, body, from, attachments = []) => {
      const latest = latestOf(id);
      const state = tickets.get(id)?.state;
      const active = latest !== undefined && isActive(latest.state);
      const between = state === "working" || state === "verifying";
      if (latest === undefined || (!active && !between)) {
        return { ok: false, reason: `Ticket ${id} has no running worker` };
      }
      const message: WorkMessageToRunner = { type: "work.message", ticket: id, attempt: latest.attempt, id: randomUUID(), from, text: body, ...(attachments.length === 0 ? {} : { attachments: [...attachments] }) };
      options.attachments?.grant(id, attachments);
      messages.add(message);
      return { ok: true, id: message.id, delivered: active && send(latest.machine, message) };
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
