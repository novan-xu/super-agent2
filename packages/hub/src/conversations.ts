import { ticketReferences } from "./ticket-codes.js";
import { rearrangePrefix, rearrangePrompt } from "./rearrange.js";
import { scheduleAccess } from "./schedule-access.js";
import { createHash, randomUUID } from "node:crypto";
import { brainRestartPrompt, text } from "@super-agent2/catalog";
import {
  Attachment,
  attachmentRelativePath,
  type BrainAttachment,
  type BrainInput,
  type BrainMessage,
  type BrainProviders,
  type BrainStatus,
  type BrainUpdate,
  type CommandRecord,
  Conversation,
  type ConversationDetail,
  ConversationEntry,
  type ConversationUpdate,
  type DeliveryEntry,
  type DeliveryFile,
  type GeneratedText,
  type EntryDelta,
  type EntryUpdate,
  finishedStates,
  type HistoryItem,
  type HubToBrain,
  isPrivateAppToolEvent,
  type MemoryBrief,
  OwnerEntry,
  type Question,
  type QuestionAnswer,
  QuestionAnswers,
  Provider,
  protocolVersion,
  quoteChunkLimit,
  quoteInlineLimit,
  RoutingProposal,
  type ScreenshotReport,
  type StreamEntry,
  type StreamPage,
  type StreamPreview,
  type StreamPreviewRequest,
  type StoredWorkEvent,
  streamPageSize,
  type TopicHistoryUpdate,
  type TopicMove,
  TopicScope,
  topicInScope,
  ticketProject,
  Turn,
  type TurnOutcome,
  type TurnUpdate,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { CommandService } from "./commands.js";
import type { HubDatabase } from "./database.js";
import { commandReport } from "./reports.js";
import type { TicketService } from "./tickets.js";
import { createTopicRouter, type Routing, type RoutingOptions } from "./topic-routing.js";
import { createTopicContext, type TopicContext } from "./topic-context.js";

import { createTopicCorrections, defaultTopicArchiveMilliseconds, type HandoverDestination, type TopicEdit } from "./topic-corrections.js";

export type ConversationEvent = ConversationUpdate | TurnUpdate | (EntryUpdate & StreamEntry) | EntryDelta | BrainUpdate | TopicHistoryUpdate;

export type ConversationListener = (event: ConversationEvent) => void;

export interface BrainLink {
  receive(message: BrainMessage): void;
  detach(): void;
}

export interface BrainConnection {
  send(message: HubToBrain): void;
  close(): void;
}

export interface ConversationService {
  create(): Conversation;
  rearrange(repository: string | null | undefined): Conversation | undefined;
  get(id: string): Conversation | undefined;
  list(limit?: number): Conversation[];
  announce(id: string): void;
  announceEntry(id: string): void;
  taskProgress(event: StoredWorkEvent): void;
  detail(id: string): ConversationDetail | undefined;
  entries(id: string, after?: number): ConversationEntry[];
  stream(before?: number, limit?: number, repository?: string | null | TopicScope): StreamPage;
  streamAfter(after: number, scope?: TopicScope): StreamPage;
  send(id: string, message: string, attachments?: readonly Attachment[], quotedMessage?: string): OwnerEntry | undefined;
  askOwner(conversation: string, turn: string, questions: readonly Question[]): string | undefined;
  answerQuestions(conversation: string, id: string, answers: readonly QuestionAnswer[]): OwnerEntry | undefined;
  readonly topics: TopicContext;
  previewStream(request: StreamPreviewRequest, signal?: AbortSignal): Promise<StreamPreview>;
  sendToStream(topic: string | undefined, message: string, attachments: readonly Attachment[], options?: StreamSendOptions): Promise<StreamEntry | undefined>;
  sendOwner(request: OwnerSend): Promise<SendOutcome>;
  readQuote(conversation: string, id: string, offset: number): { text: string; next: number | null } | undefined;
  assignRepository(conversation: string, turn: string, repository: string | null, topic?: string): string | undefined;
  interrupt(id: string): Conversation | undefined;
  rename(id: string, title: string): TopicEdit<string>;
  proposeTitle(conversation: string, turn: string, title: string): boolean;
  merge(source: string, destination: string): TopicEdit<string>;
  undoMerge(source: string, destination: string): TopicEdit<string>;
  mergeForBrain(current: string, turn: string, destination: string, sources: readonly string[]): { topic: string; result: string }[] | undefined;
  archive(id: string): TopicEdit<string>;
  archiveForBrain(id: string, current: string): string;
  archiveIdle(): void;
  historyRevision(): number;
  move(message: string, destination: TopicMove["destination"], source?: string): TopicEdit<string>;
  handover(source: string, turn: string, destination: HandoverDestination, message?: string, ownerRequested?: boolean): TopicEdit<string>;
  recordCommand(command: string, conversation: string): void;
  tell(ticket: number | null, notice: string, prompt: string, hidden?: boolean, screenshots?: readonly ScreenshotReport[]): string;
  writeHealthNotice(notice: string): { topics: string[]; entries: string[] };
  publishHealthNotice(result: { topics: string[]; entries: string[] }): void;
  inbox(topic: string | null, source: string, message: string): { topic: string; entry: string };
  deliver(delivery: Delivery): string;
  writeDelivery(conversation: string, delivery: Delivery): string;
  writeConfirmation(conversation: string, turn: string, message: string): string;
  tidyTopics(prompt: string): void;
  tidyNotice(notice: string): void;
  writePromptNotice(id: string, topic: string, notice: string, prompt?: string, source?: string): void;
  publishPromptNotice(id: string): void;
  writeMailReview(id: string, topic: string, prompt: string): void;
  deliverMailReview(id: string): void;
  mailReviewOf(conversation: string, turn: string): string | undefined;
  mailReviewReady(): boolean;
  writeLightQuestion(conversation: string, id: string, message: string): void;
  linked(): boolean;
  brainStatus(): BrainStatus;
  brainReady(): boolean;
  activeTurnProvider(conversation: string, turn: string): Provider | undefined;
  ownerAppTurn(conversation: string, turn: string): boolean;
  providers(): BrainProviders | undefined;
  sendOrder(order: readonly Provider[]): void;
  watchBrain(listener: () => void): () => void;
  routingSettled(): Promise<void>;
  attach(connection: BrainConnection): BrainLink;
  subscribe(listener: ConversationListener): () => void;
  close(): void;
}

interface StreamSendOptions {
  readonly voiceTranscript?: string | undefined;
  readonly quotedMessage?: string | undefined;
  readonly scope?: TopicScope | undefined;
  readonly newTopic?: true | undefined;
  readonly proposal?: RoutingProposal | undefined;
}

export interface OwnerSend extends StreamSendOptions {
  readonly id?: string | undefined;
  readonly conversation?: string | undefined;
  readonly topic?: string | undefined;
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

export type SendOutcome = { readonly ok: true; readonly item: StreamEntry } | { readonly ok: false; readonly error: "not_found" | "conflict" };

const notFound: SendOutcome = { ok: false, error: "not_found" };
const conflict: SendOutcome = { ok: false, error: "conflict" };

function sameMessage(stored: { readonly text: string; readonly attachments: readonly { readonly id: string }[]; readonly quote: string | null; readonly voiceTranscript?: string | undefined }, request: OwnerSend): boolean {
  return stored.text === request.text && stored.voiceTranscript === request.voiceTranscript && stored.quote === (request.quotedMessage ?? null)
    && stored.attachments.length === request.attachments.length
    && stored.attachments.every((attachment, index) => attachment.id === request.attachments[index]?.id);
}

export interface Delivery {
  readonly ticket: number;
  readonly title: GeneratedText;
  readonly text: string | null;
  readonly report?: GeneratedText | undefined;
  readonly files: readonly DeliveryFile[];
  readonly prompt: string;
  readonly light?: true;
}

export interface ConversationServiceOptions {
  readonly extraMcp?: readonly import("@super-agent2/protocol").ExtraMcpServer[];
  readonly mailReviewEnabled?: boolean;
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly commands: CommandService;
  readonly tickets: TicketService;
  readonly startCards?: () => import("@super-agent2/protocol").StartCard[];
  readonly memory?: MemoryBriefing;
  readonly archiveMilliseconds?: number | undefined;
  readonly order?: () => readonly Provider[] | undefined;
  readonly routing?: RoutingOptions;
  readonly lightTaskContext?: (topic: string, message: string) => string;
}

export interface MemoryBriefing {
  brief(conversation: string, seen: number | null): MemoryBrief | null;
  revision(): number;
}

type TitleOrigin = "automatic" | "brain" | "owner";

export function storeTopic(database: HubDatabase, now: number, title: string, options: { repository?: string | null; system?: boolean; codeSystem?: boolean; needsRepository?: boolean; titleOrigin?: TitleOrigin } = {}): string {
  const id = randomUUID();
  database.connection
    .prepare("INSERT INTO conversations (id, title, state, created_at, updated_at, system, repository, needs_repository, title_origin, code_system) VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, title, now, now, options.system === true ? 1 : 0, options.repository ?? null, options.needsRepository === true ? 1 : 0, options.titleOrigin ?? "owner", options.codeSystem === true ? 1 : 0);
  return id;
}

export const providerNames: Readonly<Record<Provider, string>> = { gpt: "GPT", claude: "Claude", deepseek: "DeepSeek" };

export const brainRestartedReason = text("turn.reason.brainRestarted");
export const brainAbsentReason = text("turn.reason.brainAbsent");

const titleLength = 80;
const candidateSummaryLength = 320;
const recoveredReason = "recovered after a restart";

const ConversationRow = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  topic_state: z.string(),
  repository: z.string().nullable(),
  needs_repository: z.number().int(),
  system: z.number().int(),
  code_system: z.number().int(),
  merged_into: z.string().nullable(),
  provider: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

const TurnRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  provider: z.string(),
  model: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
});

const EntryRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.number().int(),
  kind: z.string(),
  turn_id: z.string().nullable(),
  provider: z.string().nullable(),
  body: z.string(),
  prompt: z.string().nullable(),
  taken: z.number().int().nullable(),
  quote_id: z.string().nullable(),
  delivery_id: z.string().nullable(),
  created_at: z.number().int(),
  hidden: z.number().int(),
  placement: OwnerEntry.shape.placement,
  routing_rule: RoutingProposal.shape.decided.shape.rule.nullish(),
  repository_cap: z.number().int().nullish(),
});
type EntryRow = z.infer<typeof EntryRow>;

const Body = z.looseObject({
  text: z.string().nullable().optional(),
  ticket: z.number().optional(),
  title: z.unknown().optional(),
  report: z.unknown().optional(),
  files: z.unknown().optional(),
  attachments: z.unknown().optional(),
  name: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  state: z.string().optional(),
  possibleMatch: z.string().optional(),
  voiceTranscript: z.string().optional(),
  destination: z.string().optional(),
  start: z.boolean().optional(),
  questionResponse: z.object({ card: z.string(), answers: QuestionAnswers }).optional(),
});

const PendingInput = z.object({ id: z.string(), created_at: z.number().int(), body: z.string() });
const PendingBody = z.object({ message: z.string(), attachments: z.array(Attachment), scope: TopicScope, voiceTranscript: z.string().optional() });

const SessionRow = z.object({ session: z.string().nullable(), through: z.number().int(), memory_seen: z.number().int(), memory_offered: z.number().int(), board_seen: z.number().int() });

const BrainCommandRow = z.object({ conversation_id: z.string(), held: z.number().int(), reported: z.number().int() });

const SeqRow = z.object({ seq: z.number().int() });
const StreamRow = EntryRow.extend({ stream_seq: z.number().int().positive(), topic_title: z.string(), repository: z.string().nullable(), needs_repository: z.number().int(), system: z.number().int(), code_system: z.number().int(), latest_owner: z.number().nullable() });

function toConversation(row: unknown): Conversation {
  const value = ConversationRow.parse(row);
  return Conversation.parse({
    id: value.id,
    title: value.title,
    state: value.state,
    topicState: value.topic_state,
    repository: value.repository,
    ...(value.needs_repository === 1 ? { needsRepository: true } : {}),
    ...(value.system === 1 || value.code_system === 1 ? { system: true } : {}),
    ...(value.merged_into === null ? {} : { mergedInto: value.merged_into }),
    provider: value.provider,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  });
}

function toStreamEntry(row: unknown): StreamEntry {
  const value = StreamRow.parse(row);
  const topic = {
    id: value.conversation_id, title: value.topic_title, repository: value.repository,
    ...(value.needs_repository === 1 ? { needsRepository: true as const } : {}),
    ...(value.system === 1 || value.code_system === 1 ? { system: true as const } : {}),
  };
  return {
    position: value.stream_seq, topic, entry: toEntry(value),
    ...(value.latest_owner === null ? {} : { latestOwner: value.latest_owner === 1 }),
  };
}

function toTurn(row: unknown): Turn {
  const value = TurnRow.parse(row);
  return Turn.parse({
    id: value.id,
    conversation: value.conversation_id,
    provider: value.provider,
    model: value.model,
    state: value.state,
    reason: value.reason,
    startedAt: value.started_at,
    endedAt: value.ended_at,
  });
}

function toEntry(row: EntryRow): ConversationEntry {
  const body = Body.parse(JSON.parse(row.body));
  const base = { id: row.id, conversation: row.conversation_id, seq: row.seq, at: row.created_at };
  switch (row.kind) {
    case "owner":
      return ConversationEntry.parse({
        ...base, kind: "owner", text: body.text, attachments: body.attachments ?? [], taken: row.taken === 1,
        placement: row.placement ?? "owner",
        ...(body.voiceTranscript === undefined ? {} : { voiceTranscript: body.voiceTranscript }),
        ...(row.quote_id === null ? {} : { quotedMessage: row.quote_id }),
        ...(body.possibleMatch === undefined ? {} : { possibleMatch: body.possibleMatch }),
      });
    case "chains":
      return ConversationEntry.parse({ ...base, kind: "chains", turn: row.turn_id, chains: body.chains });
    case "question":
      return ConversationEntry.parse({ ...base, kind: "question", turn: row.turn_id, questions: body.questions, answer: body.answer ?? null });
    case "notice":
      return ConversationEntry.parse({ ...base, kind: "notice", text: body.text, turn: row.turn_id,
        ...(typeof body.source === "string" ? { source: body.source } : {}),
        ...(body.ticket === undefined ? {} : { ticket: body.ticket }), ...(body.destination === undefined ? {} : { destination: body.destination }),
        ...(body.start === true ? { start: true } : {}), ...(body.worker === true ? { worker: true } : {}),
        ...(body.screenshots === undefined ? {} : { screenshots: body.screenshots }) });
    case "delivery":
      return ConversationEntry.parse({
        ...base,
        kind: "delivery",
        turn: row.turn_id,
        ticket: body.ticket,
        title: body.title,
        light: body.light,
        text: body.text ?? null,
        report: body.report ?? null,
        files: body.files,
      });
    case "text":
      return ConversationEntry.parse({ ...base, kind: "text", turn: row.turn_id, text: body.text });
    default:
      return ConversationEntry.parse({
        ...base,
        kind: "tool",
        turn: row.turn_id,
        name: body.name,
        input: body.input,
        output: body.output,
        state: body.state,
      });
  }
}

function forBrain(attachments: readonly Attachment[]): BrainAttachment[] {
  return attachments.map((attachment) => ({ ...attachment, path: attachmentRelativePath(attachment) }));
}

function titleOf(message: string, attachments: readonly Attachment[] = []): string {
  const line = message.trim().slice(0, titleLength * 2).split(/\r?\n/, 1)[0] || (attachments[0]?.name ?? "");
  const characters = [...line];
  return characters.length > titleLength ? `${characters.slice(0, titleLength - 1).join("")}…` : line;
}

function deliveryHistory(entry: DeliveryEntry, reference: string | undefined): string {
  const files = entry.files.length === 0 ? "" : ` Files: ${entry.files.map((file) => file.name).join(", ")}.`;
  const report = entry.report === null ? "" : ` The worker's report: ${entry.report.en}`;
  const task = entry.light === true ? "light task" : `task ticket${reference === undefined ? "" : ` ${reference}`}`;
  return `[hub] The result of ${task} (${entry.title.en}) was delivered to the owner here.${report}${files}${entry.text === null ? "" : `\n${entry.text}`}`;
}

function ownerPrompt(message: string, transcript: string | undefined) {
  return transcript === undefined ? message
    : `${message}\n\n<details><summary>Voice call transcript (reference only)</summary>\n\n${transcript.replace(/<\/details>/gi, "&lt;/details&gt;")}\n\n</details>`;
}

function historyItem(raw: unknown, reference: (id: number) => string | undefined): HistoryItem {
  const row = EntryRow.parse(raw);
  const entry = toEntry(row);
  const provider = row.provider === null ? null : Provider.parse(row.provider);
  switch (entry.kind) {
    case "owner":
      return { kind: "owner", text: ownerPrompt(entry.text, entry.voiceTranscript), attachments: forBrain(entry.attachments) };
    case "chains":
      return { kind: "notice", text: "[hub] Start cards were shown to the owner." };
    case "question":
      return { kind: "notice", text: JSON.stringify({ questions: entry.questions, answer: entry.answer }) };
    case "notice":
      return { kind: "notice", text: entry.source === undefined ? entry.text : `[${entry.source}] ${entry.text}` };
    case "delivery":
      return { kind: "notice", text: deliveryHistory(entry, reference(entry.ticket)) };
    case "text":
      return { kind: "text", provider, text: entry.text };
    case "tool":
      return { kind: "tool", provider, name: entry.name, input: entry.input, output: entry.output };
  }
}

function heldPrompt(command: CommandRecord, output: string, conversation: string): string {
  return [
    `[hub] The command ${command.id} that was held for the owner's confirmation has an outcome.`,
    `The command was originally requested in topic ${conversation}.`,
    commandReport(command, output),
    "Tell the owner what happened and carry on from there.",
  ].join("\n");
}

export function createConversationService(options: ConversationServiceOptions): ConversationService {
  const { connection } = options.database;
  const { clock, commands, tickets } = options;
  const references = ticketReferences(connection);
  const toHistoryItem = (raw: unknown) => historyItem(raw, references.get);
  const topics = createTopicContext(options.database, toHistoryItem, (id) => corrections.resolve(id) ?? id);
  const listeners = new Set<ConversationListener>();
  let link: { readonly connection: BrainConnection; ready: boolean; mailReview: boolean } | undefined;
  let closing = false;
  let brainProviders: BrainProviders | undefined;
  let lastTurnModel: string | null = null;
  let brainStatus: BrainStatus = { linked: false, model: null };
  const brainListeners = new Set<() => void>();
  const brainChanged = () => {
    for (const listener of brainListeners) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  };

  const router = createTopicRouter(options.database, { clock, ...options.routing });
  const schedules = scheduleAccess(options.database);
  const selectConversation = connection.prepare("SELECT * FROM conversations WHERE id = ?");
  const assignTopicRepository = connection.prepare(`
    UPDATE conversations SET needs_repository = 0, repository = ?, updated_at = ?
    WHERE id = ? AND system = 0 AND code_system = 0 AND merged_into IS NULL
      AND (repository IS NULL OR ? IS NULL OR repository = ? COLLATE NOCASE)
      AND NOT EXISTS (SELECT 1 FROM tickets WHERE conversation_id = conversations.id AND light IS NULL AND coalesce(repository, project) IS NOT ? COLLATE NOCASE)
      AND NOT EXISTS (SELECT 1 FROM topic_merges WHERE source = conversations.id OR destination = conversations.id)
  `);
  const assignmentTurn = connection.prepare("SELECT 1 FROM turns WHERE id = ? AND conversation_id = ? AND state = 'running' AND ticket_writes_revoked = 0");
  const changeTopicHistory = connection.prepare("UPDATE topic_history_revision SET revision = revision + 1");
  const selectConversations = connection.prepare("SELECT * FROM conversations WHERE merged_into IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?");
  const savePending = connection.prepare("INSERT INTO pending_topic_inputs (id, body, created_at) VALUES (?, ?, ?)");
  const listPending = connection.prepare("SELECT * FROM pending_topic_inputs ORDER BY created_at, rowid");
  const deletePending = connection.prepare("DELETE FROM pending_topic_inputs WHERE id = ?");
  const activeRearrange = connection.prepare(`SELECT 1 FROM conversation_entries e
    LEFT JOIN turns t ON t.id = e.turn_id
    WHERE e.kind = 'notice' AND (e.taken = 0 OR t.state = 'running')
      AND (substr(e.prompt, 1, ?) = ? OR json_extract(e.body, '$.rearrange') = 1) LIMIT 1`);
  const selectSystem = connection.prepare("SELECT * FROM conversations WHERE system = 1");
  const selectCodeSystem = connection.prepare("SELECT * FROM conversations WHERE code_system = 1");
  const selectTurn = connection.prepare("SELECT * FROM turns WHERE id = ?");
  const selectTurns = connection.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY started_at, rowid");
  const selectRunningTurns = connection.prepare("SELECT * FROM turns WHERE state = 'running' ORDER BY rowid");
  const selectRunningTurn = connection.prepare("SELECT * FROM turns WHERE conversation_id = ? AND state = 'running' LIMIT 1");
  const updateWorkState = connection.prepare("UPDATE conversations SET state = ?, updated_at = ? WHERE id = ?");
  const insertTurn = connection.prepare(
    "INSERT INTO turns (id, conversation_id, provider, model, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
  );
  const finishTurn = connection.prepare("UPDATE turns SET state = ?, reason = ?, ended_at = ?, ticket_writes_revoked = 1, proposed_title = NULL WHERE id = ?");
  const revokeTicketWrites = connection.prepare("UPDATE turns SET ticket_writes_revoked = 1 WHERE id = ?");
  const changeTurnProvider = connection.prepare("UPDATE turns SET provider = ?, model = ? WHERE id = ?");
  const proposeTitle = connection.prepare(`
    UPDATE turns SET proposed_title = ?
    WHERE id = ? AND conversation_id = ? AND state = 'running' AND ticket_writes_revoked = 0 AND EXISTS (
      SELECT 1 FROM conversations WHERE id = turns.conversation_id AND merged_into IS NULL AND title_origin IN ('automatic', 'brain')
    )
  `);
  const applyTitle = connection.prepare(`
    UPDATE conversations SET title = turns.proposed_title, title_origin = 'brain'
    FROM turns
    WHERE turns.id = ? AND conversations.id = turns.conversation_id AND turns.proposed_title IS NOT NULL
      AND turns.ticket_writes_revoked = 0 AND conversations.merged_into IS NULL
      AND conversations.title_origin IN ('automatic', 'brain')
  `);
  const activateOwnerTopic = connection.prepare(`
    UPDATE conversations SET topic_state = 'active', updated_at = ?,
      title = CASE WHEN title_origin = 'automatic' AND title = '' THEN ? ELSE title END
    WHERE id = ?
  `);
  const originalPlacement = "r.moved_at IS NULL AND e.handed_over = 0 AND e.conversation_id = r.placed_in";
  const placedByRouter = `${originalPlacement} AND coalesce(r.owner_placed, r.owner_changed) = 0`;
  const joinedByRouter = `${placedByRouter} AND r.topic = r.placed_in`;
  const placement = `CASE WHEN ${joinedByRouter} THEN 'router-joined'
    WHEN ${placedByRouter} THEN 'router-opened'
    ELSE 'owner' END AS placement`;
  const entrySource = "conversation_entries AS e LEFT JOIN routing_decisions AS r ON r.entry = e.id AND e.kind = 'owner'";
  const routingColumns = `${placement}, CASE WHEN ${originalPlacement} AND r.owner_placed = 0 THEN r.rule END AS routing_rule, r.repository_cap`;
  const selectEntry = connection.prepare(`SELECT e.*, ${routingColumns} FROM ${entrySource} WHERE e.id = ?`);
  const scheduledInput = connection.prepare(`SELECT id FROM schedule_runs WHERE state = 'pending'
    AND ((entry = ? AND continuation_entry IS NULL) OR continuation_entry = ?)`);
  const continueSchedule = connection.prepare("UPDATE schedule_runs SET continuation_entry = ? WHERE id = ?");
  const priorHubInputs = connection.prepare(`SELECT prompt, json_extract(body, '$.restartOf') AS restart_of
    FROM conversation_entries WHERE turn_id = ? AND taken = 1 AND kind IN ('notice', 'delivery') AND prompt IS NOT NULL ORDER BY seq`);
  const ownerAppInput = connection.prepare(`SELECT 1 FROM conversation_entries
    WHERE conversation_id = ? AND turn_id = ? AND taken = 1 AND kind = 'owner' AND hidden = 0 LIMIT 1`);
  const findMailReview = connection.prepare(`SELECT id FROM conversation_entries
    WHERE conversation_id = ? AND turn_id = ? AND taken = 1 AND hidden = 1 AND json_extract(body, '$.mailReview') = 1 LIMIT 1`);
  const mailReviewOf = (conversation: string, turn: string): string | undefined =>
    z.string().optional().parse(findMailReview.get(conversation, turn)?.["id"]);
  const selectOriginalRoute = connection.prepare("SELECT scope, placed_in FROM routing_decisions WHERE entry = ? AND owner_placed IS NOT 1 AND moved_at IS NULL AND brain_moved_at IS NULL");
  const hasQuote = connection.prepare(`
    SELECT 1 FROM conversation_entries WHERE conversation_id = ? AND quote_id = ? LIMIT 1
  `);
  const selectEntries = connection.prepare(
    `SELECT e.*, ${placement} FROM ${entrySource}
     WHERE e.conversation_id = ? AND e.hidden = 0 AND (e.seq > ? OR e.turn_id IN (SELECT id FROM turns WHERE conversation_id = ? AND state = 'running')) ORDER BY e.seq`,
  );
  const selectAfter = connection.prepare("SELECT * FROM conversation_entries WHERE conversation_id = ? AND seq > ? AND hidden = 0 AND (? OR taken IS NOT 0) ORDER BY seq");
  const selectWaiting = connection.prepare(`SELECT e.*, ${routingColumns} FROM ${entrySource} WHERE e.taken = 0 ORDER BY e.created_at, e.rowid`);
  const selectTopicWaiting = connection.prepare(`SELECT e.*, ${routingColumns} FROM ${entrySource} WHERE e.conversation_id = ? AND e.taken = 0 ORDER BY e.seq`);
  const selectLastSeq = connection.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_entries WHERE conversation_id = ?");
  const insertEntry = connection.prepare(
    `INSERT INTO conversation_entries (id, conversation_id, seq, kind, turn_id, provider, body, prompt, taken, created_at, quote_id, hidden, stream_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(stream_seq), 0) + 1 FROM conversation_entries))`,
  );
  const streamSelect = `SELECT e.*, ${routingColumns}, c.title AS topic_title, c.repository, c.needs_repository, c.system, c.code_system,
    CASE WHEN ${joinedByRouter} THEN NOT EXISTS (
      SELECT 1 FROM conversation_entries AS later WHERE later.conversation_id = e.conversation_id AND later.seq > e.seq AND later.kind = 'owner'
    ) END AS latest_owner
    FROM ${entrySource} JOIN conversations AS c ON c.id = e.conversation_id`;
  const selectStreamEntry = connection.prepare(`${streamSelect} WHERE e.id = ? AND e.hidden = 0`);
  const selectStreamPage = connection.prepare(`${streamSelect} WHERE e.hidden = 0 AND e.stream_seq < ? ORDER BY e.stream_seq DESC LIMIT ?`);
  const scopeFilter = `AND CASE ?
    WHEN 'code' THEN c.repository IS NOT NULL OR c.needs_repository = 1
    WHEN 'daily' THEN c.repository IS NULL AND c.needs_repository = 0
    ELSE c.repository = ? COLLATE NOCASE END`;
  const selectStreamScoped = connection.prepare(`${streamSelect} WHERE e.hidden = 0 AND e.stream_seq < ? ${scopeFilter} ORDER BY e.stream_seq DESC LIMIT ?`);
  const selectStreamAfter = connection.prepare(`${streamSelect} WHERE e.hidden = 0 AND e.stream_seq > ? ORDER BY e.stream_seq`);
  const selectScopedAfter = connection.prepare(`${streamSelect} WHERE e.hidden = 0 AND e.stream_seq > ? ${scopeFilter} ORDER BY e.stream_seq`);
  const updateBody = connection.prepare("UPDATE conversation_entries SET body = ? WHERE id = ?");
  const markTaken = connection.prepare(
    "UPDATE conversation_entries SET taken = 1, turn_id = COALESCE(turn_id, ?) WHERE coalesce(delivery_id, id) = ? AND conversation_id = ? AND taken = 0 RETURNING id",
  );
  const quietTurn = connection.prepare(`
    SELECT 1 FROM conversation_entries WHERE turn_id = ? AND hidden = 1 AND taken = 1
    AND NOT EXISTS (SELECT 1 FROM conversation_entries WHERE turn_id = ? AND hidden = 0 AND taken = 1)
    LIMIT 1
  `);
  const isQuiet = (turn: string) => quietTurn.get(turn, turn) !== undefined;
  const selectSession = connection.prepare("SELECT session, through, memory_seen, memory_offered, board_seen FROM program_sessions WHERE conversation_id = ? AND provider = ?");
  const discardSession = connection.prepare("DELETE FROM program_sessions WHERE conversation_id = ? AND provider = ?");
  const upsertSession = connection.prepare(
    "INSERT INTO program_sessions (conversation_id, provider, session, through, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (conversation_id, provider) DO UPDATE SET session = excluded.session, through = CASE WHEN program_sessions.session IS NULL OR program_sessions.session = excluded.session THEN program_sessions.through ELSE 0 END, memory_seen = CASE WHEN program_sessions.session IS NULL OR program_sessions.session = excluded.session THEN program_sessions.memory_seen ELSE 0 END, board_seen = CASE WHEN program_sessions.session IS NULL OR program_sessions.session = excluded.session THEN program_sessions.board_seen ELSE 0 END, updated_at = excluded.updated_at",
  );
  const advanceSession = connection.prepare(
    "INSERT INTO program_sessions (conversation_id, provider, session, through, updated_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT (conversation_id, provider) DO UPDATE SET through = excluded.through, memory_seen = MAX(program_sessions.memory_seen, program_sessions.memory_offered), board_seen = program_sessions.board_offered, updated_at = excluded.updated_at",
  );
  const offerContext = connection.prepare(
    "INSERT INTO program_sessions (conversation_id, provider, session, through, memory_offered, board_offered, updated_at) VALUES (?, ?, NULL, 0, ?, ?, ?) ON CONFLICT (conversation_id, provider) DO UPDATE SET memory_offered = excluded.memory_offered, board_offered = excluded.board_offered",
  );
  const seeMemory = connection.prepare(
    "UPDATE program_sessions SET memory_seen = MAX(memory_seen, ?) WHERE conversation_id = ? AND provider = ?",
  );
  const selectConsumedSeq = connection.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_entries WHERE conversation_id = ? AND taken IS NOT 0");
  const insertBrainCommand = connection.prepare(
    "INSERT INTO brain_commands (command_id, conversation_id) VALUES (?, ?) ON CONFLICT (command_id) DO NOTHING",
  );
  const selectBrainCommand = connection.prepare("SELECT conversation_id, held, reported FROM brain_commands WHERE command_id = ?");
  const markHeld = connection.prepare("UPDATE brain_commands SET held = 1 WHERE command_id = ?");
  const markReported = connection.prepare("UPDATE brain_commands SET reported = 1 WHERE command_id = ?");

  const emit = (event: ConversationEvent) => {
    if (event.type === "entry" || event.type === "turn") {
      router.refresh();
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  };

  const publishBrainStatus = () => {
    const linked = link !== undefined;
    const reported = brainProviders?.model;
    const configured = brainProviders?.providers.find((provider) => provider.available && provider.model.trim() !== "")?.model;
    const model = linked ? (reported === undefined ? lastTurnModel ?? configured?.trim() ?? null : reported?.trim() || null) : null;
    if (brainStatus.linked !== linked || brainStatus.model !== model) {
      brainStatus = { linked, model };
      emit({ type: "brain", brain: brainStatus });
    }
  };

  const rememberTurnModel = (model: string) => {
    if (model.trim() !== "") lastTurnModel = model.trim();
    publishBrainStatus();
  };

  const withMerge = (row: unknown): Conversation => {
    const topic = toConversation(row);
    const sources = topic.mergedInto === undefined ? corrections.mergedSources(topic.id) : [];
    return {
      ...topic,
      ...(corrections.pending(topic.id) ? { mergePending: true } : {}),
      ...(sources.length > 0 ? { mergedSources: sources } : {}),
    };
  };

  const rawGet = (id: string): Conversation | undefined => {
    const row = selectConversation.get(id);
    return row === undefined ? undefined : withMerge(row);
  };

  const get = (id: string): Conversation | undefined => {
    const topic = corrections.resolve(id);
    return topic === undefined ? undefined : rawGet(topic);
  };

  const getTurn = (id: string): Turn | undefined => {
    const row = selectTurn.get(id);
    return row === undefined ? undefined : toTurn(row);
  };

  const streamTurns = (entries: readonly StreamEntry[], scope?: TopicScope): Turn[] => {
    const turns = new Map<string, Turn>();
    for (const { entry } of entries) {
      if (entry.kind !== "owner" && entry.turn !== null && !turns.has(entry.turn)) {
        const turn = getTurn(entry.turn);
        if (turn !== undefined) {
          turns.set(turn.id, turn);
        }
      }
    }
    if (scope !== undefined) {
      for (const turn of selectRunningTurns.all().map(toTurn)) {
        if (isQuiet(turn.id)) continue;
        const topic = get(turn.conversation);
        if (topic !== undefined && topicInScope(topic, scope)) {
          turns.set(turn.id, turn);
        }
      }
    }
    return [...turns.values()];
  };

  const getEntry = (id: string): ConversationEntry | undefined => {
    const row = selectEntry.get(id);
    return row === undefined ? undefined : toEntry(EntryRow.parse(row));
  };

  const quoteOf = (id: string) => {
    const found = selectEntry.get(id);
    if (found === undefined) {
      return undefined;
    }
    const row = EntryRow.parse(found);
    if (row.hidden === 1) return undefined;
    const entry = toEntry(row);
    let item: Exclude<HistoryItem, { kind: "tool" }>;
    switch (entry.kind) {
      case "tool":
      case "question":
      case "chains":
        return undefined;
      case "owner":
        item = { kind: "owner", text: entry.text, attachments: forBrain(entry.attachments) };
        break;
      case "text":
        item = { kind: "text", provider: row.provider === null ? null : Provider.parse(row.provider), text: entry.text };
        break;
      case "notice":
        item = { kind: "notice", text: entry.text };
        break;
      case "delivery":
        item = { kind: "notice", text: entry.text ?? entry.report?.zh ?? entry.title.zh };
        break;
    }
    return { conversation: entry.conversation, item };
  };

  const announce = (id: string) => {
    const conversation = rawGet(id);
    if (conversation !== undefined) {
      emit({ type: "conversation", conversation });
    }
  };

  const writeConversation = (id: string, fields: Readonly<Record<string, string | number | null>>) => {
    const names = Object.keys(fields);
    const assignments = [...names.map((name) => `${name} = ?`), "updated_at = ?"].join(", ");
    connection.prepare(`UPDATE conversations SET ${assignments} WHERE id = ?`).run(...names.map((name) => fields[name] ?? null), clock.now(), id);
  };

  const updateConversation = (id: string, fields: Readonly<Record<string, string | number | null>>) => {
    writeConversation(id, fields);
    announce(id);
  };

  const emitTurn = (id: string) => {
    const turn = getTurn(id);
    if (turn !== undefined && !isQuiet(id)) {
      emit({ type: "turn", turn });
    }
  };

  const emitEntry = (id: string) => {
    const row = selectStreamEntry.get(id);
    if (row !== undefined) {
      emit({ type: "entry", ...toStreamEntry(row) });
    }
  };

  const lastSeq = (conversation: string) => SeqRow.parse(selectLastSeq.get(conversation)).seq;

  interface NewEntry {
    readonly id?: string;
    readonly conversation: string;
    readonly kind: ConversationEntry["kind"];
    readonly turn: string | null;
    readonly provider?: Provider | null;
    readonly body: Readonly<Record<string, unknown>>;
    readonly prompt?: string;
    readonly at?: number;
    readonly quote?: string;
    readonly hidden?: true;
  }

  const writeEntry = (entry: NewEntry): string => {
    const id = entry.id ?? randomUUID();
    insertEntry.run(
      id,
      entry.conversation,
      lastSeq(entry.conversation) + 1,
      entry.kind,
      entry.turn,
      entry.provider ?? null,
      JSON.stringify(entry.body),
      entry.prompt ?? null,
      entry.prompt === undefined ? null : 0,
      entry.at ?? clock.now(),
      entry.quote ?? null,
      entry.hidden === true ? 1 : 0,
    );
    return id;
  };

  const addEntry = (entry: NewEntry): string => {
    const id = writeEntry(entry);
    emitEntry(id);
    return id;
  };

  const bodyOf = (id: string): Record<string, string> | undefined => {
    const row = selectEntry.get(id);
    if (row === undefined) {
      return undefined;
    }
    const parsed = Body.parse(JSON.parse(EntryRow.parse(row).body));
    const body: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        body[name] = value;
      }
    }
    return body;
  };

  const sendToBrain = (message: HubToBrain): boolean => {
    if (link === undefined || !link.ready) {
      return false;
    }
    try {
      link.connection.send(message);
      return true;
    } catch {
      return false;
    }
  };

  const routingNote = (row: EntryRow, match?: string): BrainInput["routing"] => {
    const rule = row.routing_rule;
    if (rule == null) return undefined;
    if (row.placement === "router-joined") {
      return { placement: "existing", rule, ...(row.repository_cap === 1 ? { repositoryCap: true } : {}) };
    }
    const topic = match === undefined ? undefined : get(match);
    if (topic === undefined || topic.id === row.conversation_id) return { placement: "new", rule };
    const characters = [...topics.summary(topic.id).replace(/\s+/gu, " ").trim()];
    const summary = characters.length > candidateSummaryLength
      ? `${characters.slice(0, candidateSummaryLength - 1).join("")}…`
      : characters.join("");
    return { placement: "new", rule, candidate: { id: topic.id, title: topic.title, summary } };
  };

  const deliver = (row: EntryRow) => {
    if (row.prompt === null || row.taken !== 0 || corrections.blocked(row.conversation_id, row.seq)) {
      return;
    }
    const mailReview = row.hidden === 1 && row.kind === "notice"
      && z.object({ mailReview: z.literal(true) }).safeParse(JSON.parse(row.body)).success;
    if (mailReview && (options.mailReviewEnabled !== true || link?.mailReview !== true)) return;
    const body = row.kind === "owner" ? Body.parse(JSON.parse(row.body)) : undefined;
    const attached = z.array(Attachment).catch([]).parse(body?.attachments ?? []);
    const scheduleRun = row.kind === "notice" ? scheduledInput.get(row.id, row.id)?.id : undefined;
    const input: BrainInput = {
      id: row.delivery_id ?? row.id, ...(row.delivery_id === null ? {} : { entry: row.id }),
      source: row.kind === "owner" ? "owner" : "hub",
      text: row.prompt + (row.kind === "owner" ? (options.lightTaskContext?.(row.conversation_id, row.id) ?? "") : ""),
      attachments: forBrain(attached),
      ...(typeof scheduleRun === "string" ? { scheduleRun } : {}),
      ...(mailReview ? { mailReview: true } : {}),
      ...(body?.questionResponse === undefined ? {} : { questionResponse: body.questionResponse }),
    };
    const routing = routingNote(row, body?.possibleMatch);
    if (routing !== undefined) {
      input.routing = routing;
    }
    if (row.quote_id !== null) {
      const quoted = quoteOf(row.quote_id);
      if (quoted !== undefined) {
        const { item } = quoted;
        input.quote = item.text.length <= quoteInlineLimit ? { id: row.quote_id, item } : {
          id: row.quote_id,
          ...(item.kind === "owner" ? { attachments: item.attachments } : {}),
        };
      }
    }
    if (body !== undefined && get(row.conversation_id)?.needsRepository === true) {
      input.needsRepository = true;
    }
    sendToBrain({ type: "input", conversation: row.conversation_id, input });
  };

  const openTopic = (at: number, title: string, scope: TopicScope, repository: string | null, titleOrigin: TitleOrigin = "automatic") =>
    storeTopic(options.database, at, title, { repository, needsRepository: scope.kind === "code" && repository === null, titleOrigin });

  const createMoveDestination = (id: string, at: number, title?: string) => {
    const row = EntryRow.parse(selectEntry.get(id));
    const owner = OwnerEntry.parse(toEntry(row));
    const source = toConversation(selectConversation.get(row.conversation_id));
    const original = selectOriginalRoute.get(id);
    const repository = original?.["scope"] === "repository" ? rawGet(z.string().parse(original["placed_in"]))?.repository ?? source.repository : source.repository;
    const scope: TopicScope = original?.["scope"] === "daily" ? { kind: "daily" }
      : original?.["scope"] === "code" ? { kind: "code" }
      : repository !== null ? { kind: "repository", repository }
      : source.needsRepository === true ? { kind: "code" } : { kind: "daily" };
    const targetRepository = router.repositoryFor(owner.text, scope) ?? (title !== undefined && scope.kind === "code" ? source.repository : null);
    const capped = title === undefined ? undefined : router.cappedHandover(targetRepository, source.id, owner.text, at);
    return capped === undefined
      ? { target: openTopic(at, title ?? titleOf(owner.text, owner.attachments), scope, targetRepository, title === undefined ? "automatic" : "brain") }
      : { target: capped, repositoryCap: true as const };
  };

  const corrections = createTopicCorrections({
    database: options.database,
    clock,
    archiveMilliseconds: options.archiveMilliseconds ?? defaultTopicArchiveMilliseconds,
    ready: () => link?.ready === true,
    send: sendToBrain,
    topic: rawGet,
    isRouted: (entry) => EntryRow.parse(selectEntry.get(entry)).routing_rule != null,
    createMoveDestination,
    announce,
    historyChanged: (topics) => emit({ type: "topic.history", topics }),
    ticketsChanged: tickets.announce,
    deliverTopic: (id) => selectTopicWaiting.all(id).forEach((row) => deliver(EntryRow.parse(row))),
    saveSummary: topics.saveSummary,
  });

  const runningTurnOf = (conversation: string): Turn | undefined => {
    const row = selectRunningTurn.get(conversation);
    return row === undefined ? undefined : toTurn(row);
  };

  const writeRestartNotice = (turn: Turn): string | undefined => {
    if (mailReviewOf(turn.conversation, turn.id) !== undefined) return undefined;
    const inputs = z.array(z.object({ prompt: z.string(), restart_of: z.string().nullable() })).parse(priorHubInputs.all(turn.id));
    if (inputs.some((input) => input.restart_of !== null)) return undefined;
    const run = schedules.forTurn({ id: turn.id, conversation: turn.conversation });
    if (run !== undefined && !run.authorized) return undefined;
    const priorPrompts = inputs.map((input) => input.prompt);
    const id = writeEntry({
      conversation: turn.conversation, kind: "notice", turn: null,
      body: { text: text("notice.brainRestartContinuation"), restartOf: turn.id, ...(priorPrompts.some((prior) => prior.startsWith(rearrangePrefix)) ? { rearrange: true } : {}) },
      prompt: brainRestartPrompt(turn.id, priorPrompts),
      ...(isQuiet(turn.id) ? { hidden: true } : {}),
    });
    if (run !== undefined) continueSchedule.run(id, run.id);
    return id;
  };

  const endTurn = (id: string, outcome: TurnOutcome, reason: string | null, { applied = false, restarting = false } = {}) => {
    const row = selectTurn.get(id);
    if (row === undefined || row.state !== "running") {
      return;
    }
    const turn = toTurn(row);
    let continuation: string | undefined;
    let chainEntry: string | undefined;
    connection.exec("BEGIN IMMEDIATE");
    try {
      if (restarting && row.ticket_writes_revoked === 0) {
        continuation = writeRestartNotice(turn);
      }
      if (outcome === "completed") {
        applyTitle.run(id);
      }
      const changed = new Set(connection.prepare("SELECT ticket_id FROM turn_start_tickets WHERE turn_id = ?").all(id).map((row) => Number(row["ticket_id"])));
      const cards = changed.size === 0 ? [] : options.startCards?.() ?? [];
      const dependsOn = (ticket: number, root: number, seen = new Set<number>()): boolean => {
        if (ticket === root) return true;
        if (seen.has(ticket)) return false;
        seen.add(ticket);
        return cards.find((card) => card.ticket.id === ticket)?.ticket.waits.some((wait) => !wait.waived && dependsOn(wait.ticket, root, seen)) ?? false;
      };
      const selected = cards.filter((card) => card.startable && [...changed].some((ticket) => dependsOn(ticket, card.ticket.id)));
      if (selected.length > 0) chainEntry = writeEntry({ conversation: turn.conversation, kind: "chains", turn: id, body: { chains: selected.map((card) => ({ ticket: card.ticket.id, fingerprint: card.fingerprint })) } });
      finishTurn.run(outcome, reason, clock.now(), id);
      topics.finish(turn.conversation, id, outcome);
      if (applied && mailReviewOf(turn.conversation, id) === undefined) {
        advanceSession.run(turn.conversation, turn.provider, SeqRow.parse(selectConsumedSeq.get(turn.conversation)).seq, clock.now());
      }
      updateWorkState.run(runningTurnOf(turn.conversation) === undefined ? "idle" : "working", clock.now(), turn.conversation);
      corrections.archiveAfterTurn(turn.conversation);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
    emitTurn(id);
    if (continuation !== undefined) emitEntry(continuation);
    if (chainEntry !== undefined) emitEntry(chainEntry);
    announce(turn.conversation);
    corrections.finishOfflineMerges();
  };

  const history = (conversation: string, through: number, exclude: ReadonlySet<string>, includeWaiting: boolean): HistoryItem[] =>
    selectAfter
      .all(conversation, through, Number(includeWaiting))
      .map((row) => EntryRow.parse(row))
      .filter((row) => !exclude.has(row.id))
      .map(toHistoryItem);

  const providerOfTurn = (turn: string): Provider | null => {
    const found = getTurn(turn);
    return found === undefined ? null : found.provider;
  };

  const appendField = (id: string, field: "text" | "output", delta: string) => {
    const body = bodyOf(id);
    const entry = getEntry(id);
    if (body === undefined || entry === undefined) {
      return;
    }
    body[field] = (body[field] ?? "") + delta;
    updateBody.run(JSON.stringify(body), id);
    emit({ type: "delta", conversation: entry.conversation, entry: id, field, text: delta });
  };

  const known = (conversation: string, turn: string) => {
    const found = getTurn(turn);
    return found?.state === "running" && found.conversation === conversation;
  };

  const receive = (message: BrainMessage) => {
    switch (message.type) {
      case "usage.attempt": {
        if (known(message.conversation, message.turn)) connection.prepare(`INSERT INTO brain_usage (turn, attempt, topic, provider, model, at, seed) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (turn, attempt) DO UPDATE SET model = excluded.model, seed = coalesce(excluded.seed, brain_usage.seed)`).run(message.turn, message.attempt, message.conversation, message.provider, message.model, clock.now(), message.seed === null ? null : JSON.stringify(message.seed));
        return;
      }
      case "usage.update": {
        if (known(message.conversation, message.turn)) connection.prepare(`UPDATE brain_usage SET model = ?, input = ?, cache_read = ?, cache_write = ?, output = ?, reasoning = ?, cost_usd = ? WHERE turn = ? AND attempt = ? AND topic = ?`).run(message.model, message.input, message.cacheRead, message.cacheWrite, message.output, message.reasoning, message.costUsd, message.turn, message.attempt, message.conversation);
        return;
      }
      case "providers": {
        brainProviders = message;
        publishBrainStatus();
        brainChanged();
        return;
      }
      case "hello": {
        if (link !== undefined) {
          link.ready = true;
          link.mailReview = message.mailReview === true;
        }
        const order = options.order?.();
        if (order !== undefined) {
          sendToBrain({ type: "order", order: [...order] });
        }
        const running = new Set(message.running.map((item) => `${item.conversation}\n${item.turn}`));
        let resumedModel: string | null = null;
        for (const turn of selectRunningTurns.all().map(toTurn)) {
          if (!running.has(`${turn.conversation}\n${turn.id}`)) {
            endTurn(turn.id, "interrupted", brainRestartedReason, { restarting: true });
          } else if (turn.model?.trim()) {
            resumedModel = turn.model;
          }
        }
        if (resumedModel !== null) rememberTurnModel(resumedModel);
        for (const item of message.running) {
          const turn = getTurn(item.turn);
          if (turn !== undefined && turn.state !== "running") {
            sendToBrain({ type: "interrupt", conversation: item.conversation });
          }
        }
        corrections.sync();
        for (const row of selectWaiting.all().map((value) => EntryRow.parse(value))) {
          deliver(row);
        }
        return;
      }
      case "turn.started": {
        const topic = rawGet(message.conversation);
        if (topic?.mergedInto !== undefined) {
          sendToBrain({ type: "interrupt", conversation: topic.id });
        }
        if (topic === undefined || topic.mergedInto !== undefined || getTurn(message.turn) !== undefined) {
          return;
        }
        const entries: string[] = [];
        connection.exec("BEGIN IMMEDIATE");
        try {
          insertTurn.run(message.turn, message.conversation, message.provider, message.model, clock.now());
          for (const input of message.inputs) {
            const entry = markTaken.get(message.turn, input, message.conversation);
            if (entry !== undefined) entries.push(z.string().parse(entry["id"]));
          }
          connection.exec("COMMIT");
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
        rememberTurnModel(message.model);
        for (const entry of entries) emitEntry(entry);
        emitTurn(message.turn);
        if (!isQuiet(message.turn)) updateConversation(message.conversation, { state: "working", provider: message.provider });
        return;
      }
      case "input.taken": {
        const turn = getTurn(message.turn);
        const wasQuiet = isQuiet(message.turn);
        const entry = turn?.state === "running" && turn.conversation === message.conversation
          ? markTaken.get(message.turn, message.input, message.conversation) : undefined;
        if (turn !== undefined && entry !== undefined) {
          if (message.memoryRevision !== undefined) {
            seeMemory.run(message.memoryRevision, message.conversation, turn.provider);
          }
          emitEntry(z.string().parse(entry["id"]));
          if (wasQuiet && !isQuiet(turn.id)) {
            emitTurn(turn.id);
            updateConversation(turn.conversation, { state: "working", provider: turn.provider });
          }
        }
        return;
      }
      case "input.withdrawing":
        corrections.withdrawing(message.conversation, message.turn, message.input);
        return;
      case "input.withdrawn":
        corrections.withdrawn(message.conversation, message.input);
        return;
      case "topic.paused":
        corrections.paused(message.merge, message.conversation);
        return;
      case "provider.changed": {
        if (!known(message.conversation, message.turn)) {
          return;
        }
        changeTurnProvider.run(message.to, message.model, message.turn);
        rememberTurnModel(message.model);
        if (isQuiet(message.turn)) return;
        emitTurn(message.turn);
        addEntry({
          conversation: message.conversation,
          kind: "notice",
          turn: message.turn,
          body: {
            text: text("notice.providerChanged", {
              from: providerNames[message.from],
              to: providerNames[message.to],
              reason: message.reason,
            }),
          },
        });
        updateConversation(message.conversation, { provider: message.to });
        return;
      }
      case "text": {
        if (!known(message.conversation, message.turn) || isQuiet(message.turn)) {
          return;
        }
        const id = `${message.turn}:${message.block}`;
        if (getEntry(id) === undefined) {
          addEntry({
            id,
            conversation: message.conversation,
            kind: "text",
            turn: message.turn,
            provider: providerOfTurn(message.turn),
            body: { text: message.delta },
          });
        } else {
          appendField(id, "text", message.delta);
        }
        return;
      }
      case "tool.started": {
        if (!known(message.conversation, message.turn) || isQuiet(message.turn) || isPrivateAppToolEvent(message.name)) {
          return;
        }
        const id = `${message.turn}:${message.call}`;
        if (getEntry(id) === undefined) {
          addEntry({
            id,
            conversation: message.conversation,
            kind: "tool",
            turn: message.turn,
            provider: providerOfTurn(message.turn),
            body: { name: message.name, input: message.input, output: "", state: "running" },
          });
        }
        return;
      }
      case "tool.output": {
        if (known(message.conversation, message.turn)) {
          appendField(`${message.turn}:${message.call}`, "output", message.delta);
        }
        return;
      }
      case "tool.finished": {
        const id = `${message.turn}:${message.call}`;
        const body = bodyOf(id);
        if (!known(message.conversation, message.turn) || body === undefined) {
          return;
        }
        body["state"] = message.ok ? "done" : "failed";
        if (message.output !== null) {
          body["output"] = message.output;
        }
        updateBody.run(JSON.stringify(body), id);
        emitEntry(id);
        return;
      }
      case "turn.finished": {
        if (known(message.conversation, message.turn)) {
          endTurn(message.turn, message.outcome, message.reason, { applied: message.applied ?? message.outcome === "completed" });
        }
        return;
      }
      case "session": {
        const topic = rawGet(message.conversation);
        if (topic !== undefined && topic.mergedInto === undefined) {
          upsertSession.run(message.conversation, message.provider, message.session, clock.now());
        }
        return;
      }
      case "prepare": {
        const running = runningTurnOf(message.conversation);
        if (running !== undefined && mailReviewOf(message.conversation, running.id) !== undefined) {
          sendToBrain({ type: "prepared", request: message.request, session: null, history: [],
            memory: message.provider === "deepseek" ? null : options.memory?.brief(message.conversation, null) ?? null });
          return;
        }
        const topic = selectConversation.get(message.conversation);
        if (topic?.["merged_into"] != null) {
          sendToBrain({ type: "prepared", request: message.request, session: null, history: [], memory: null });
          return;
        }
        if (message.fresh) {
          discardSession.run(message.conversation, message.provider);
        }
        const found = selectSession.get(message.conversation, message.provider);
        const session = found === undefined ? undefined : SessionRow.parse(found);
        const given = session?.session ?? null;
        const memory = options.memory;
        const structured = message.seed !== undefined;
        const snapshot = structured && !message.steer && (message.seed || given === null);
        const memoryRevision = memory?.revision() ?? 0;
        const memorySeen = session === undefined || (given === null && !message.steer) ? null
          : Math.max(session.memory_seen, message.steer ? session.memory_offered : 0);
        const changedMemory = memory?.brief(message.conversation, memorySeen) ?? null;
        const brief = changedMemory ?? (snapshot ? memory?.brief(message.conversation, null) ?? null : null);
        const board = structured && !message.steer ? topics.board(snapshot ? 0 : (session?.board_seen ?? 0)) : [];
        if (!message.steer && get(message.conversation) !== undefined) {
          offerContext.run(message.conversation, message.provider, memoryRevision, board.at(-1)?.revision ?? session?.board_seen ?? 0, clock.now());
        }
        const exclude = new Set(message.exclude);
        sendToBrain({
          type: "prepared",
          request: message.request,
          session: given,
          history: snapshot || message.steer ? [] : history(message.conversation, session?.through ?? 0, exclude, !structured),
          memory: brief,
          ...(snapshot ? { seed: topics.seed(message.conversation, exclude, message.continuing === true) } : {}),
          ...(structured && !message.steer ? { board: board.map(({ revision: _, ...entry }) => entry) } : {}),
          ...(!message.steer && topic?.["title_origin"] === "automatic" ? { automaticTitle: true as const } : {}),
          ...(message.steer ? { memoryRevision } : {}),
        });
        return;
      }
    }
  };

  const reportHeld = (command: CommandRecord) => {
    const row = selectBrainCommand.get(command.id);
    if (row === undefined) {
      return;
    }
    const value = BrainCommandRow.parse(row);
    if (command.state === "held") {
      markHeld.run(command.id);
      return;
    }
    if (value.held === 0 || value.reported === 1 || !finishedStates.includes(command.state)) {
      return;
    }
    markReported.run(command.id);
    const output = commands
      .output(command.id)
      .map((chunk) => chunk.data)
      .join("");
    tell(null, text("notice.heldOutcome", { state: text(`command.state.${command.state}`), command: command.command }), heldPrompt(command, output, value.conversation_id));
  };

  const unsubscribeCommands = commands.subscribe((event) => {
    if (event.type === "command") {
      reportHeld(event.command);
    }
  });

  const create = (title = "", system = false): Conversation => {
    const id = storeTopic(options.database, clock.now(), title, { system, titleOrigin: title === "" && !system ? "automatic" : "owner" });
    const conversation = get(id);
    if (conversation === undefined) {
      throw new Error(`Conversation ${id} was not stored`);
    }
    emit({ type: "conversation", conversation });
    return conversation;
  };

  const noticeTarget = (ticket: number | null): string => {
    if (ticket === null) {
      const system = selectSystem.get();
      return system === undefined ? create("System", true).id : toConversation(system).id;
    }
    return tickets.topic(ticket);
  };

  const postHubEntry = (entry: NewEntry): string => {
    const id = addEntry(entry);
    const stored = selectEntry.get(id);
    updateConversation(entry.conversation, { topic_state: "active" });
    if (stored !== undefined) {
      deliver(EntryRow.parse(stored));
    }
    return entry.conversation;
  };

  function tell(ticket: number | null, notice: string, prompt: string, hidden = false, screenshots?: readonly ScreenshotReport[]): string {
    const light = ticket !== null && tickets.get(ticket)?.light !== undefined;
    const privateNotice = hidden || light;
    return postHubEntry({
      conversation: noticeTarget(ticket), kind: "notice", turn: null, body: { text: privateNotice ? "" : notice, ...(screenshots === undefined ? {} : { screenshots }) },
      prompt: light ? `${prompt}\nHandle this light task internally. The conversation shows the final result or failure automatically. Do not send a progress reply, expose a ticket code or ask the owner to use a ticket card.` : prompt,
      ...(privateNotice ? { hidden: true as const } : {}),
    });
  }

  const deliveryEntry = (conversation: string, delivery: Delivery): NewEntry => ({
    conversation, kind: "delivery", turn: null,
    body: { ticket: delivery.ticket, title: delivery.title, text: delivery.text, report: delivery.report ?? null, files: delivery.files, light: delivery.light },
    ...(delivery.light === true ? {} : { prompt: delivery.prompt }),
  });

  const taskProgress = (work: StoredWorkEvent) => {
    const ticket = tickets.get(work.ticket);
    if (ticket?.form !== "task" || ticket.light !== undefined || ticketProject(ticket) !== null || ticket.conversation === null) return;
    const event = work.event;
    if (event.kind !== "text" && !(event.kind === "phase" && (event.phase === "started" || event.phase === "resumed"))) return;
    const key = event.kind === "text" ? `text-${event.block}` : `phase-${work.seq}`;
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const id = `task-work-${work.ticket}-${work.attempt}-${hash}`;
    const previous = selectEntry.get(id);
    const old = previous === undefined ? undefined : JSON.parse(EntryRow.parse(previous).body) as { text: string; seq: number };
    if (old !== undefined && old.seq >= work.seq) return;
    const value = event.kind === "text" ? (old?.text ?? text("notice.taskProgress", { ticket: ticket.code })) + event.delta : text("notice.taskStarted", { ticket: ticket.code });
    const body = { text: value, ticket: work.ticket, seq: work.seq };
    if (previous === undefined) addEntry({ id, conversation: ticket.conversation, kind: "notice", turn: null, body, at: work.at });
    else { updateBody.run(JSON.stringify(body), id); emitEntry(id); }
  };

  const publishOwner = (id: string): StreamEntry => {
    const row = selectStreamEntry.get(id);
    const item = toStreamEntry(row);
    announce(item.topic.id);
    emit({ type: "entry", ...item });
    deliver(EntryRow.parse(row));
    return item;
  };

  const pendingQuestions = connection.prepare("SELECT * FROM conversation_entries WHERE conversation_id = ? AND kind = 'question' AND json_extract(body, '$.answer') IS NULL ORDER BY seq DESC LIMIT 1");
  const answerByMessage = (conversation: string, message: string) => {
    for (const raw of pendingQuestions.all(conversation)) {
      const row = EntryRow.parse(raw);
      const body = JSON.parse(row.body) as Record<string, unknown>;
      updateBody.run(JSON.stringify({ ...body, answer: { kind: "message", text: message } }), row.id);
      emitEntry(row.id);
    }
  };

  const writeOwner = (
    conversation: Conversation, message: string, attachments: readonly Attachment[],
    { quotedMessage, possibleMatch, voiceTranscript, id, at, markQuestions = true }: { voiceTranscript?: string | undefined; quotedMessage?: string | undefined; possibleMatch?: string | undefined; id?: string; at?: number; markQuestions?: boolean } = {},
  ): string => {
    activateOwnerTopic.run(clock.now(), titleOf(message, attachments), conversation.id);
    if (markQuestions) answerByMessage(conversation.id, message);
    return writeEntry({
      ...(id === undefined ? {} : { id }), ...(at === undefined ? {} : { at }),
      ...(quotedMessage === undefined ? {} : { quote: quotedMessage }),
      conversation: conversation.id, kind: "owner", turn: null,
      body: { text: message, attachments, possibleMatch, voiceTranscript }, prompt: ownerPrompt(message, voiceTranscript),
    });
  };

  const sendDirect = (topic: string | undefined, message: string, attachments: readonly Attachment[], quotedMessage?: string, id?: string, voiceTranscript?: string): StreamEntry | undefined => {
    const explicit = topic === undefined ? undefined : get(topic);
    if (topic !== undefined && explicit === undefined) {
      return undefined;
    }
    const quote = quotedMessage === undefined ? undefined : quoteOf(quotedMessage);
    if (quotedMessage !== undefined && (quote === undefined || (explicit !== undefined && explicit.id !== quote.conversation))) {
      return undefined;
    }
    const conversation = explicit ?? (quote === undefined ? undefined : get(quote.conversation));
    return conversation === undefined ? undefined : publishOwner(writeOwner(conversation, message, attachments, { quotedMessage, voiceTranscript, ...(id === undefined ? {} : { id }) }));
  };

  const routingCandidate = (topic: string | undefined, scope: TopicScope, allowArchived = false): Conversation | undefined => {
    const found = topic === undefined ? undefined : rawGet(topic);
    return found !== undefined && !found.system && !found.mergePending && found.mergedInto === undefined && topicInScope(found, scope)
      && (found.topicState === "active" || (allowArchived && router.recentlyArchived(found.id))) ? found : undefined;
  };

  const automaticDestination = (scope: TopicScope, routing: Routing) => {
    const proposed = routingCandidate(routing.topic ?? undefined, scope, true);
    const capped = router.cappedTopic(proposed?.repository ?? routing.repository, proposed?.id, routing.scores);
    const destination = capped === undefined ? proposed : rawGet(capped);
    const proposal: RoutingProposal = {
      ...routing,
      decided: { ...routing.decided, topic: destination?.id ?? null },
      ...(destination?.topicState === "archived" ? { reopen: true } : {}),
      ...(capped === undefined ? {} : { repositoryCap: true, possibleMatch: undefined }),
    };
    return { destination, proposal };
  };

  const placeOwner = (
    id: string, at: number, { message, attachments, scope, voiceTranscript }: z.infer<typeof PendingBody>, conversation: Conversation | undefined,
    { repository, proposal, ownerChanged = false, pending }: {
      repository: string | null; proposal?: RoutingProposal | undefined; ownerChanged?: boolean; pending?: Routing;
    },
  ): StreamEntry => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      if (pending !== undefined) {
        ({ destination: conversation, proposal } = automaticDestination(scope, pending));
      }
      const match = conversation === undefined && !ownerChanged ? routingCandidate(proposal?.possibleMatch, scope, true) : undefined;
      if (conversation === undefined) {
        const topic = openTopic(at, titleOf(message, attachments), scope, repository);
        conversation = toConversation(selectConversation.get(topic));
      }
      writeOwner(conversation, message, attachments, { id, at, voiceTranscript, possibleMatch: match?.id });
      if (proposal !== undefined) router.record(id, conversation.id, scope.kind, proposal, at, { ownerChanged, ownerPlaced: pending === undefined });
      if (pending !== undefined) deletePending.run(id);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
    if (proposal !== undefined) router.log(id, conversation.id, scope.kind, proposal, ownerChanged);
    return publishOwner(id);
  };

  const finishRouting = (id: string, at: number, body: z.infer<typeof PendingBody>, routing: Routing): StreamEntry =>
    placeOwner(id, at, body, undefined, {
      repository: routing.repository, pending: routing,
    });

  corrections.finishOfflineMerges();
  for (const row of listPending.all().map((row) => PendingInput.parse(row))) {
    const body = PendingBody.parse(JSON.parse(row.body));
    finishRouting(row.id, row.created_at, body, router.routeNow({ text: body.message, attachments: body.attachments, scope: body.scope, at: row.created_at }, recoveredReason));
  }

  const routingSends = new Map<string, { readonly body: z.infer<typeof PendingBody>; readonly result: Promise<StreamEntry | undefined> }>();

  const streamSend = async (
    id: string, topic: string | undefined, message: string, attachments: readonly Attachment[],
    { quotedMessage, scope = { kind: "daily" } as const, newTopic, proposal, voiceTranscript }: StreamSendOptions = {},
  ): Promise<StreamEntry | undefined> => {
    if (!newTopic && proposal === undefined && (topic !== undefined || quotedMessage !== undefined)) {
      return sendDirect(topic, message, attachments, quotedMessage, id, voiceTranscript);
    }
    const at = clock.now();
    const body = { message, attachments: [...attachments], scope, voiceTranscript };
    if (newTopic || proposal !== undefined) {
      const destination = newTopic ? undefined : routingCandidate(topic, scope, proposal?.reopen === true && topic === proposal.decided.topic);
      if (!newTopic && destination === undefined) return undefined;
      return placeOwner(id, at, body, destination, {
        repository: newTopic ? router.repositoryFor(message, scope) : null,
        proposal, ownerChanged: proposal !== undefined && proposal.decided.topic !== (destination?.id ?? null),
      });
    }
    savePending.run(id, JSON.stringify(body), at);
    const result = router.route({ text: message, attachments, scope, at }, { purpose: "send" })
      .then((routing) => closing ? undefined : finishRouting(id, at, body, routing));
    routingSends.set(id, { body, result });
    try {
      return await result;
    } finally {
      routingSends.delete(id);
    }
  };

  const repeatOf = (id: string, request: OwnerSend): SendOutcome | Promise<SendOutcome> | undefined => {
    const named = request.conversation ?? (request.proposal === undefined && request.newTopic !== true ? request.topic : undefined);
    const row = selectStreamEntry.get(id);
    if (row !== undefined) {
      const item = toStreamEntry(row);
      const { entry } = item;
      const same = entry.kind === "owner"
        && sameMessage({ text: entry.text, attachments: entry.attachments, quote: entry.quotedMessage ?? null, voiceTranscript: entry.voiceTranscript }, request)
        && (named === undefined || corrections.resolve(named) === corrections.resolve(entry.conversation));
      return same ? { ok: true, item } : conflict;
    }
    const routing = routingSends.get(id);
    if (routing !== undefined) {
      const same = named === undefined && sameMessage({ text: routing.body.message, attachments: routing.body.attachments, quote: null, voiceTranscript: routing.body.voiceTranscript }, request);
      return same ? routing.result.then((item): SendOutcome => (item === undefined ? notFound : { ok: true, item })) : conflict;
    }
    return undefined;
  };

  const sendOwner = async (request: OwnerSend): Promise<SendOutcome> => {
    const repeat = request.id === undefined ? undefined : repeatOf(request.id, request);
    if (repeat !== undefined) {
      return repeat;
    }
    const id = request.id ?? randomUUID();
    const item = request.conversation === undefined
      ? await streamSend(id, request.topic, request.text, request.attachments, request)
      : sendDirect(request.conversation, request.text, request.attachments, request.quotedMessage, id, request.voiceTranscript);
    return item === undefined ? notFound : { ok: true, item };
  };

  return {
    create,
    rearrange: (repository) => {
      if (activeRearrange.get(rearrangePrefix.length, rearrangePrefix) !== undefined) return undefined;
      const title = repository == null ? "重新编排" : `重新编排 · ${repository}`;
      const id = storeTopic(options.database, clock.now(), title, { repository: repository ?? null, titleOrigin: "owner" });
      const conversation = get(id);
      if (conversation === undefined) throw new Error(`Conversation ${id} was not stored`);
      emit({ type: "conversation", conversation });
      postHubEntry({ conversation: id, kind: "notice", turn: null, body: { text: title }, prompt: rearrangePrompt(repository, tickets.list({ open: true, limit: Number.MAX_SAFE_INTEGER })) });
      return conversation;
    },
    topics,
    tell,
    writeHealthNotice: (notice) => {
      const topics = [0, 1].map((code) => {
        const row = code === 0 ? selectSystem.get() : selectCodeSystem.get();
        return row === undefined ? storeTopic(options.database, clock.now(), "System", { system: code === 0, codeSystem: code === 1, needsRepository: code === 1 }) : toConversation(row).id;
      });
      const entries = topics.map((conversation) => {
        writeConversation(conversation, { topic_state: "active" });
        return writeEntry({ conversation, kind: "notice", turn: null, body: { text: notice } });
      });
      return { topics, entries };
    },
    publishHealthNotice: ({ topics, entries }) => {
      for (const topic of topics) announce(topic);
      for (const entry of entries) emitEntry(entry);
    },
    inbox: (topic, source, message) => {
      const id = topic ?? create(source).id;
      updateConversation(id, { topic_state: "active" });
      const entry = addEntry({ conversation: id, kind: "notice", turn: null, body: { source, text: message } });
      return { topic: id, entry };
    },
    deliver: (delivery) => postHubEntry(deliveryEntry(noticeTarget(delivery.ticket), delivery)),
    writeDelivery: (conversation, delivery) => writeEntry(deliveryEntry(conversation, delivery)),
    writeConfirmation: (conversation, turn, message) => writeEntry({
      conversation, turn, kind: "text", provider: providerOfTurn(turn), body: { text: message },
    }),
    tidyTopics: (prompt) => {
      postHubEntry({ conversation: noticeTarget(null), kind: "notice", turn: null, body: { text: "", topicTidy: true }, prompt, hidden: true });
    },
    tidyNotice: (notice) => {
      addEntry({ conversation: noticeTarget(null), kind: "notice", turn: null, body: { text: notice } });
    },
    writePromptNotice: (id, conversation, notice, prompt, source) => {
      writeEntry({ id, conversation, kind: "notice", turn: null, body: { text: notice, source }, ...(prompt === undefined ? {} : { prompt }) });
    },
    writeMailReview: (id, conversation, prompt) => {
      writeEntry({ id, conversation, kind: "notice", turn: null, body: { text: "", mailReview: true }, prompt, hidden: true });
    },
    deliverMailReview: (id) => {
      const row = EntryRow.optional().parse(selectEntry.get(id));
      if (row !== undefined) deliver(row);
    },
    mailReviewOf,
    mailReviewReady: () => link?.ready === true && link.mailReview && (brainProviders?.providers.some(({ provider, available, until }) =>
      provider !== "deepseek" && (available || (until !== null && until <= clock.now()))) ?? false),
    publishPromptNotice: (id) => {
      const row = EntryRow.optional().parse(selectEntry.get(id));
      if (row === undefined) return;
      updateConversation(row.conversation_id, { topic_state: "active" });
      emitEntry(id);
      deliver(row);
    },
    writeLightQuestion: (conversation, id, message) => {
      writeEntry({ id, conversation, kind: "notice", turn: null, body: { text: message, worker: true } });
    },
    get,
    announce,
    announceEntry: emitEntry,
    taskProgress,
    list: (limit = 50) => selectConversations.all(limit).map(withMerge),
    move: corrections.move,
    handover: corrections.handover,
    rename: corrections.rename,
    proposeTitle: (conversation, turn, title) => link?.ready === true && proposeTitle.run(title, turn, conversation).changes > 0,
    merge: corrections.merge,
    undoMerge: corrections.undoMerge,
    mergeForBrain: (current, turn, destination, sources) => link?.ready === true && assignmentTurn.get(turn, current) !== undefined
      ? (() => {
          const result = corrections.mergeForBrain(current, destination, sources);
          const tidy = connection.prepare("SELECT 1 FROM conversation_entries WHERE turn_id = ? AND hidden = 1 AND json_extract(body, '$.topicTidy') = 1").get(turn);
          if (tidy !== undefined) {
            const record = connection.prepare("INSERT OR REPLACE INTO topic_tidy_merges (source, destination) VALUES (?, ?)");
            result.filter(({ result: value }) => value === "merge queued").forEach(({ topic }) => record.run(topic, destination));
          }
          return result;
        })() : undefined,
    archive: corrections.archive,
    archiveForBrain: corrections.archiveForBrain,
    archiveIdle: corrections.archiveIdle,
    historyRevision: corrections.revision,
    detail: (id) => {
      const conversation = get(id);
      if (conversation === undefined) {
        return undefined;
      }
      return {
        conversation,
        turns: selectTurns.all(conversation.id).map(toTurn).filter((turn) => !isQuiet(turn.id)),
        entries: selectEntries.all(conversation.id, 0, conversation.id).map((row) => toEntry(EntryRow.parse(row))),
      };
    },
    entries: (id, after = 0) => {
      const topic = corrections.resolve(id);
      return topic === undefined ? [] : selectEntries.all(topic, after, topic).map((row) => toEntry(EntryRow.parse(row)));
    },
    stream: (before = Number.MAX_SAFE_INTEGER, limit = streamPageSize, repository) => {
      const scope: TopicScope | undefined = repository === null ? { kind: "daily" }
        : typeof repository === "string" ? { kind: "repository", repository } : repository;
      const rows = scope === undefined ? selectStreamPage.all(before, limit + 1)
        : selectStreamScoped.all(before, scope.kind, scope.kind === "repository" ? scope.repository : null, limit + 1);
      const entries = rows.slice(0, limit).reverse().map(toStreamEntry);
      const next = rows.length > limit ? (entries[0]?.position ?? null) : null;
      return { entries, turns: streamTurns(entries, scope), before: next };
    },
    streamAfter: (after, scope) => {
      const rows = scope === undefined ? selectStreamAfter.all(after)
        : selectScopedAfter.all(after, scope.kind, scope.kind === "repository" ? scope.repository : null);
      const entries = rows.map(toStreamEntry);
      return { entries, turns: streamTurns(entries, scope), before: null };
    },
    askOwner: (conversation, turn, questions) => {
      if (!known(conversation, turn)) return undefined;
      return addEntry({ conversation, turn, kind: "question", body: { questions, answer: null } });
    },
    answerQuestions: (conversation, id, answers) => {
      const row = selectEntry.get(id);
      const topic = get(conversation);
      if (row === undefined || topic === undefined) return undefined;
      const parsed = toEntry(EntryRow.parse(row));
      if (parsed.kind !== "question" || parsed.conversation !== topic.id || parsed.answer !== null) return undefined;
      const byId = new Map(answers.map((answer) => [answer.question, answer]));
      if (byId.size !== answers.length || answers.some((answer) => !parsed.questions.some((question) => question.id === answer.question))) return undefined;
      const normalized: QuestionAnswer[] = [];
      const lines: string[] = [];
      for (const question of parsed.questions) {
        const answer = byId.get(question.id) ?? { question: question.id, options: [], text: "" };
        const typed = answer.text.trim();
        const selected = typed ? [] : answer.options;
        if (new Set(selected).size !== selected.length || (!question.multiple && selected.length > 1) || selected.some((id) => !question.options.some((option) => option.id === id)) || (question.required && !typed && selected.length === 0)) return undefined;
        normalized.push({ question: question.id, options: selected, text: typed });
        const labels = selected.map((id) => question.options.find((option) => option.id === id)!.label);
        lines.push(`${question.prompt}：${typed || labels.join("、") || text("question.skipped")}`);
      }
      const message = lines.join("\n");
      let owner: string;
      connection.exec("BEGIN IMMEDIATE");
      try {
        updateBody.run(JSON.stringify({ questions: parsed.questions, answer: { kind: "card", answers: normalized } }), id);
        owner = writeOwner(topic, message, [], { markQuestions: false });
        connection.prepare("UPDATE conversation_entries SET prompt = ?, body = json_set(body, '$.questionResponse', json(?)) WHERE id = ?").run(`${message}\n[hub] Structured question answers: ${JSON.stringify({ card: id, answers: normalized })}`, JSON.stringify({ card: id, answers: normalized }), owner);
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
      emitEntry(id);
      const item = publishOwner(owner);
      return item.entry.kind === "owner" ? item.entry : undefined;
    },
    send: (topic, message, attachments = [], quotedMessage) => {
      const item = sendDirect(topic, message, attachments, quotedMessage);
      return item?.entry.kind === "owner" ? item.entry : undefined;
    },
    previewStream: async ({ text, attachmentNames, scope }, signal) => {
      const routing = await router.route({ text, attachments: attachmentNames.map((name) => ({ name })), scope, at: clock.now() }, { purpose: "preview", signal });
      if (closing) return { proposal: RoutingProposal.parse(routing), title: null };
      const { destination, proposal } = automaticDestination(scope, routing);
      return { proposal: RoutingProposal.parse(proposal), title: destination?.title ?? null };
    },
    sendToStream: (topic, message, attachments, options) => streamSend(randomUUID(), topic, message, attachments, options),
    sendOwner,
    readQuote: (conversation, id, offset) => {
      const quote = hasQuote.get(conversation, id) === undefined ? undefined : quoteOf(id);
      if (quote === undefined || offset > quote.item.text.length) {
        return undefined;
      }
      const { text } = quote.item;
      let end = Math.min(offset + quoteChunkLimit, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
        end += 1;
      }
      return { text: text.slice(offset, end), next: end < text.length ? end : null };
    },
    assignRepository: (conversation, turn, repository, target = conversation) => {
      if (link?.ready !== true || assignmentTurn.get(turn, conversation) === undefined) return "An active topic turn is required.";
      const topic = rawGet(target);
      if (topic === undefined) return "Topic not found.";
      if (topic.system === true) return "System topics cannot be moved.";
      if (topic.mergedInto !== undefined) return "Merged topics cannot be moved.";
      if (corrections.pending(target)) return "Topics with a pending merge cannot be moved.";
      if (topic.repository !== null && repository !== null && topic.repository.toLowerCase() !== repository.toLowerCase()) {
        return "A repository topic cannot be moved directly to another repository.";
      }
      if (assignTopicRepository.run(repository, clock.now(), target, repository, repository, repository).changes === 0) {
        return "Topic has tickets belonging to a different repository or no repository.";
      }
      changeTopicHistory.run();
      announce(target);
      return undefined;
    },
    interrupt: (id) => {
      const conversation = get(id);
      if (conversation === undefined) {
        return undefined;
      }
      const running = runningTurnOf(conversation.id);
      if (running !== undefined) {
        revokeTicketWrites.run(running.id);
        if (!sendToBrain({ type: "interrupt", conversation: conversation.id })) {
          endTurn(running.id, "interrupted", brainAbsentReason);
        }
      }
      return get(id);
    },
    recordCommand: (command, conversation) => {
      const topic = corrections.resolve(conversation);
      if (topic === undefined) {
        return;
      }
      insertBrainCommand.run(command, topic);
      const record = commands.get(command);
      if (record?.state === "held") {
        markHeld.run(command);
      }
    },
    linked: () => link !== undefined,
    brainStatus: () => brainStatus,
    brainReady: () => link?.ready === true,
    activeTurnProvider: (conversation, turn) => {
      const current = getTurn(turn);
      return link?.ready === true && current?.state === "running" && current.conversation === conversation ? current.provider ?? undefined : undefined;
    },
    ownerAppTurn: (conversation, turn) => ownerAppInput.get(conversation, turn) !== undefined
      && schedules.forTurn({ conversation, id: turn }) === undefined,
    providers: () => (link === undefined ? undefined : brainProviders),
    sendOrder: (order) => {
      sendToBrain({ type: "order", order: [...order] });
    },
    routingSettled: () => router.settled(),
    watchBrain: (listener) => {
      brainListeners.add(listener);
      return () => {
        brainListeners.delete(listener);
      };
    },
    attach: (connection) => {
      const previous = link;
      const current = { connection, ready: false, mailReview: false };
      link = current;
      brainProviders = undefined;
      lastTurnModel = null;
      previous?.connection.close();
      publishBrainStatus();
      brainChanged();
      connection.send({ type: "hello", protocol: protocolVersion, ...(options.extraMcp?.length ? { extraMcp: [...options.extraMcp] } : {}) });
      return {
        receive: (message) => {
          if (link === current) {
            receive(message);
          }
        },
        detach: () => {
          if (link === current) {
            link = undefined;
            corrections.finishOfflineMerges();
            brainProviders = undefined;
            lastTurnModel = null;
            publishBrainStatus();
            brainChanged();
          }
        },
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closing = true;
      corrections.close();
      router.close();
      unsubscribeCommands();
      link?.connection.close();
      link = undefined;
      brainStatus = { linked: false, model: null };
      listeners.clear();
      brainListeners.clear();
    },
  };
}
