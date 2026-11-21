import { text } from "@super-agent2/catalog";
import {
  canMoveTicket,
  capReached,
  ClosedChainIssue,
  Decision,
  type DecisionReview,
  type DecisionSource,
  TicketDecision,
  type TicketReviewCount,
  countsAsRound,
  cursorAt,
  finishedTicketStates,
  hasRemainingWork,
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
  mergedIssueNumbers,
  openTicketStates,
  type Platform,
  type RepairOpener,
  RepositoryName,
  fitsForm,
  Ticket,
  TicketCode,
  TicketCodeDate,
  ticketReference,
  type TicketDetail,
  TicketIssue,
  type TicketForm,
  type TicketKind,
  TicketMove,
  ticketProject,
  TicketPullRequest,
  TicketRun,
  type TicketState,
  TicketSwitch,
  type OwnerChoice,
  type ProgramId,
  WorkStatus,
  TaskMaterial,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import { storeTopic } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import { codeAfter, ticketCodesExhausted, ticketDate, ticketDateFormatter, ticketReferences } from "./ticket-codes.js";
import { createTicketVersions, TicketWriteRefused, type TicketTurn } from "./ticket-versions.js";
import { createTopicResolver } from "./topic-corrections.js";
import { verificationOf } from "./verification-record.js";
import { scheduleAccess } from "./schedule-access.js";

export interface TaskToOpen {
  readonly task: string;
  readonly materials: readonly TaskMaterial[];
  readonly commitRef?: string | null | undefined;
  readonly deploys?: boolean | undefined;
}

export interface TicketTask {
  readonly task: string;
  readonly materials: readonly TaskMaterial[];
  readonly commitRef: string | null;
  readonly commit: string | null;
  readonly deploys: boolean;
}

export interface TicketToOpen {
  readonly form?: TicketForm | undefined;
  readonly light?: Ticket["light"];
  readonly task?: TaskToOpen | undefined;
  readonly requiredMachine?: string | null | undefined;
  readonly repository: string | null;
  readonly project?: string | undefined;
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
  readonly visible?: boolean;
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

export interface HandedInDetails {
  readonly url?: string | undefined;
  readonly closes?: readonly number[] | undefined;
}

export interface MergedPullRequest {
  readonly number: number;
  readonly closes: readonly number[];
  readonly mergeCommit: string | null;
  readonly deployment: boolean | null;
}

export interface DecisionPlace {
  readonly attempt?: number | null | undefined;
  readonly pullRequest?: number | null | undefined;
}

export interface RepairRecord {
  readonly ticket: number;
  readonly repairs: number;
  readonly openedBy: RepairOpener;
  readonly words: string;
  readonly openedAt: number;
  readonly round: number | null;
  readonly failure: LoopFailure | null;
  readonly where: GeneratedText | null;
  readonly saved: boolean | null;
  readonly savedDetail: string | null;
}

export type RepairOutcome = { readonly ok: true; readonly ticket: Ticket; readonly followers: readonly Ticket[] } | { readonly ok: false; readonly reason: string };

export type GiveUpOutcome =
  | { readonly ok: true; readonly ticket: Ticket; readonly repair: Ticket | null; readonly followers: readonly Ticket[] }
  | { readonly ok: false; readonly error: "not_found" | "refused" };

export interface TicketWrites {
  get(id: number): Ticket | undefined;
  topic(id: number): string;
  open(request: TicketToOpen): number;
  setIssues(id: number, issues: readonly TicketIssue[]): void;
  describe(id: number, description: TicketDescription): void;
  setWaits(id: number, waits: readonly WaitToSet[]): void;
  redirectWaits(from: number, to: number): number[];
  openRepair(id: number, by: RepairOpener, words: string): number;
  repairSaved(id: number, saved: boolean, detail: string): void;
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
  setPullRequest(id: number, pullRequest: number, report: GeneratedText, details?: HandedInDetails): void;
  pullRequestMerged(id: number, merged: MergedPullRequest): void;
  pullRequestClosed(id: number, number: number): void;
  setClosedOutside(id: number, issues: readonly ClosedChainIssue[]): void;
  setFinalPullRequest(id: number, number: number): void;
  nextPiece(id: number, branch: string): void;
  setReport(id: number, report: GeneratedText): void;
  setCommit(id: number, commit: string): void;
  startRound(id: number, round: RoundToStart): TicketRound;
  stick(id: number, failure: LoopFailure): Ticket;
  describeStuck(id: number, where: GeneratedText): Ticket;
  resume(id: number, reason: GeneratedText): Ticket;
  recordDecisions(id: number, source: DecisionSource, decisions: readonly Decision[], place?: DecisionPlace): TicketDecision[];
  settleDecision(id: number, decision: number, review: DecisionReview): TicketDecision;
  sentDecisions(id: number, decisions: readonly number[]): void;
}

export interface TicketService {
  announce(ids: readonly number[]): void;
  readonly versions: Pick<ReturnType<typeof createTicketVersions>, "requireActive" | "seen">;
  open(request: TicketToOpen, turn?: TicketTurn): Ticket;
  get(id: number): Ticket | undefined;
  topic(id: number): string;
  resolve(reference: string): number | undefined;
  reference(id: number): string | undefined;
  list(options?: ListOptions): Ticket[];
  history(options?: HistoryOptions): HistoryPage;
  moves(id: number): TicketMove[];
  detail(id: number): TicketDetail | undefined;
  rounds(id: number): TicketRound[];
  switches(id: number): TicketSwitch[];
  task(id: number): TicketTask | undefined;
  lightTopicAllows(topic: string, project: string | undefined): boolean;
  scheduleForTurn: ReturnType<typeof scheduleAccess>["forTurn"];
  repairRecord(id: number): RepairRecord | undefined;
  lineage(id: number): Ticket[];
  repair(id: number, by: RepairOpener, words: string, turn?: TicketTurn): RepairOutcome;
  giveUp(id: number, reason: GeneratedText, words: string): GiveUpOutcome;
  forIssue(repository: string, number: number): Ticket[];
  waitingFor(id: number): Ticket[];
  reviews(): TicketReviewCount[];
  move(id: number, to: TicketState, reason?: GeneratedText): MoveResult;
  stop(id: number, reason: GeneratedText, turn?: TicketTurn): MoveResult;
  change<T>(body: (writes: TicketWrites) => T, turn?: TicketTurn): T;
  subscribe(listener: TicketListener): () => void;
}

export interface TicketServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly work?: TicketWork;
  readonly topicChanged?: (id: string) => void;
  readonly entryChanged?: (id: string) => void;
}

export class TicketError extends Error {}

const TicketRow = z.object({
  light: z.string().nullable(),
  id: z.number().int(),
  code: TicketCode,
  code_date: TicketCodeDate,
  form: z.string(),
  required_machine: z.string().nullable(),
  repository: z.string().nullable(),
  project: z.string().nullable(),
  schedule_run: z.string().nullable(),
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
  closed_outside: z.string(),
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

const PullRequestRow = z.object({
  seq: z.number().int(),
  number: z.number().int(),
  url: z.string(),
  branch: z.string(),
  state: z.string(),
  closes: z.string(),
  merge_commit: z.string().nullable(),
  deployment: z.number().int().nullable(),
  handed_at: z.number().int(),
  merged_at: z.number().int().nullable(),
});

const DecisionRow = z.object({
  id: z.number().int(),
  source: z.string(),
  attempt: z.number().int().nullable(),
  pull_request: z.number().int().nullable(),
  chosen_en: z.string(),
  chosen_zh: z.string(),
  why_en: z.string(),
  why_zh: z.string(),
  options_en: z.string(),
  options_zh: z.string(),
  recorded_at: z.number().int(),
  verdict: z.string().nullable(),
  opinion: z.string().nullable(),
  reviewed_at: z.number().int().nullable(),
  sent_at: z.number().int().nullable(),
});

function decisionOf(row: unknown): TicketDecision {
  const value = DecisionRow.parse(row);
  return TicketDecision.parse({
    id: value.id,
    source: value.source,
    attempt: value.attempt,
    pullRequest: value.pull_request,
    chosen: { en: value.chosen_en, zh: value.chosen_zh },
    why: { en: value.why_en, zh: value.why_zh },
    otherOptions: { en: value.options_en, zh: value.options_zh },
    at: value.recorded_at,
    verdict: value.verdict,
    opinion: value.opinion,
    reviewedAt: value.reviewed_at,
    sentAt: value.sent_at,
  });
}

function sameDecision(a: Decision, b: Decision): boolean {
  return a.chosen.en.trim() === b.chosen.en.trim() && a.why.en.trim() === b.why.en.trim() && a.otherOptions.en.trim() === b.otherOptions.en.trim();
}

const ReviewRow = z.object({ ticket_id: z.number().int(), count: z.number().int() });

function pullRequestOf(row: unknown): TicketPullRequest {
  const value = PullRequestRow.parse(row);
  return TicketPullRequest.parse({
    number: value.number,
    url: value.url,
    branch: value.branch,
    state: value.state,
    closes: z.array(z.number().int().positive()).catch([]).parse(parsedJson(value.closes)),
    mergeCommit: value.merge_commit,
    deployment: value.deployment === null ? null : value.deployment === 1,
    handedAt: value.handed_at,
    mergedAt: value.merged_at,
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

const TaskRow = z.object({ task: z.string(), materials: z.string(), commit_ref: z.string().nullable(), commit_sha: z.string().nullable(), deploys: z.number().int() });

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

const SwitchRow = z.object({
  ticket_id: z.number().int(),
  seq: z.number().int(),
  kind: z.string(),
  at: z.number().int(),
  from_engine: z.string(),
  from_model: z.string().nullable(),
  to_engine: z.string().nullable(),
  machine: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  reason: z.string(),
  until: z.number().int().nullable(),
  owner: z.number().int(),
  attempt: z.number().int().nullable(),
});

export function switchOf(row: unknown): TicketSwitch {
  const value = SwitchRow.parse(row);
  return TicketSwitch.parse({
    ticket: value.ticket_id,
    seq: value.seq,
    kind: value.kind,
    at: value.at,
    from: value.from_engine,
    ...(value.from_model === null ? {} : { fromModel: value.from_model }),
    to: value.to_engine,
    machine: value.machine,
    model: value.model,
    effort: value.effort,
    reason: value.reason,
    until: value.until,
    owner: value.owner === 1,
    attempt: value.attempt,
  });
}

const RepairRow = z.object({
  ticket_id: z.number().int(),
  repairs: z.number().int(),
  opened_by: z.string(),
  words: z.string(),
  opened_at: z.number().int(),
  round: z.number().int().nullable(),
  failure: z.string().nullable(),
  detail: z.string().nullable(),
  where_en: z.string().nullable(),
  where_zh: z.string().nullable(),
  saved: z.number().int().nullable(),
  saved_detail: z.string().nullable(),
});

function repairOf(row: unknown): RepairRecord {
  const value = RepairRow.parse(row);
  const failure = LoopFailureKind.safeParse(value.failure);
  return {
    ticket: value.ticket_id,
    repairs: value.repairs,
    openedBy: value.opened_by === "brain" ? "brain" : "owner",
    words: value.words,
    openedAt: value.opened_at,
    round: value.round,
    failure: failure.success ? { kind: failure.data, detail: value.detail ?? "" } : null,
    where: pair(value.where_en, value.where_zh),
    saved: value.saved === null ? null : value.saved === 1,
    savedDetail: value.saved_detail,
  };
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

const searchedText = `t.title_en || char(10) || t.title_zh || char(10) || t.summary_en || char(10) || t.summary_zh || char(10) || COALESCE(t.repository, t.project, '') || char(10) || COALESCE((SELECT w.task FROM ticket_tasks w WHERE w.ticket_id = t.id), '') || char(10) || COALESCE((SELECT group_concat(${issueTexts}, char(10)) FROM ticket_issues i WHERE i.ticket_id = t.id), '')`;

const escapeCharacter = "\\";

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `${escapeCharacter}${character}`)}%`;
}

export function createTicketService(options: TicketServiceOptions): TicketService {
  const { connection } = options.database;
  const versions = createTicketVersions(options.database);
  const scheduled = scheduleAccess(options.database);
  const { clock } = options;
  const work = options.work ?? noTicketWork;
  const listeners = new Set<TicketListener>();
  let inside = false;

  const selectTicket = connection.prepare("SELECT * FROM tickets WHERE id = ?");
  const references = ticketReferences(connection);
  const dayFormatter = ticketDateFormatter(options.database.ticketTimeZone);
  const lastCode = connection.prepare("SELECT code FROM tickets WHERE code_date = ? ORDER BY code DESC LIMIT 1");
  const resolveTopic = createTopicResolver(options.database);
  const noTopicMerge = "NOT EXISTS (SELECT 1 FROM topic_merges WHERE source = conversations.id OR destination = conversations.id)";
  const noConflictingTickets = "NOT EXISTS (SELECT 1 FROM tickets WHERE conversation_id = conversations.id AND coalesce(repository, project) IS NOT ? COLLATE NOCASE)";
  const claimTopic = connection.prepare(
    `UPDATE conversations SET repository = ?, needs_repository = 0
     WHERE id = ? AND system = 0 AND merged_into IS NULL AND repository IS NULL
     AND ${noTopicMerge} AND ${noConflictingTickets}`,
  );
  const lightTopic = connection.prepare(
    `SELECT 1 FROM conversations WHERE id = ? AND system = 0 AND merged_into IS NULL AND topic_state = 'active'
     AND ${noTopicMerge} AND (
       (? IS NULL AND repository IS NULL AND needs_repository = 0)
       OR repository = ? COLLATE NOCASE
       OR (? IS NOT NULL AND repository IS NULL AND ${noConflictingTickets})
     )`,
  );
  const lightTopicAllows = (topic: string, project: string | undefined): boolean => {
    const name = project ?? null;
    return lightTopic.get(topic, name, name, name, name) !== undefined;
  };
  const changeTopicHistory = connection.prepare("UPDATE topic_history_revision SET revision = revision + 1");
  const insertTaskNotice = connection.prepare(`
    INSERT INTO conversation_entries (id, conversation_id, seq, kind, turn_id, provider, body, prompt, taken, created_at, stream_seq)
    VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM conversation_entries WHERE conversation_id = ?), 'notice', NULL, NULL, ?, NULL, NULL, ?,
      (SELECT coalesce(max(stream_seq), 0) + 1 FROM conversation_entries))
  `);
  const selectTicketTopic = connection.prepare("SELECT c.id FROM tickets AS t JOIN conversations AS c ON c.id = t.conversation_id WHERE t.id = ?");
  const updateTicketTopic = connection.prepare("UPDATE tickets SET conversation_id = ? WHERE id = ?");
  const selectIssues = connection.prepare("SELECT * FROM ticket_issues WHERE ticket_id = ? ORDER BY position");
  const selectWaits = connection.prepare("SELECT waits_for, deployment, waived_at FROM ticket_waits WHERE ticket_id = ? ORDER BY waits_for");
  const selectStartBlock = connection.prepare("SELECT value FROM hub_settings WHERE key = ?");
  const selectBegin = connection.prepare("SELECT failure FROM ticket_begins WHERE ticket_id = ? AND failed_at IS NOT NULL AND done_at IS NULL");
  const selectMoves = connection.prepare("SELECT * FROM ticket_moves WHERE ticket_id = ? ORDER BY seq");
  const selectAttempt = connection.prepare("SELECT * FROM ticket_attempts WHERE ticket_id = ? ORDER BY attempt DESC LIMIT 1");
  const selectAttempts = connection.prepare("SELECT * FROM ticket_attempts WHERE ticket_id = ? ORDER BY attempt");
  const selectVerification = connection.prepare("SELECT * FROM ticket_verifications WHERE ticket_id = ?");
  const deleteVerification = connection.prepare("DELETE FROM ticket_verifications WHERE ticket_id = ?");
  const selectPullRequests = connection.prepare("SELECT * FROM ticket_pull_requests WHERE ticket_id = ? ORDER BY seq");
  const insertPullRequest = connection.prepare(
    "INSERT INTO ticket_pull_requests (ticket_id, seq, number, url, branch, state, closes, handed_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
  );
  const updateHandedIn = connection.prepare("UPDATE ticket_pull_requests SET url = ?, closes = ?, handed_at = ? WHERE ticket_id = ? AND seq = ? AND state <> 'merged'");
  const closeReplaced = connection.prepare("UPDATE ticket_pull_requests SET state = 'closed' WHERE ticket_id = ? AND state = 'open' AND number <> ?");
  const closePullRequest = connection.prepare("UPDATE ticket_pull_requests SET state = 'closed' WHERE ticket_id = ? AND number = ? AND state = 'open'");
  const updateMergedPullRequest = connection.prepare(
    "UPDATE ticket_pull_requests SET state = 'merged', closes = ?, merge_commit = ?, deployment = ?, merged_at = COALESCE(merged_at, ?) WHERE ticket_id = ? AND number = ?",
  );
  const selectDecisions = connection.prepare("SELECT * FROM ticket_decisions WHERE ticket_id = ? ORDER BY id");
  const insertDecision = connection.prepare(
    "INSERT INTO ticket_decisions (ticket_id, source, attempt, pull_request, chosen_en, chosen_zh, why_en, why_zh, options_en, options_zh, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateVerdict = connection.prepare("UPDATE ticket_decisions SET verdict = ?, opinion = ?, reviewed_at = ? WHERE ticket_id = ? AND id = ? AND verdict IS NULL");
  const moveDecisions = connection.prepare("UPDATE ticket_decisions SET ticket_id = ? WHERE ticket_id = ?");
  const updateSent = connection.prepare("UPDATE ticket_decisions SET sent_at = ? WHERE ticket_id = ? AND id = ? AND sent_at IS NULL");
  const selectReviews = connection.prepare(
    `SELECT d.ticket_id AS ticket_id, COUNT(*) AS count FROM ticket_decisions d JOIN tickets t ON t.id = d.ticket_id WHERE t.light IS NULL AND d.verdict IS NULL AND t.ended_at IS NOT NULL AND t.joined_into IS NULL AND t.state IN (${finishedTicketStates.map(() => "?").join(", ")}) GROUP BY d.ticket_id ORDER BY d.ticket_id`,
  );
  const updateBranch = connection.prepare("UPDATE tickets SET branch = ? WHERE id = ?");
  const updatePullRequest = connection.prepare("UPDATE tickets SET pull_request = ?, report_en = ?, report_zh = ? WHERE id = ?");
  const updateFinalPullRequest = connection.prepare("UPDATE tickets SET pull_request = ? WHERE id = ?");
  const updateClosedOutside = connection.prepare("UPDATE tickets SET closed_outside = ? WHERE id = ? AND closed_outside <> ?");
  const updateReport = connection.prepare("UPDATE tickets SET report_en = ?, report_zh = ? WHERE id = ?");
  const selectTask = connection.prepare("SELECT task, materials, commit_ref, commit_sha, deploys FROM ticket_tasks WHERE ticket_id = ?");
  const insertTask = connection.prepare("INSERT INTO ticket_tasks (ticket_id, task, materials, commit_ref, deploys) VALUES (?, ?, ?, ?, ?)");
  const updateCommit = connection.prepare("UPDATE ticket_tasks SET commit_sha = ? WHERE ticket_id = ?");
  const selectLastSeq = connection.prepare("SELECT MAX(seq) AS seq FROM ticket_moves WHERE ticket_id = ?");
  const selectAll = connection.prepare("SELECT * FROM tickets WHERE (? OR light IS NULL) ORDER BY created_at DESC, id DESC LIMIT ?");
  const selectOpen = connection.prepare(
    `SELECT * FROM tickets WHERE state IN (${openTicketStates.map(() => "?").join(", ")}) AND (? OR light IS NULL) ORDER BY created_at DESC, id DESC LIMIT ?`,
  );
  const selectByIssue = connection.prepare("SELECT DISTINCT ticket_id FROM ticket_issues WHERE repository = ? AND number = ? ORDER BY ticket_id");
  const selectWaitingFor = connection.prepare("SELECT ticket_id FROM ticket_waits WHERE waits_for = ? ORDER BY ticket_id");
  const insertTicket = connection.prepare(
    `INSERT INTO tickets (form, light, required_machine, repository, project, schedule_run, kind, title_en, title_zh, summary_en, summary_zh, difficulty, platform, state, conversation_id, created_at, updated_at, code, code_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  );
  const insertIssue = connection.prepare(
    "INSERT INTO ticket_issues (ticket_id, position, repository, number, url, title_en, title_zh, summary_en, summary_zh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const deleteIssues = connection.prepare("DELETE FROM ticket_issues WHERE ticket_id = ?");
  const insertWait = connection.prepare("INSERT INTO ticket_waits (ticket_id, waits_for, deployment) VALUES (?, ?, ?)");
  const deleteWaits = connection.prepare("DELETE FROM ticket_waits WHERE ticket_id = ?");
  const selectRedirected = connection.prepare(
    "SELECT w.ticket_id, w.deployment FROM ticket_waits w JOIN tickets t ON t.id = w.ticket_id WHERE w.waits_for = ? AND w.waived_at IS NULL AND t.state IN ('pending', 'waiting') ORDER BY w.ticket_id",
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
    "UPDATE tickets SET kind = ?, difficulty = ?, difficulty_reason_en = ?, difficulty_reason_zh = ?, platform = ?, brain_engine = NULL WHERE id = ?",
  );
  const clearDefaults = connection.prepare(
    "UPDATE tickets SET difficulty_reason_en = NULL, difficulty_reason_zh = NULL, brain_engine = NULL, owner_machine = NULL, owner_engine = NULL, owner_model = NULL, owner_effort = NULL WHERE id = ?",
  );
  const updateOwnerChoice = connection.prepare("UPDATE tickets SET owner_machine = ?, owner_engine = ?, owner_model = ?, owner_effort = ? WHERE id = ?");
  const updateChosen = connection.prepare("UPDATE tickets SET machine = ?, engine = ?, model = ?, effort = ?, chosen_by = ?, chosen_at = ? WHERE id = ?");
  const updateRan = connection.prepare("UPDATE tickets SET ran = ? WHERE id = ?");
  const selectRounds = connection.prepare("SELECT * FROM ticket_rounds WHERE ticket_id = ? ORDER BY seq");
  const selectSwitches = connection.prepare("SELECT * FROM ticket_switches WHERE ticket_id = ? ORDER BY seq");
  const selectRepairOf = connection.prepare("SELECT * FROM ticket_repairs WHERE ticket_id = ?");
  const selectRepairedBy = connection.prepare("SELECT ticket_id FROM ticket_repairs WHERE repairs = ?");
  const insertRepair = connection.prepare(
    "INSERT INTO ticket_repairs (ticket_id, repairs, opened_by, words, opened_at, round, failure, detail, where_en, where_zh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateRepairSaved = connection.prepare("UPDATE ticket_repairs SET saved = ?, saved_detail = ? WHERE repairs = ? AND saved IS NULL");
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
      return { ticket: wait.waits_for, reference: references.get(wait.waits_for), deployment: wait.deployment === 1, waived: wait.waived_at !== null };
    });
    const begin = selectBegin.get(value.id);
    const attempt = selectAttempt.get(value.id);
    const verification = selectVerification.get(value.id);
    const pullRequests = selectPullRequests.all(value.id).map(pullRequestOf);
    const closedOutside = z.array(ClosedChainIssue).parse(JSON.parse(value.closed_outside));
    const task = taskOf(value.id);
    const decisions = selectDecisions.all(value.id).map(decisionOf);
    const repairing = selectRepairOf.get(value.id);
    const repaired = selectRepairedBy.get(value.id);
    const repairs = repairing === undefined ? null : RepairRow.parse(repairing).repairs;
    const repairedBy = repaired === undefined ? null : IdRow.parse(repaired).ticket_id;
    return Ticket.parse({
      id: value.id,
      code: value.code,
      codeDate: value.code_date,
      form: value.form,
      light: value.light ?? undefined,
      repository: value.repository,
      ...(value.project === null ? {} : { project: value.project }),
      ...(value.schedule_run === null ? {} : { scheduleRun: value.schedule_run }),
      issues,
      title: { en: value.title_en, zh: value.title_zh },
      summary: { en: value.summary_en, zh: value.summary_zh },
      kind: value.kind,
      difficulty: value.difficulty,
      difficultyReason: pair(value.difficulty_reason_en, value.difficulty_reason_zh),
      platform: value.platform,
      requiredMachine: value.required_machine,
      commitRef: task?.commitRef ?? null,
      commit: task?.commit ?? null,
      deploys: task?.deploys ?? false,
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
      pullRequests,
      ...(closedOutside.length === 0 ? {} : { closedOutside }),
      decisions,
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
      startBlock: value.state === "waiting" ? Ticket.shape.startBlock.catch(null).parse(parsedJson((selectStartBlock.get(`start_block:${value.id}`) as { value: string } | undefined)?.value ?? "null")) : null,
      stopReason: pair(value.stop_reason_en, value.stop_reason_zh),
      joinedInto: value.joined_into,
      repairs,
      repairedBy,
      repairsReference: repairs === null ? undefined : references.get(repairs),
      repairedByReference: repairedBy === null ? undefined : references.get(repairedBy),
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

  const topicOf = (id: number): string | undefined => {
    const row = selectTicketTopic.get(id);
    return row === undefined ? undefined : z.object({ id: z.string() }).parse(row).id;
  };

  const earlierIds = (id: number): number[] => {
    const found: number[] = [];
    let at = id;
    for (;;) {
      const row = selectRepairOf.get(at);
      if (row === undefined) {
        return found.reverse();
      }
      at = RepairRow.parse(row).repairs;
      if (at === id || found.includes(at)) {
        return found.reverse();
      }
      found.push(at);
    }
  };

  const followersOf = (repair: Ticket): Ticket[] =>
    selectWaitingFor.all(repair.id).flatMap((row) => {
      const ticket = get(IdRow.parse(row).ticket_id);
      return ticket === undefined || !(ticket.state === "pending" || ticket.state === "waiting") ? [] : [ticket];
    });

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

  const formOf = (request: TicketToOpen): TicketForm => request.form ?? (request.task !== undefined || request.kind === "writing" ? "task" : "code");

  const check = (request: TicketToOpen) => {
    const form = formOf(request);
    if (!fitsForm(form, request.kind)) {
      throw new TicketError(`A ${form} ticket cannot be of kind ${request.kind}`);
    }
    if (request.light !== undefined && (form !== "task" || request.task === undefined || request.repository !== null
      || request.task.deploys === true || request.task.commitRef != null || request.conversation === undefined || (request.waitsFor?.length ?? 0) > 0)) {
      throw new TicketError("A light task must be a standalone task without a checkout, commit or deployment.");
    }
    if (request.project !== undefined && (form !== "task" || request.repository !== null || !RepositoryName.safeParse(request.project).success)) {
      throw new TicketError("Use project as owner/name for a task ticket without a checkout.");
    }
    if (request.task !== undefined && form !== "task") {
      throw new TicketError("Only a task ticket has a task");
    }
    if (form === "task") {
      if (request.issues.length > 0) {
        throw new TicketError("A task ticket has no issues");
      }
      if (request.repository !== null && !RepositoryName.safeParse(request.repository).success) {
        throw new TicketError("A task ticket's repository is owner/name");
      }
      if (request.task !== undefined) {
        z.array(TaskMaterial).parse(request.task.materials);
        if (request.task.task.trim() === "") {
          throw new TicketError("A task ticket needs its task");
        }
        if (request.repository === null && ((request.task.commitRef ?? null) !== null || request.task.deploys === true)) {
          throw new TicketError("A task ticket names a commit or a deployment only with its repository");
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
      if (references.get(before) === undefined) {
        throw new TicketError("The predecessor ticket could not be found");
      }
    }
  };

  const taskOf = (id: number): TicketTask | undefined => {
    const row = selectTask.get(id);
    if (row === undefined) {
      return undefined;
    }
    const value = TaskRow.parse(row);
    return {
      task: value.task,
      materials: z.array(TaskMaterial).parse(JSON.parse(value.materials)),
      commitRef: value.commit_ref,
      commit: value.commit_sha,
      deploys: value.deploys === 1,
    };
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

  const change = <T>(body: (writes: TicketWrites) => T, turn?: TicketTurn): T => {
    if (inside) {
      throw new Error("Ticket changes do not nest");
    }
    const touched = new Set<number>();
    const changedTopics = new Set<string>();
    const changedEntries: string[] = [];
    const openTopic = (title: string, repository: string | null) => {
      const id = storeTopic(options.database, clock.now(), title, { repository });
      changedTopics.add(id);
      return id;
    };
    const chooseTopic = (request: TicketToOpen): string => {
      const source = request.conversation ?? turn?.conversation;
      const repository = ticketProject(request);
      const topic = (source === undefined ? undefined : resolveTopic(source)) ?? turn?.conversation;
      if (topic === undefined) {
        return openTopic(request.title.zh.trim(), repository);
      }
      if (repository !== null && claimTopic.run(repository, topic, repository).changes > 0) {
        changeTopicHistory.run();
        changedTopics.add(topic);
      }
      return topic;
    };
    const touch = (id: number) => {
      updateTouched.run(clock.now(), id);
      touched.add(id);
    };
    const existing = (id: number): Ticket => {
      const ticket = get(id);
      if (ticket === undefined) {
        throw new TicketError(`There is no ticket ${references.get(id) ?? "(unavailable)"}`);
      }
      return ticket;
    };
    const open = (request: TicketToOpen, inheritedTopic?: string): number => {
      check(request);
      const run = turn === undefined ? undefined : scheduled.forTurn(turn);
      if (run !== undefined && !run.authorized) throw new TicketWriteRefused("This scheduled run can no longer open work.");
      if (request.light !== undefined && (request.conversation === undefined || !lightTopicAllows(request.conversation, request.project))) {
        throw new TicketError("A light task needs an active daily topic or a topic for its project.");
      }
      const now = clock.now();
      const date = ticketDate(dayFormatter, now);
      const code = codeAfter(TicketCode.optional().parse(lastCode.get(date)?.code));
      if (code === undefined) throw new TicketError(ticketCodesExhausted(date));
      const topic = inheritedTopic ?? chooseTopic(request);
      const result = insertTicket.run(
        formOf(request),
        request.light ?? null,
        request.requiredMachine ?? (request.task?.deploys === true ? null : run?.machine ?? null),
        request.repository,
        request.project ?? null,
        run?.id ?? null,
        request.kind,
        request.title.en.trim(),
        request.title.zh.trim(),
        request.summary.en.trim(),
        request.summary.zh.trim(),
        request.difficulty ?? null,
        request.platform ?? null,
        topic,
        now,
        now,
        code,
        date,
      );
      const id = Number(result.lastInsertRowid);
      if (run === undefined && formOf(request) === "task" && ticketProject(request) === null && request.light === undefined) {
        const card = `task-card-${id}`;
        insertTaskNotice.run(card, topic, topic, JSON.stringify({ text: text("notice.taskPending", { title: request.title.zh.trim() }), ticket: id, start: true }), now);
        changedEntries.push(card);
      }
      insertIssues(id, request.issues);
      if (request.task !== undefined) {
        insertTask.run(id, request.task.task.trim(), JSON.stringify(request.task.materials), request.task.commitRef ?? null, request.task.deploys === true ? 1 : 0);
      }
      for (const before of new Set(request.waitsFor ?? [])) {
        insertWait.run(id, before, 0);
      }
      recordMove(id, null, "pending", undefined, now);
      touched.add(id);
      return id;
    };
    const writes: TicketWrites = {
      get,
      topic: (id) => {
        const current = topicOf(id);
        if (current !== undefined) {
          return current;
        }
        const lineage = [...earlierIds(id), id];
        const inherited = lineage.map(topicOf).findLast((topic) => topic !== undefined);
        const root = existing(lineage[0] ?? id);
        const topic = inherited ?? lineage.toReversed().flatMap((ticket) => selectWaits.all(ticket))
          .map((row) => topicOf(WaitRow.parse(row).waits_for)).find((topic) => topic !== undefined)
          ?? openTopic(root.title.zh, ticketProject(root));
        for (const ticket of lineage) {
          if (topicOf(ticket) === undefined) {
            updateTicketTopic.run(topic, ticket);
            touch(ticket);
          }
        }
        return topic;
      },
      open,
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
        if (existing(id).light !== undefined && waits.length > 0) throw new TicketError("A light task cannot have dependencies.");
        deleteWaits.run(id);
        const seen = new Set<number>();
        for (const wait of waits) {
          if (wait.ticket === id) {
            throw new TicketError(`Ticket ${references.get(id) ?? "(unavailable)"} cannot wait for itself`);
          }
          if (existing(wait.ticket).light !== undefined) throw new TicketError("A ticket cannot depend on a light task.");
          if (!seen.has(wait.ticket)) {
            seen.add(wait.ticket);
            insertWait.run(id, wait.ticket, wait.deployment ? 1 : 0);
          }
        }
        touch(id);
      },
      redirectWaits: (from, to) => {
        const moved: number[] = [];
        for (const row of selectRedirected.all(from)) {
          const value = z.object({ ticket_id: z.number().int(), deployment: z.number().int() }).parse(row);
          deleteWait.run(value.ticket_id, from);
          if (value.ticket_id !== to) {
            upsertWait.run(value.ticket_id, to, value.deployment);
            moved.push(value.ticket_id);
          }
          touch(value.ticket_id);
        }
        return moved;
      },
      openRepair: (id, by, words) => {
        const old = existing(id);
        if (old.state !== "stopped" || old.joinedInto !== null) {
          throw new TicketError(`Ticket ${ticketReference(old)} is ${old.state}${old.joinedInto === null ? "" : " and was joined into another ticket"}; only a stopped ticket that was not joined into another has a repair`);
        }
        if (selectRepairedBy.get(id) !== undefined) {
          throw new TicketError(`Ticket ${ticketReference(old)} already has a repair ticket`);
        }
        if (!hasRemainingWork(old)) {
          throw new TicketError(`Every issue of ticket ${ticketReference(old)} is closed, so nothing remains to repair`);
        }
        const merged = new Set(mergedIssueNumbers(old));
        if (old.light !== undefined) throw new TicketError("Start a new light task in the conversation to try again.");
        const task = old.form === "task" ? taskOf(id) : undefined;
        const raw = TicketRow.parse(selectTicket.get(id));
        const stuck = raw.stuck_failure === null ? undefined : LoopFailureKind.safeParse(raw.stuck_failure);
        const repair = open({
          form: old.form,
          repository: old.repository,
          project: old.project,
          issues: old.issues.filter((issue) => !merged.has(issue.number)),
          title: old.title,
          summary: old.summary,
          kind: old.kind,
          difficulty: old.difficulty ?? undefined,
          platform: old.platform ?? undefined,
          requiredMachine: old.requiredMachine,
          ...(task === undefined ? {} : { task: { task: task.task, materials: task.materials, commitRef: task.commitRef, deploys: task.deploys } }),
        }, writes.topic(id));
        if (task?.commit !== undefined && task.commit !== null) {
          writes.setCommit(repair, task.commit);
        }
        if (old.form === "code" && old.branch !== null) {
          updateBranch.run(old.branch, repair);
        }
        for (const wait of old.waits) {
          insertWait.run(repair, wait.ticket, wait.deployment ? 1 : 0);
          if (wait.waived) {
            waiveWait.run(clock.now(), repair, wait.ticket);
          }
        }
        insertRepair.run(
          repair,
          id,
          by,
          words,
          clock.now(),
          raw.stuck_round,
          stuck?.success === true ? stuck.data : null,
          stuck?.success === true ? (raw.stuck_detail ?? "") : null,
          raw.stuck_where_en,
          raw.stuck_where_zh,
        );
        writes.redirectWaits(id, repair);
        touch(id);
        touch(repair);
        return repair;
      },
      repairSaved: (id, saved, detail) => {
        if (updateRepairSaved.run(saved ? 1 : 0, detail, id).changes > 0) {
          const repaired = selectRepairedBy.get(id);
          if (repaired !== undefined) {
            touch(IdRow.parse(repaired).ticket_id);
          }
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
        if (updateDeployed.run(clock.now(), id).changes > 0) {
          touch(id);
        }
      },
      move: (id, to, reason) => {
        const current = existing(id);
        if (!canMoveTicket(current.form, current.state, to)) {
          throw new TicketError(`Ticket ${ticketReference(current)} is ${current.state} and cannot become ${to}`);
        }
        const now = clock.now();
        updateState.run(to, now, id, current.state);
        recordMove(id, current.state, to, reason, now);
        if (to === "stopped" && reason !== undefined) {
          updateStopReason.run(reason.en, reason.zh, id);
        }
        if (to === "stopped" && current.light !== undefined && current.conversation !== null) {
          const entry = `light-ended-${id}`;
          insertTaskNotice.run(entry, current.conversation, current.conversation,
            JSON.stringify({ text: text("notice.lightTaskEnded", { title: current.title.zh, reason: reason?.zh ?? text("notice.lightTaskStopped") }) }), now);
          changedEntries.push(entry);
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
          throw new TicketError(`Ticket ${references.get(id) ?? "(unavailable)"} cannot join itself`);
        }
        writes.move(id, "stopped", reason);
        updateJoined.run(into, id);
        if (moveDecisions.run(into, id).changes > 0) {
          touch(into);
        }
        return existing(id);
      },
      touched: (id) => touch(id),
      state: (id, statement) => {
        const current = existing(id);
        const reason = GeneratedText.parse(statement.difficultyReason);
        if (!fitsForm(current.form, statement.kind)) {
          throw new TicketError(`Ticket ${ticketReference(current)} is a ${current.form} ticket and cannot be of kind ${statement.kind}`);
        }
        updateStatement.run(statement.kind, statement.difficulty, reason.en, reason.zh, statement.platform, id);
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
      setPullRequest: (id, pullRequest, report, details = {}) => {
        const current = existing(id);
        const given = GeneratedText.parse(report);
        updatePullRequest.run(pullRequest, given.en, given.zh, id);
        const url = details.url ?? `https://github.com/${current.repository ?? ""}/pull/${pullRequest}`;
        const closes = JSON.stringify([...new Set(details.closes ?? [])]);
        const now = clock.now();
        closeReplaced.run(id, pullRequest);
        const rows = selectPullRequests.all(id).map((row) => PullRequestRow.parse(row));
        const row = rows.findLast((entry) => entry.number === pullRequest);
        if (row !== undefined) {
          updateHandedIn.run(url, closes, now, id, row.seq);
        } else {
          insertPullRequest.run(id, (rows.at(-1)?.seq ?? 0) + 1, pullRequest, url, current.branch ?? "", closes, now);
        }
        touch(id);
      },
      pullRequestMerged: (id, merged) => {
        existing(id);
        updateMergedPullRequest.run(
          JSON.stringify([...new Set(merged.closes)]),
          merged.mergeCommit,
          merged.deployment === null ? null : merged.deployment ? 1 : 0,
          clock.now(),
          id,
          merged.number,
        );
        touch(id);
      },
      setClosedOutside: (id, issues) => {
        const value = JSON.stringify(z.array(ClosedChainIssue).parse(issues));
        if (updateClosedOutside.run(value, id, value).changes > 0) {
          touch(id);
        }
      },
      pullRequestClosed: (id, number) => {
        if (closePullRequest.run(id, number).changes > 0) {
          touch(id);
        }
      },
      setFinalPullRequest: (id, number) => {
        updateFinalPullRequest.run(number, id);
        touch(id);
      },
      nextPiece: (id, branch) => {
        const current = existing(id);
        if (current.state !== "working") {
          throw new TicketError(`Ticket ${ticketReference(current)} is ${current.state}; the next piece of its chain starts only when it goes back to work`);
        }
        deleteVerification.run(id);
        updateBranch.run(branch, id);
        updateRound.run(0, 0, id);
        touch(id);
      },
      setReport: (id, report) => {
        existing(id);
        const given = GeneratedText.parse(report);
        updateReport.run(given.en, given.zh, id);
        touch(id);
      },
      setCommit: (id, commit) => {
        existing(id);
        updateCommit.run(commit, id);
        touch(id);
      },
      startRound: (id, start) => {
        const current = existing(id);
        if (current.state !== "working") {
          throw new TicketError(`Ticket ${ticketReference(current)} is ${current.state}; a guided round starts only on a ticket going back to work`);
        }
        const failure = LoopFailure.parse(start.failure);
        const guidance = GeneratedText.parse(start.guidance);
        if (capReached(current.round, failure.kind, current.freeRetry)) {
          throw new TicketError(`Ticket ${ticketReference(current)} has had ${current.round} guided rounds, the cap of ${roundCap}; only the owner can give it more`);
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
        if (!from.success || !canMoveTicket(current.form, current.state, "stuck")) {
          throw new TicketError(`Ticket ${ticketReference(current)} is ${current.state} and cannot stop for the owner`);
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
          throw new TicketError(`Ticket ${ticketReference(current)} is ${current.state}, not stopped for the owner`);
        }
        const given = GeneratedText.parse(where);
        updateStuckWhere.run(given.en, given.zh, id);
        touch(id);
        return existing(id);
      },
      resume: (id, reason) => {
        const current = existing(id);
        if (current.state !== "stuck" || current.stuck === null) {
          throw new TicketError(`Ticket ${ticketReference(current)} is ${current.state}, not stopped for the owner`);
        }
        const to = current.stuck.from;
        if (!canMoveTicket(current.form, "stuck", to)) {
          throw new TicketError(`Ticket ${ticketReference(current)} cannot go back to ${to}`);
        }
        const now = clock.now();
        updateState.run(to, now, id, "stuck");
        recordMove(id, "stuck", to, GeneratedText.parse(reason), now);
        clearStuck.run(id);
        touched.add(id);
        return existing(id);
      },
      recordDecisions: (id, source, decisions, place = {}) => {
        const current = existing(id);
        const known: Decision[] = [...current.decisions, ...earlierIds(id).flatMap((before) => selectDecisions.all(before).map(decisionOf))];
        const recorded: TicketDecision[] = [];
        const now = clock.now();
        for (const given of decisions) {
          const decision = Decision.parse(given);
          if (known.some((entry) => sameDecision(entry, decision))) {
            continue;
          }
          const result = insertDecision.run(
            id,
            source,
            place.attempt ?? null,
            place.pullRequest ?? null,
            decision.chosen.en,
            decision.chosen.zh,
            decision.why.en,
            decision.why.zh,
            decision.otherOptions.en,
            decision.otherOptions.zh,
            now,
          );
          known.push(decision);
          recorded.push({
            ...decision,
            id: Number(result.lastInsertRowid),
            source,
            attempt: place.attempt ?? null,
            pullRequest: place.pullRequest ?? null,
            at: now,
            verdict: null,
            opinion: null,
            reviewedAt: null,
            sentAt: null,
          });
        }
        if (recorded.length > 0) {
          touch(id);
        }
        return recorded;
      },
      settleDecision: (id, decision, review) => {
        const current = existing(id);
        const found = current.decisions.find((entry) => entry.id === decision);
        if (found === undefined) {
          throw new TicketError(`Ticket ${references.get(id) ?? "(unavailable)"} has no decision ${decision}`);
        }
        if (found.verdict !== null) {
          throw new TicketError(`Decision ${decision} of ticket ${references.get(id) ?? "(unavailable)"} is already settled`);
        }
        const now = clock.now();
        const opinion = review.verdict === "opinion" ? review.opinion.trim() : null;
        updateVerdict.run(review.verdict, opinion, now, id, decision);
        touch(id);
        return { ...found, verdict: review.verdict, opinion, reviewedAt: now };
      },
      sentDecisions: (id, decisions) => {
        const now = clock.now();
        for (const decision of decisions) {
          updateSent.run(now, id, decision);
        }
        touch(id);
      },
    };
    inside = true;
    let result: T;
    try {
      connection.exec("BEGIN IMMEDIATE");
      try {
        if (turn !== undefined) {
          versions.start(turn);
        }
        result = body(writes);
        if (turn !== undefined) {
          versions.finish(turn);
        }
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    } finally {
      inside = false;
    }
    for (const topic of changedTopics) {
      options.topicChanged?.(topic);
    }
    for (const entry of changedEntries) options.entryChanged?.(entry);
    for (const id of [...touched].sort((a, b) => a - b)) {
      const ticket = get(id);
      if (ticket !== undefined) {
        announce(ticket);
      }
    }
    return result;
  };

  const move = (id: number, to: TicketState, reason?: GeneratedText, turn?: TicketTurn): MoveResult => {
    const current = get(id);
    if (current === undefined) {
      return { ok: false, error: "not_found" };
    }
    if (!canMoveTicket(current.form, current.state, to)) {
      return { ok: false, error: "refused", ticket: current };
    }
    const ticket = change((writes) => writes.move(id, to, reason), turn);
    return { ok: true, ticket: get(id) ?? ticket };
  };

  return {
    versions,
    open: (request, turn) => {
      check(request);
      const id = change((writes) => writes.open(request), turn);
      const ticket = get(id);
      if (ticket === undefined) {
        throw new Error(`Ticket ${references.get(id) ?? "(unavailable)"} was not stored`);
      }
      return ticket;
    },
    get,
    resolve: references.resolve,
    reference: references.get,
    topic: (id) => topicOf(id) ?? change((writes) => writes.topic(id)),
    list: (listing = {}) => {
      const limit = listing.limit ?? defaultLimit;
      const rows = listing.open === true ? selectOpen.all(...openTicketStates, Number(!listing.visible), limit) : selectAll.all(Number(!listing.visible), limit);
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
        .prepare(`SELECT t.id AS id FROM tickets t WHERE t.light IS NULL AND t.ended_at IS NOT NULL AND t.joined_into IS NULL AND t.state IN (${states})${older}${matching} ORDER BY t.ended_at DESC, t.id DESC LIMIT ?`)
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
      return ticket === undefined ? undefined : { ticket, moves: movesOf(id), attempts: selectAttempts.all(id).map(workStatusOf), rounds: selectRounds.all(id).map(roundOf), switches: selectSwitches.all(id).map(switchOf) };
    },
    task: taskOf,
    lightTopicAllows,
    scheduleForTurn: scheduled.forTurn,
    repairRecord: (id) => {
      const row = selectRepairOf.get(id);
      return row === undefined ? undefined : repairOf(row);
    },
    lineage: (id) => earlierIds(id).flatMap((before) => {
      const ticket = get(before);
      return ticket === undefined ? [] : [ticket];
    }),
    repair: (id, by, words, turn) => {
      const before = get(id);
      if (before === undefined) {
        return { ok: false, reason: `There is no ticket ${references.get(id) ?? "(unavailable)"}.` };
      }
      try {
        const repair = change((writes) => writes.get(writes.openRepair(id, by, words.trim())), turn);
        const opened = repair === undefined ? undefined : get(repair.id);
        return opened === undefined ? { ok: false, reason: `The repair of ticket ${references.get(id) ?? "(unavailable)"} was not stored.` } : { ok: true, ticket: opened, followers: followersOf(opened) };
      } catch (error) {
        if (error instanceof TicketError) {
          return { ok: false, reason: error.message };
        }
        throw error;
      }
    },
    giveUp: (id, reason, words) => {
      const given = GeneratedText.parse(reason);
      const current = get(id);
      if (current === undefined) {
        return { ok: false, error: "not_found" };
      }
      if (!canMoveTicket(current.form, current.state, "stopped")) {
        return { ok: false, error: "refused" };
      }
      const repairs = hasRemainingWork(current);
      const opened = change((writes) => {
        writes.move(id, "stopped", given);
        return repairs ? writes.openRepair(id, "owner", words.trim()) : null;
      });
      const ticket = get(id);
      const repair = opened === null ? null : (get(opened) ?? null);
      if (ticket === undefined) {
        return { ok: false, error: "not_found" };
      }
      work.stop(ticket);
      return { ok: true, ticket, repair, followers: repair === null ? [] : followersOf(repair) };
    },
    rounds: (id) => selectRounds.all(id).map(roundOf),
    switches: (id) => selectSwitches.all(id).map(switchOf),
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
    reviews: () =>
      selectReviews.all(...finishedTicketStates).map((row) => {
        const value = ReviewRow.parse(row);
        return { ticket: value.ticket_id, count: value.count };
      }),
    move,
    stop: (id, reason, turn) => {
      const given = GeneratedText.parse(reason);
      const result = move(id, "stopped", given, turn);
      if (result.ok) {
        work.stop(result.ticket);
      }
      return result;
    },
    change,
    announce: (ids) => {
      for (const id of ids) {
        const ticket = get(id);
        if (ticket !== undefined) {
          announce(ticket);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
