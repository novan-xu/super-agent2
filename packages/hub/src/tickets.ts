import {
  canMoveTicket,
  capReached,
  countsAsRound,
  cursorAt,
  finishedTicketStates,
  type HistoryCursor,
  type HistoryPosition,
  historyPageSize,
  searchTerms,
  LoopFailure,
  LoopFailureKind,
  roundCap,
  StuckFrom,
  TicketRound,
  type TicketStuck,
  ChosenBy,
  type Difficulty,
  GeneratedText,
  openTicketStates,
  type Platform,
  RepositoryName,
  Ticket,
  type TicketDetail,
  TicketIssue,
  type TicketKind,
  TicketMove,
  TicketRun,
  type TicketState,
  type OwnerChoice,
  type ProgramId,
  WorkStatus,
  WritingMaterial,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { verificationOf } from "./verification-record.js";

export interface TicketWriting {
  readonly task: string;
  readonly materials: readonly WritingMaterial[];
}

export interface TicketToOpen {
  readonly writing?: TicketWriting | undefined;
  readonly repository: string | null;
  readonly issues: readonly TicketIssue[];
  readonly title: GeneratedText;
  readonly summary: GeneratedText;
  readonly kind: TicketKind;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
  readonly waitsFor?: readonly number[] | undefined;
  readonly conversation?: string | undefined;
}

export interface TicketDescription {
  readonly title: GeneratedText;
  readonly summary: GeneratedText;
  readonly kind: TicketKind;
  readonly difficulty: Difficulty | null;
  readonly platform: Platform | null;
}

export interface DefaultsStatement {
  readonly kind: TicketKind;
  readonly difficulty: Difficulty | null;
  readonly difficultyReason: GeneratedText;
  readonly platform: Platform;
  readonly brainEngine: ProgramId | null;
}

export interface ChosenRun {
  readonly machine: string;
  readonly engine: ProgramId;
  readonly model: string;
  readonly effort: string;
  readonly by: ChosenBy;
}

export interface WaitToSet {
  readonly ticket: number;
  readonly deployment: boolean;
}

export type MoveError = "not_found" | "refused";

export type MoveResult = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly error: MoveError; readonly ticket?: Ticket };

export interface ListOptions {
  readonly open?: boolean;
  readonly limit?: number;
}

export interface HistoryOptions {
  readonly query?: string;
  readonly before?: HistoryPosition;
  readonly limit?: number;
}

export interface HistoryPage {
  readonly tickets: Ticket[];
  readonly next: HistoryCursor | null;
}

export type TicketListener = (ticket: Ticket) => void;

export interface TicketWork {
  begin(ticket: Ticket): void | Promise<void>;
  stop(ticket: Ticket): void;
  reassign?(ticket: Ticket): void | Promise<void>;
}

export const noTicketWork: TicketWork = { begin: () => undefined, stop: () => undefined };

export interface RoundToStart {
  readonly failure: LoopFailure;
  readonly guidance: GeneratedText;
  readonly attempt: number;
}

export interface TicketWrites {
  get(id: number): Ticket | undefined;
  open(request: TicketToOpen): number;
  setIssues(id: number, issues: readonly TicketIssue[]): void;
  describe(id: number, description: TicketDescription): void;
  setWaits(id: number, waits: readonly WaitToSet[]): void;
  redirectWaits(from: number, to: number): void;
  waive(id: number, before: number): boolean;
  deployed(id: number): void;
  move(id: number, to: TicketState, reason?: GeneratedText): Ticket;
  join(id: number, into: number, reason: GeneratedText): Ticket;
  touched(id: number): void;
  state(id: number, statement: DefaultsStatement): void;
  forgetDefaults(id: number): void;
  ownerChoice(id: number, choice: OwnerChoice): void;
  choose(id: number, chosen: ChosenRun): void;
  ran(id: number, run: TicketRun): void;
  setBranch(id: number, branch: string): void;
  setPullRequest(id: number, pullRequest: number, report: GeneratedText): void;
  setReport(id: number, report: GeneratedText): void;
  startRound(id: number, round: RoundToStart): TicketRound;
  stick(id: number, failure: LoopFailure): Ticket;
  describeStuck(id: number, where: GeneratedText): Ticket;
  resume(id: number, reason: GeneratedText): Ticket;
}

export interface TicketService {
  open(request: TicketToOpen): Ticket;
  get(id: number): Ticket | undefined;
  list(options?: ListOptions): Ticket[];
  history(options?: HistoryOptions): HistoryPage;
  moves(id: number): TicketMove[];
  detail(id: number): TicketDetail | undefined;
  rounds(id: number): TicketRound[];
  writing(id: number): TicketWriting | undefined;
  forIssue(repository: string, number: number): Ticket[];
  waitingFor(id: number): Ticket[];
  move(id: number, to: TicketState, reason?: GeneratedText): MoveResult;
  stop(id: number, reason: GeneratedText): MoveResult;
  change<T>(body: (writes: TicketWrites) => T): T;
  subscribe(listener: TicketListener): () => void;
}

export interface TicketServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly work?: TicketWork;
}

export class TicketError extends Error {}

const TicketRow = z.object({
  id: z.number().int(),
  repository: z.string().nullable(),
  kind: z.string(),
  title_en: z.string(),
  title_zh: z.string(),
  summary_en: z.string(),
  summary_zh: z.string(),
  difficulty: z.string().nullable(),
  difficulty_reason_en: z.string().nullable(),
  difficulty_reason_zh: z.string().nullable(),
  platform: z.string().nullable(),
  brain_engine: z.string().nullable(),
  owner_machine: z.string().nullable(),
  owner_engine: z.string().nullable(),
  owner_model: z.string().nullable(),
  owner_effort: z.string().nullable(),
  chosen_by: z.string().nullable(),
  chosen_at: z.number().int().nullable(),
  ran: z.string().nullable(),
  state: z.string(),
  machine: z.string().nullable(),
  engine: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  branch: z.string().nullable(),
  pull_request: z.number().int().nullable(),
  report_en: z.string().nullable(),
  report_zh: z.string().nullable(),
  round: z.number().int(),
  free_retry: z.number().int(),
  stuck_at: z.number().int().nullable(),
  stuck_round: z.number().int().nullable(),
  stuck_from: z.string().nullable(),
  stuck_failure: z.string().nullable(),
  stuck_detail: z.string().nullable(),
  stuck_where_en: z.string().nullable(),
  stuck_where_zh: z.string().nullable(),
  stop_reason_en: z.string().nullable(),
  stop_reason_zh: z.string().nullable(),
  joined_into: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
  conversation_id: z.string().nullable(),
  deployed_at: z.number().int().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

const IssueRow = z.object({
  repository: z.string(),
  number: z.number().int(),
  url: z.string(),
  title_en: z.string(),
  title_zh: z.string(),
  summary_en: z.string(),
  summary_zh: z.string(),
});

const WaitRow = z.object({ waits_for: z.number().int(), deployment: z.number().int(), waived_at: z.number().int().nullable() });

const BeginRow = z.object({ failure: z.string().nullable() });

const AttemptRow = z.object({
  attempt: z.number().int(),
  state: z.string(),
  machine: z.string(),
  engine: z.string(),
  model: z.string(),
  effort: z.string(),
  session: z.string().nullable(),
  failure: z.string().nullable(),
  reason: z.string().nullable(),
  unreachable_since: z.number().int().nullable(),
  last_seq: z.number().int(),
  created_at: z.number().int(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
});

export function workStatusOf(row: unknown): WorkStatus {
  const value = AttemptRow.parse(row);
  return WorkStatus.parse({
    attempt: value.attempt,
    state: value.state,
    machine: value.machine,
    engine: value.engine,
    model: value.model,
    effort: value.effort,
    session: value.session,
    failure: value.failure,
    reason: value.reason,
    unreachableSince: value.unreachable_since,
    last: value.last_seq,
    createdAt: value.created_at,
    startedAt: value.started_at,
    endedAt: value.ended_at,
  });
}

const MoveRow = z.object({
  ticket_id: z.number().int(),
  seq: z.number().int(),
  from_state: z.string().nullable(),
  to_state: z.string(),
  reason_en: z.string().nullable(),
  reason_zh: z.string().nullable(),
  at: z.number().int(),
});

const IdRow = z.object({ ticket_id: z.number().int() });

const FoundRow = z.object({ id: z.number().int() });

const WritingRow = z.object({ task: z.string(), materials: z.string() });

const SeqRow = z.object({ seq: z.number().int().nullable() });

const RoundRow = z.object({
  seq: z.number().int(),
  round: z.number().int().nullable(),
  attempt: z.number().int(),
  failure: z.string(),
  detail: z.string(),
  guidance_en: z.string(),
  guidance_zh: z.string(),
  at: z.number().int(),
});

function roundOf(row: unknown): TicketRound {
  const value = RoundRow.parse(row);
  return TicketRound.parse({
    seq: value.seq,
    round: value.round,
    attempt: value.attempt,
    failure: { kind: value.failure, detail: value.detail },
    guidance: { en: value.guidance_en, zh: value.guidance_zh },
    at: value.at,
  });
}

function stuckOf(row: z.infer<typeof TicketRow>): TicketStuck | null {
  if (row.state !== "stuck" || row.stuck_at === null || row.stuck_from === null || row.stuck_failure === null) {
    return null;
  }
  return {
    at: row.stuck_at,
    round: row.stuck_round ?? row.round,
    from: StuckFrom.parse(row.stuck_from),
    failure: { kind: LoopFailureKind.parse(row.stuck_failure), detail: row.stuck_detail ?? "" },
    where: pair(row.stuck_where_en, row.stuck_where_zh),
  };
}

function pair(en: string | null, zh: string | null): GeneratedText | null {
  return en === null || zh === null ? null : { en, zh };
}

function parsedJson(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const defaultLimit = 200;

const issueTexts = "i.title_en || char(10) || i.title_zh || char(10) || i.summary_en || char(10) || i.summary_zh";

const searchedText = `t.title_en || char(10) || t.title_zh || char(10) || t.summary_en || char(10) || t.summary_zh || char(10) || COALESCE(t.repository, '') || char(10) || COALESCE((SELECT w.task FROM ticket_writing w WHERE w.ticket_id = t.id), '') || char(10) || COALESCE((SELECT group_concat(${issueTexts}, char(10)) FROM ticket_issues i WHERE i.ticket_id = t.id), '')`;

const escapeCharacter = "\\";

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `${escapeCharacter}${character}`)}%`;
}

export function createTicketService(options: TicketServiceOptions): TicketService {
  const { connection } = options.database;
  const { clock } = options;
  const work = options.work ?? noTicketWork;
  const listeners = new Set<TicketListener>();
  let inside = false;

  const selectTicket = connection.prepare("SELECT * FROM tickets WHERE id = ?");
  const selectIssues = connection.prepare("SELECT * FROM ticket_issues WHERE ticket_id = ? ORDER BY position");
  const selectWaits = connection.prepare("SELECT waits_for, deployment, waived_at FROM ticket_waits WHERE ticket_id = ? ORDER BY waits_for");
  const selectBegin = connection.prepare("SELECT failure FROM ticket_begins WHERE ticket_id = ? AND failed_at IS NOT NULL AND done_at IS NULL");
  const selectMoves = connection.prepare("SELECT * FROM ticket_moves WHERE ticket_id = ? ORDER BY seq");
  const selectAttempt = connection.prepare("SELECT * FROM ticket_attempts WHERE ticket_id = ? ORDER BY attempt DESC LIMIT 1");
  const selectAttempts = connection.prepare("SELECT * FROM ticket_attempts WHERE ticket_id = ? ORDER BY attempt");
  const selectVerification = connection.prepare("SELECT * FROM ticket_verifications WHERE ticket_id = ?");
  const updateBranch = connection.prepare("UPDATE tickets SET branch = ? WHERE id = ?");
  const updatePullRequest = connection.prepare("UPDATE tickets SET pull_request = ?, report_en = ?, report_zh = ? WHERE id = ?");
  const updateReport = connection.prepare("UPDATE tickets SET report_en = ?, report_zh = ? WHERE id = ?");
  const selectWriting = connection.prepare("SELECT task, materials FROM ticket_writing WHERE ticket_id = ?");
  const insertWriting = connection.prepare("INSERT INTO ticket_writing (ticket_id, task, materials) VALUES (?, ?, ?)");
  const selectLastSeq = connection.prepare("SELECT MAX(seq) AS seq FROM ticket_moves WHERE ticket_id = ?");
  const selectAll = connection.prepare("SELECT * FROM tickets ORDER BY created_at DESC, id DESC LIMIT ?");
  const selectOpen = connection.prepare(
    `SELECT * FROM tickets WHERE state IN (${openTicketStates.map(() => "?").join(", ")}) ORDER BY created_at DESC, id DESC LIMIT ?`,
  );
  const selectByIssue = connection.prepare("SELECT DISTINCT ticket_id FROM ticket_issues WHERE repository = ? AND number = ? ORDER BY ticket_id");
  const selectWaitingFor = connection.prepare("SELECT ticket_id FROM ticket_waits WHERE waits_for = ? ORDER BY ticket_id");
  const insertTicket = connection.prepare(
    `INSERT INTO tickets (repository, kind, title_en, title_zh, summary_en, summary_zh, difficulty, platform, state, conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  );
  const insertIssue = connection.prepare(
    "INSERT INTO ticket_issues (ticket_id, position, repository, number, url, title_en, title_zh, summary_en, summary_zh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const deleteIssues = connection.prepare("DELETE FROM ticket_issues WHERE ticket_id = ?");
  const insertWait = connection.prepare("INSERT INTO ticket_waits (ticket_id, waits_for, deployment) VALUES (?, ?, ?)");
  const deleteWaits = connection.prepare("DELETE FROM ticket_waits WHERE ticket_id = ?");
  const selectRedirected = connection.prepare(
    "SELECT w.ticket_id, w.deployment FROM ticket_waits w JOIN tickets t ON t.id = w.ticket_id WHERE w.waits_for = ? AND t.state = 'pending'",
  );
  const deleteWait = connection.prepare("DELETE FROM ticket_waits WHERE ticket_id = ? AND waits_for = ?");
  const upsertWait = connection.prepare(
    "INSERT INTO ticket_waits (ticket_id, waits_for, deployment) VALUES (?, ?, ?) ON CONFLICT (ticket_id, waits_for) DO UPDATE SET deployment = MAX(deployment, excluded.deployment)",
  );
  const waiveWait = connection.prepare("UPDATE ticket_waits SET waived_at = ? WHERE ticket_id = ? AND waits_for = ? AND waived_at IS NULL");
  const updateDescription = connection.prepare(
    "UPDATE tickets SET title_en = ?, title_zh = ?, summary_en = ?, summary_zh = ?, kind = ?, difficulty = ?, platform = ? WHERE id = ?",
  );
  const updateDeployed = connection.prepare("UPDATE tickets SET deployed_at = ? WHERE id = ? AND deployed_at IS NULL");
  const updateTouched = connection.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?");
  const insertMove = connection.prepare(
    "INSERT INTO ticket_moves (ticket_id, seq, from_state, to_state, reason_en, reason_zh, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const updateState = connection.prepare("UPDATE tickets SET state = ?, updated_at = ? WHERE id = ? AND state = ?");
  const updateEnded = connection.prepare("UPDATE tickets SET ended_at = ? WHERE id = ?");
  const updateJoined = connection.prepare("UPDATE tickets SET joined_into = ? WHERE id = ?");
  const updateStopReason = connection.prepare("UPDATE tickets SET stop_reason_en = ?, stop_reason_zh = ? WHERE id = ?");
  const updateStatement = connection.prepare(
    "UPDATE tickets SET kind = ?, difficulty = ?, difficulty_reason_en = ?, difficulty_reason_zh = ?, platform = ?, brain_engine = ? WHERE id = ?",
  );
  const clearDefaults = connection.prepare(
    "UPDATE tickets SET difficulty_reason_en = NULL, difficulty_reason_zh = NULL, brain_engine = NULL, owner_machine = NULL, owner_engine = NULL, owner_model = NULL, owner_effort = NULL WHERE id = ?",
  );
  const updateOwnerChoice = connection.prepare("UPDATE tickets SET owner_machine = ?, owner_engine = ?, owner_model = ?, owner_effort = ? WHERE id = ?");
  const updateChosen = connection.prepare("UPDATE tickets SET machine = ?, engine = ?, model = ?, effort = ?, chosen_by = ?, chosen_at = ? WHERE id = ?");
  const updateRan = connection.prepare("UPDATE tickets SET ran = ? WHERE id = ?");
  const selectRounds = connection.prepare("SELECT * FROM ticket_rounds WHERE ticket_id = ? ORDER BY seq");
  const selectLastRound = connection.prepare("SELECT MAX(seq) AS seq FROM ticket_rounds WHERE ticket_id = ?");
  const insertRound = connection.prepare(
    "INSERT INTO ticket_rounds (ticket_id, seq, round, attempt, failure, detail, guidance_en, guidance_zh, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateRound = connection.prepare("UPDATE tickets SET round = ?, free_retry = ? WHERE id = ?");
  const updateStuck = connection.prepare(
    "UPDATE tickets SET stuck_at = ?, stuck_round = ?, stuck_from = ?, stuck_failure = ?, stuck_detail = ?, stuck_where_en = NULL, stuck_where_zh = NULL WHERE id = ?",
  );
  const updateStuckWhere = connection.prepare("UPDATE tickets SET stuck_where_en = ?, stuck_where_zh = ? WHERE id = ?");
  const clearStuck = connection.prepare(
    "UPDATE tickets SET round = 0, free_retry = 0, stuck_at = NULL, stuck_round = NULL, stuck_from = NULL, stuck_failure = NULL, stuck_detail = NULL, stuck_where_en = NULL, stuck_where_zh = NULL WHERE id = ?",
  );

  const toTicket = (row: unknown): Ticket => {
    const value = TicketRow.parse(row);
    const issues = selectIssues.all(value.id).map((entry) => {
      const issue = IssueRow.parse(entry);
      return {
        repository: issue.repository,
        number: issue.number,
        url: issue.url,
        title: { en: issue.title_en, zh: issue.title_zh },
        summary: { en: issue.summary_en, zh: issue.summary_zh },
      };
    });
    const waits = selectWaits.all(value.id).map((entry) => {
      const wait = WaitRow.parse(entry);
      return { ticket: wait.waits_for, deployment: wait.deployment === 1, waived: wait.waived_at !== null };
    });
    const begin = selectBegin.get(value.id);
    const attempt = selectAttempt.get(value.id);
    const verification = selectVerification.get(value.id);
    return Ticket.parse({
      id: value.id,
      repository: value.repository,
      issues,
      title: { en: value.title_en, zh: value.title_zh },
      summary: { en: value.summary_en, zh: value.summary_zh },
      kind: value.kind,
      difficulty: value.difficulty,
      difficultyReason: pair(value.difficulty_reason_en, value.difficulty_reason_zh),
      platform: value.platform,
      brainEngine: value.brain_engine,
      ownerChoice: { machine: value.owner_machine, engine: value.owner_engine, model: value.owner_model, effort: value.owner_effort },
      state: value.state,
      machine: value.machine,
      engine: value.engine,
      model: value.model,
      effort: value.effort,
      chosenBy: ChosenBy.nullable().catch(null).parse(parsedJson(value.chosen_by)),
      chosenAt: value.chosen_at,
      ran: TicketRun.nullable().catch(null).parse(parsedJson(value.ran)),
      branch: value.branch,
      pullRequest: value.pull_request,
      report: pair(value.report_en, value.report_zh),
      work: attempt === undefined ? null : workStatusOf(attempt),
      verification: verification === undefined ? null : verificationOf(verification),
      round: value.round,
      freeRetry: value.free_retry === 1,
      stuck: stuckOf(value),
      waitsFor: waits.map((wait) => wait.ticket),
      waits,
      deployedAt: value.deployed_at,
      beginFailure: begin === undefined ? null : BeginRow.parse(begin).failure,
      stopReason: pair(value.stop_reason_en, value.stop_reason_zh),
      joinedInto: value.joined_into,
      conversation: value.conversation_id,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      endedAt: value.ended_at,
    });
  };

  const get = (id: number): Ticket | undefined => {
    const row = selectTicket.get(id);
    return row === undefined ? undefined : toTicket(row);
  };

  const movesOf = (id: number): TicketMove[] =>
    selectMoves.all(id).map((row) => {
      const value = MoveRow.parse(row);
      return TicketMove.parse({
        ticket: value.ticket_id,
        seq: value.seq,
        from: value.from_state,
        to: value.to_state,
        reason: pair(value.reason_en, value.reason_zh),
        at: value.at,
      });
    });

  const recordMove = (id: number, from: TicketState | null, to: TicketState, reason: GeneratedText | undefined, at: number) => {
    const last = SeqRow.parse(selectLastSeq.get(id)).seq ?? 0;
    insertMove.run(id, last + 1, from, to, reason?.en ?? null, reason?.zh ?? null, at);
  };

  const announce = (ticket: Ticket) => {
    for (const listener of listeners) {
      try {
        listener(ticket);
      } catch {
        continue;
      }
    }
  };

  const check = (request: TicketToOpen) => {
    if (request.writing !== undefined && request.kind !== "writing") {
      throw new TicketError("Only a writing ticket has a writing task");
    }
    if (request.kind === "writing") {
      if (request.repository !== null || request.issues.length > 0) {
        throw new TicketError("A writing ticket has no repository and no issues");
      }
      if (request.writing !== undefined) {
        z.array(WritingMaterial).parse(request.writing.materials);
        if (request.writing.task.trim() === "") {
          throw new TicketError("A writing ticket needs its task");
        }
      }
    } else {
      if (request.repository === null || !RepositoryName.safeParse(request.repository).success) {
        throw new TicketError("A ticket for code work needs its repository as owner/name");
      }
      if (request.issues.length === 0) {
        throw new TicketError("A ticket for code work needs at least one issue");
      }
    }
    checkIssues(request.repository, request.issues);
    GeneratedText.parse(request.title);
    GeneratedText.parse(request.summary);
    for (const before of request.waitsFor ?? []) {
      if (get(before) === undefined) {
        throw new TicketError(`There is no ticket ${before} to wait for`);
      }
    }
  };

  const writingOf = (id: number): TicketWriting | undefined => {
    const row = selectWriting.get(id);
    if (row === undefined) {
      return undefined;
    }
    const value = WritingRow.parse(row);
    return { task: value.task, materials: z.array(WritingMaterial).parse(JSON.parse(value.materials)) };
  };

  const checkIssues = (repository: string | null, issues: readonly TicketIssue[]) => {
    const numbers = new Set<number>();
    for (const issue of issues) {
      TicketIssue.parse(issue);
      if (issue.repository !== repository) {
        throw new TicketError(`Issue #${issue.number} is in ${issue.repository}, not in the ticket's repository ${repository ?? ""}`);
      }
      if (numbers.has(issue.number)) {
        throw new TicketError(`Issue #${issue.number} is listed twice`);
      }
      numbers.add(issue.number);
    }
  };

  const insertIssues = (id: number, issues: readonly TicketIssue[]) => {
    issues.forEach((issue, position) => {
      insertIssue.run(id, position, issue.repository, issue.number, issue.url, issue.title.en.trim(), issue.title.zh.trim(), issue.summary.en.trim(), issue.summary.zh.trim());
    });
  };

  const change = <T>(body: (writes: TicketWrites) => T): T => {
    if (inside) {
      throw new Error("Ticket changes do not nest");
    }
    const touched = new Set<number>();
    const touch = (id: number) => {
      updateTouched.run(clock.now(), id);
      touched.add(id);
    };
    const existing = (id: number): Ticket => {
      const ticket = get(id);
      if (ticket === undefined) {
        throw new TicketError(`There is no ticket ${id}`);
      }
      return ticket;
    };
    const writes: TicketWrites = {
      get,
      open: (request) => {
        check(request);
        const now = clock.now();
        const result = insertTicket.run(
          request.repository,
          request.kind,
          request.title.en.trim(),
          request.title.zh.trim(),
          request.summary.en.trim(),
          request.summary.zh.trim(),
          request.difficulty ?? null,
          request.platform ?? null,
          request.conversation ?? null,
          now,
          now,
        );
        const id = Number(result.lastInsertRowid);
        insertIssues(id, request.issues);
        if (request.writing !== undefined) {
          insertWriting.run(id, request.writing.task.trim(), JSON.stringify(request.writing.materials));
        }
        for (const before of new Set(request.waitsFor ?? [])) {
          insertWait.run(id, before, 0);
        }
        recordMove(id, null, "pending", undefined, now);
        touched.add(id);
        return id;
      },
      setIssues: (id, issues) => {
        const ticket = existing(id);
        checkIssues(ticket.repository, issues);
        deleteIssues.run(id);
        insertIssues(id, issues);
        touch(id);
      },
      describe: (id, description) => {
        existing(id);
        const title = GeneratedText.parse(description.title);
        const summary = GeneratedText.parse(description.summary);
        updateDescription.run(title.en, title.zh, summary.en, summary.zh, description.kind, description.difficulty, description.platform, id);
        touch(id);
      },
      setWaits: (id, waits) => {
        existing(id);
        deleteWaits.run(id);
        const seen = new Set<number>();
        for (const wait of waits) {
          if (wait.ticket === id) {
            throw new TicketError(`Ticket ${id} cannot wait for itself`);
          }
          existing(wait.ticket);
          if (!seen.has(wait.ticket)) {
            seen.add(wait.ticket);
            insertWait.run(id, wait.ticket, wait.deployment ? 1 : 0);
          }
        }
        touch(id);
      },
      redirectWaits: (from, to) => {
        for (const row of selectRedirected.all(from)) {
          const value = z.object({ ticket_id: z.number().int(), deployment: z.number().int() }).parse(row);
          deleteWait.run(value.ticket_id, from);
          if (value.ticket_id !== to) {
            upsertWait.run(value.ticket_id, to, value.deployment);
          }
          touch(value.ticket_id);
        }
      },
      waive: (id, before) => {
        const changed = waiveWait.run(clock.now(), id, before).changes > 0;
        if (changed) {
          touch(id);
        }
        return changed;
      },
      deployed: (id) => {
        updateDeployed.run(clock.now(), id);
        touch(id);
      },
      move: (id, to, reason) => {
        const current = existing(id);
        if (!canMoveTicket(current.kind, current.state, to)) {
          throw new TicketError(`Ticket ${id} is ${current.state} and cannot become ${to}`);
        }
        const now = clock.now();
        updateState.run(to, now, id, current.state);
        recordMove(id, current.state, to, reason, now);
        if (to === "stopped" && reason !== undefined) {
          updateStopReason.run(reason.en, reason.zh, id);
        }
        if (finishedTicketStates.includes(to)) {
          updateEnded.run(now, id);
        }
        touched.add(id);
        return existing(id);
      },
      join: (id, into, reason) => {
        existing(into);
        if (into === id) {
          throw new TicketError(`Ticket ${id} cannot join itself`);
        }
        const ticket = writes.move(id, "stopped", reason);
        updateJoined.run(into, id);
        return ticket;
      },
      touched: (id) => touch(id),
      state: (id, statement) => {
        const current = existing(id);
        const reason = GeneratedText.parse(statement.difficultyReason);
        if ((statement.kind === "writing") !== (current.kind === "writing")) {
          throw new TicketError(`Ticket ${id} is ${current.kind === "writing" ? "writing" : "code work"} and cannot become ${statement.kind}`);
        }
        updateStatement.run(statement.kind, statement.difficulty, reason.en, reason.zh, statement.platform, statement.brainEngine, id);
        touch(id);
      },
      forgetDefaults: (id) => {
        existing(id);
        clearDefaults.run(id);
        touch(id);
      },
      ownerChoice: (id, choice) => {
        existing(id);
        updateOwnerChoice.run(choice.machine, choice.engine, choice.model, choice.effort, id);
        touch(id);
      },
      choose: (id, chosen) => {
        existing(id);
        updateChosen.run(chosen.machine, chosen.engine, chosen.model, chosen.effort, JSON.stringify(ChosenBy.parse(chosen.by)), clock.now(), id);
        touch(id);
      },
      ran: (id, run) => {
        existing(id);
        updateRan.run(JSON.stringify(TicketRun.parse(run)), id);
        touch(id);
      },
      setBranch: (id, branch) => {
        existing(id);
        updateBranch.run(branch, id);
        touch(id);
      },
      setPullRequest: (id, pullRequest, report) => {
        existing(id);
        const given = GeneratedText.parse(report);
        updatePullRequest.run(pullRequest, given.en, given.zh, id);
        touch(id);
      },
      setReport: (id, report) => {
        existing(id);
        const given = GeneratedText.parse(report);
        updateReport.run(given.en, given.zh, id);
        touch(id);
      },
      startRound: (id, start) => {
        const current = existing(id);
        if (current.state !== "working") {
          throw new TicketError(`Ticket ${id} is ${current.state}; a guided round starts only on a ticket going back to work`);
        }
        const failure = LoopFailure.parse(start.failure);
        const guidance = GeneratedText.parse(start.guidance);
        if (capReached(current.round, failure.kind, current.freeRetry)) {
          throw new TicketError(`Ticket ${id} has had ${current.round} guided rounds, the cap of ${roundCap}; only the owner can give it more`);
        }
        const counted = countsAsRound(failure.kind, current.freeRetry);
        const round = counted ? current.round + 1 : current.round;
        const seq = (SeqRow.parse(selectLastRound.get(id)).seq ?? 0) + 1;
        const now = clock.now();
        insertRound.run(id, seq, counted ? round : null, start.attempt, failure.kind, failure.detail, guidance.en, guidance.zh, now);
        updateRound.run(round, counted ? 0 : 1, id);
        touch(id);
        return { seq, round: counted ? round : null, attempt: start.attempt, failure, guidance, at: now };
      },
      stick: (id, given) => {
        const current = existing(id);
        const from = StuckFrom.safeParse(current.state);
        if (!from.success || !canMoveTicket(current.kind, current.state, "stuck")) {
          throw new TicketError(`Ticket ${id} is ${current.state} and cannot stop for the owner`);
        }
        const failure = LoopFailure.parse(given);
        const now = clock.now();
        updateState.run("stuck", now, id, current.state);
        recordMove(id, current.state, "stuck", undefined, now);
        updateStuck.run(now, current.round, from.data, failure.kind, failure.detail, id);
        touched.add(id);
        return existing(id);
      },
      describeStuck: (id, where) => {
        const current = existing(id);
        if (current.state !== "stuck") {
          throw new TicketError(`Ticket ${id} is ${current.state}, not stopped for the owner`);
        }
        const given = GeneratedText.parse(where);
        updateStuckWhere.run(given.en, given.zh, id);
        touch(id);
        return existing(id);
      },
      resume: (id, reason) => {
        const current = existing(id);
        if (current.state !== "stuck" || current.stuck === null) {
          throw new TicketError(`Ticket ${id} is ${current.state}, not stopped for the owner`);
        }
        const to = current.stuck.from;
        if (!canMoveTicket(current.kind, "stuck", to)) {
          throw new TicketError(`Ticket ${id} cannot go back to ${to}`);
        }
        const now = clock.now();
        updateState.run(to, now, id, "stuck");
        recordMove(id, "stuck", to, GeneratedText.parse(reason), now);
        clearStuck.run(id);
        touched.add(id);
        return existing(id);
      },
    };
    inside = true;
    let result: T;
    try {
      connection.exec("BEGIN IMMEDIATE");
      try {
        result = body(writes);
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    } finally {
      inside = false;
    }
    for (const id of [...touched].sort((a, b) => a - b)) {
      const ticket = get(id);
      if (ticket !== undefined) {
        announce(ticket);
      }
    }
    return result;
  };

  const move = (id: number, to: TicketState, reason?: GeneratedText): MoveResult => {
    const current = get(id);
    if (current === undefined) {
      return { ok: false, error: "not_found" };
    }
    if (!canMoveTicket(current.kind, current.state, to)) {
      return { ok: false, error: "refused", ticket: current };
    }
    const ticket = change((writes) => writes.move(id, to, reason));
    return { ok: true, ticket: get(id) ?? ticket };
  };

  return {
    open: (request) => {
      check(request);
      const id = change((writes) => writes.open(request));
      const ticket = get(id);
      if (ticket === undefined) {
        throw new Error(`Ticket ${id} was not stored`);
      }
      return ticket;
    },
    get,
    list: (listing = {}) => {
      const limit = listing.limit ?? defaultLimit;
      const rows = listing.open === true ? selectOpen.all(...openTicketStates, limit) : selectAll.all(limit);
      return rows.map(toTicket);
    },
    history: (listing = {}) => {
      const limit = Math.max(1, listing.limit ?? historyPageSize);
      const terms = searchTerms(listing.query ?? "");
      const before = listing.before;
      const states = finishedTicketStates.map(() => "?").join(", ");
      const older = before === undefined ? "" : " AND (t.ended_at < ? OR (t.ended_at = ? AND t.id < ?))";
      const matching = terms.map(() => ` AND (${searchedText}) LIKE ? ESCAPE '${escapeCharacter}'`).join("");
      const rows = connection
        .prepare(`SELECT t.id AS id FROM tickets t WHERE t.ended_at IS NOT NULL AND t.joined_into IS NULL AND t.state IN (${states})${older}${matching} ORDER BY t.ended_at DESC, t.id DESC LIMIT ?`)
        .all(...finishedTicketStates, ...(before === undefined ? [] : [before.endedAt, before.endedAt, before.id]), ...terms.map(likePattern), limit + 1);
      const found = rows.flatMap((row) => {
        const ticket = get(FoundRow.parse(row).id);
        return ticket === undefined ? [] : [ticket];
      });
      const page = found.slice(0, limit);
      const last = page.at(-1);
      const next = found.length > limit && last !== undefined && last.endedAt !== null ? cursorAt({ endedAt: last.endedAt, id: last.id }) : null;
      return { tickets: page, next };
    },
    moves: movesOf,
    detail: (id) => {
      const ticket = get(id);
      return ticket === undefined ? undefined : { ticket, moves: movesOf(id), attempts: selectAttempts.all(id).map(workStatusOf), rounds: selectRounds.all(id).map(roundOf) };
    },
    writing: writingOf,
    rounds: (id) => selectRounds.all(id).map(roundOf),
    forIssue: (repository, number) =>
      selectByIssue.all(repository, number).flatMap((row) => {
        const ticket = get(IdRow.parse(row).ticket_id);
        return ticket === undefined ? [] : [ticket];
      }),
    waitingFor: (id) =>
      selectWaitingFor.all(id).flatMap((row) => {
        const ticket = get(IdRow.parse(row).ticket_id);
        return ticket === undefined ? [] : [ticket];
      }),
    move,
    stop: (id, reason) => {
      const given = GeneratedText.parse(reason);
      const result = move(id, "stopped", given);
      if (result.ok) {
        work.stop(result.ticket);
      }
      return result;
    },
    change,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
