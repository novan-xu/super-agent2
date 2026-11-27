import {
  AttachmentUpload,
  attachmentsPath,
  type ChainStartItem,
  type ChoiceChange,
  CommandResponse,
  ConversationDetail,
  ConversationList,
  ConversationResponse,
  type DecisionReview,
  EntryResponse,
  MachineList,
  type MachineLoadSettings,
  MemoryList,
  type MemoryScope,
  PushKey,
  type PushSubscriptionRequest,
  PushState,
  Refusal,
  type ReviewedStreamDestination,
  type StuckAnswerRequest,
  StreamEntry,
  streamPath,
  StreamPreview,
  streamPreviewPath,
  type StreamPreviewRequest,
  type TopicMove,
  type TopicScope,
  type QuestionAnswer,
  TicketDetail,
  TicketHistory,
  TicketList,
  TicketResponse,
  WorkerMessageResponse,
  type VoiceConfirmation,
  VoiceEnd,
  type VoiceOffer,
  VoiceSession,
  VoiceStatus,
  type VoiceToolCall,
  VoiceToolResult,
  voicePath,
  WorkEventList,
  type EngineTable,
  EngineTableBody,
  type GitHubAccount,
  MachineAdded,
  MachineRevoked,
  type MachineSystem,
  type Provider,
  SettingsSnapshot,
  ScheduleHistory,
  ScheduleList,
  type ScheduleAction,
  type ScheduleFields,
  StorageSettings,
} from "@super-agent2/protocol";
import { z } from "zod";
import { appPath } from "../parts/app-path.js";

export type Failure = Refusal["error"] | "network" | "timeout";

export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure; readonly reason?: string };

export interface SendAttempt {
  readonly id?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown, method: "POST" | "PUT" | "DELETE" = "POST", signal?: AbortSignal): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(
      appPath(path),
      body === undefined
        ? { headers: { accept: "application/json" }, cache: "no-store" }
        : { method, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) },
    );
  } catch {
    return { ok: false, error: "network" };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { ok: false, error: "network" };
  }
  if (!response.ok) {
    const refusal = Refusal.safeParse(value);
    if (!refusal.success) {
      return { ok: false, error: "network" };
    }
    return refusal.data.reason === undefined ? { ok: false, error: refusal.data.error } : { ok: false, error: refusal.data.error, reason: refusal.data.reason };
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "network" };
}

const commandPath = (id: string) => `/api/commands/${encodeURIComponent(id)}`;

const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;

export interface HistoryRequest {
  readonly query: string;
  readonly before: string | null;
}

export function historyPath(page: HistoryRequest): string {
  const parameters = new URLSearchParams({ scope: "ended" });
  if (page.query !== "") {
    parameters.set("q", page.query);
  }
  if (page.before !== null) {
    parameters.set("before", page.before);
  }
  return `/api/tickets?${parameters.toString()}`;
}

export const voiceApi = {
  status: () => call(voicePath, VoiceStatus),
  open: (offer: VoiceOffer, signal: AbortSignal) => call(`${voicePath}/session`, VoiceSession, offer, "POST", signal),
  tool: (id: string, tool: VoiceToolCall, signal: AbortSignal) => call(`${voicePath}/${id}/tool`, VoiceToolResult, tool, "POST", signal),
  confirm: (id: string, confirmation: VoiceConfirmation) => call(`${voicePath}/${id}/confirm`, StreamEntry, confirmation, "POST", AbortSignal.timeout(30_000)),
  end: (id: string) => call(`${voicePath}/${id}/end`, VoiceEnd, {}, "POST", AbortSignal.timeout(5_000)),
};

export const hubApi = {
  rearrange: (repository: string | null | undefined) => call("/api/workbench/rearrange", ConversationResponse, { repository }),
  conversations: () => call("/api/conversations?all=1", ConversationList),
  detail: (id: string) => call(conversationPath(id), ConversationDetail),
  send: (conversation: string, text: string, attachments: readonly string[] = [], quotedMessage?: string, { id, signal }: SendAttempt = {}) =>
    call(`${conversationPath(conversation)}/messages`, EntryResponse, { id, text, attachments, quotedMessage }, "POST", signal),
  answerQuestions: (conversation: string, id: string, answers: readonly QuestionAnswer[]) => call(`${conversationPath(conversation)}/questions`, EntryResponse, { id, answers }),
  previewStream: (request: StreamPreviewRequest, signal?: AbortSignal) => call(streamPreviewPath, StreamPreview, request, "POST", signal),
  sendToStream: (text: string, attachments: readonly string[], quotedMessage?: string, scope?: TopicScope, destination?: ReviewedStreamDestination, { id, signal }: SendAttempt = {}) =>
    call(streamPath, StreamEntry, { id, text, attachments, quotedMessage, scope, ...destination }, "POST", signal),
  renameTopic: (source: string, title: string) => call(`${conversationPath(source)}/rename`, ConversationResponse, { title }),
  archiveTopic: (source: string) => call(`${conversationPath(source)}/archive`, ConversationResponse, {}),
  mergeTopic: (source: string, destination: string) => call(`${conversationPath(source)}/merge`, ConversationResponse, { destination }),
  undoTopicMerge: (source: string, destination: string) => call(`${conversationPath(source)}/undo-merge`, ConversationResponse, { destination }),
  moveMessage: (source: string, message: string, destination: TopicMove["destination"]) => call(`${conversationPath(source)}/move`, ConversationResponse, { message, destination }),
  interrupt: (id: string) => call(`${conversationPath(id)}/interrupt`, ConversationResponse, {}),
  release: (id: string, fingerprint: string) => call(`${commandPath(id)}/release`, CommandResponse, { fingerprint }),
  refuse: (id: string, fingerprint: string) => call(`${commandPath(id)}/refuse`, CommandResponse, { fingerprint }),
  tickets: (scope: "open" | "all" = "open") => call(`/api/tickets?scope=${scope}`, TicketList),
  history: (page: HistoryRequest) => call(historyPath(page), TicketHistory),
  ticket: (id: number) => call(`/api/tickets/${id}`, TicketDetail),
  work: (id: number, after: number) => call(`/api/tickets/${id}/work?after=${after}`, WorkEventList),
  messageWorker: (id: number, text: string, attachments: readonly string[] = []) => call(`/api/tickets/${id}/messages`, WorkerMessageResponse, { text, attachments }),
  createAttachment: (name: string, size: number, mediaType: string) => call(attachmentsPath, AttachmentUpload, { name, size, mediaType }),
  uploadState: (id: string) => call(`${attachmentResource(id)}/upload`, AttachmentUpload),
  uploadPart: (id: string, offset: number, part: Blob) => uploadPart(id, offset, part),
  stopTicket: (id: number) => call(`/api/tickets/${id}/stop`, TicketResponse, {}),
  answerStuck: (id: number, request: StuckAnswerRequest) => call(`/api/tickets/${id}/answer`, TicketResponse, request),
  reviewDecision: (id: number, decision: number, review: DecisionReview) => call(`/api/tickets/${id}/decisions/${decision}`, TicketResponse, review),
  machines: () => call("/api/machines", MachineList),
  startChains: (chains: readonly ChainStartItem[]) => call("/api/chains/start", TicketList, { chains }),
  chooseChain: (ticket: number, change: ChoiceChange) => call("/api/chains/choice", TicketList, { ticket, ...change }),
  reassign: (ticket: number, change: ChoiceChange) => call(`/api/tickets/${ticket}/reassign`, TicketList, change),
  addMemory: (text: string, scope?: MemoryScope) => call("/api/memories", MemoryList, { text, scope }),
  editMemory: (id: number, text: string, scope?: MemoryScope) => call(`/api/memories/${id}`, MemoryList, { text, scope }, "PUT"),
  deleteMemory: (id: number) => call(`/api/memories/${id}`, MemoryList, {}, "DELETE"),
  decideSuggestion: (id: number, decision: "confirm" | "decline", scope?: MemoryScope) => call(`/api/memories/suggestions/${id}/${decision}`, MemoryList, { scope }),
  refreshAllowance: () => call("/api/allowance", z.object({ requested: z.number() }), {}),
  settings: () => call("/api/settings", SettingsSnapshot),
  addMachine: (name: string, system: MachineSystem) => call("/api/machines", MachineAdded, { name, system }),
  revokeMachine: (name: string) => call(`/api/machines/${encodeURIComponent(name)}/revoke`, MachineRevoked, {}),
  setMachineStorage: (name: string, storage: StorageSettings) => call(`/api/machines/${encodeURIComponent(name)}/storage`, StorageSettings, storage, "PUT"),
  setMachineLoad: (limits: MachineLoadSettings) => call("/api/settings/machine-load", SettingsSnapshot, limits, "PUT"),
  setOrder: (role: "brain" | "worker", order: readonly Provider[]) => call(role === "brain" ? "/api/brain/order" : "/api/workers/order", SettingsSnapshot, { order }, "PUT"),
  setAccount: (repository: string, account: GitHubAccount) => call("/api/repositories/account", SettingsSnapshot, { repository, account }, "PUT"),
  setRepositoryOrder: (repositories: readonly string[]) => call("/api/repositories/order", SettingsSnapshot, { repositories }),
  setPinned: (repository: string, pinned: boolean) => call("/api/repositories/pin", SettingsSnapshot, { repository, pinned }),
  setAlias: (repository: string, alias: string | null) => call("/api/repositories/alias", SettingsSnapshot, { repository, alias }),
  refreshRepositories: () => call("/api/repositories/refresh", z.object({}), {}),
  setTable: (table: EngineTable) => call("/api/engine-table", EngineTableBody, { table }, "PUT"),
  pushKey: () => call("/api/push", PushKey),
  subscribePush: (subscription: PushSubscriptionRequest) => call("/api/push/subscription", PushState, subscription),
  unsubscribePush: (endpoint: string) => call("/api/push/subscription", PushState, { endpoint }, "DELETE"),
};

export type HubApi = typeof hubApi;

export const scheduleApi = {
  schedules: () => call("/api/schedules", ScheduleList),
  scheduleHistory: (id: string) => call(`/api/schedules/${encodeURIComponent(id)}`, ScheduleHistory),
  saveSchedule: (fields: ScheduleFields, id?: string, revision?: number) => id === undefined
    ? call("/api/schedules", ScheduleList, { fields })
    : call(`/api/schedules/${encodeURIComponent(id)}`, ScheduleList, { fields, revision }, "PUT"),
  changeSchedule: (id: string, action: ScheduleAction) => call(`/api/schedules/${encodeURIComponent(id)}/${action}`, ScheduleList, {}),
  confirmProposal: (id: string, fields?: ScheduleFields) => call(`/api/schedules/proposals/${encodeURIComponent(id)}/confirm`, ScheduleList, { fields }),
  discardProposal: (id: string) => call(`/api/schedules/proposals/${encodeURIComponent(id)}/discard`, ScheduleList, {}),
};

function attachmentResource(id: string): string {
  return `${attachmentsPath}/${encodeURIComponent(id)}`;
}

export function attachmentPath(id: string): string {
  return appPath(attachmentResource(id));
}

async function uploadPart(id: string, offset: number, part: Blob): Promise<Answer<AttachmentUpload>> {
  let response: Response;
  try {
    response = await fetch(`${attachmentPath(id)}/upload?offset=${offset}`, {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/octet-stream" },
      body: part,
    });
  } catch {
    return { ok: false, error: "network" };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { ok: false, error: "network" };
  }
  const parsed = AttachmentUpload.safeParse(value);
  if (response.ok && parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const refusal = Refusal.safeParse(value);
  return { ok: false, error: refusal.success ? refusal.data.error : "network" };
}

export function ticketFilePath(ticket: number, name: string): string {
  return appPath(`/api/tickets/${ticket}/files/${encodeURIComponent(name)}`);
}
