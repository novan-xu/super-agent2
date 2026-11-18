import {
  AttachmentUpload,
  attachmentsPath,
  type ChainStartItem,
  type ChoiceChange,
  CommandResponse,
  ConversationDetail,
  ConversationList,
  ConversationResponse,
  EntryResponse,
  MachineList,
  MemoryList,
  PushKey,
  type PushSubscriptionRequest,
  PushState,
  Refusal,
  type StuckAnswerRequest,
  TicketDetail,
  TicketHistory,
  TicketList,
  TicketResponse,
  WorkerMessageResponse,
  WorkEventList,
  type EngineTable,
  EngineTableBody,
  type GitHubAccount,
  MachineAdded,
  MachineRevoked,
  type MachineSystem,
  type Provider,
  SettingsSnapshot,
} from "@super-agent2/protocol";
import type { z } from "zod";

export type Failure = Refusal["error"] | "network";

export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure };

async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown, method: "POST" | "PUT" | "DELETE" = "POST"): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(
      path,
      body === undefined
        ? { headers: { accept: "application/json" }, cache: "no-store" }
        : { method, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) },
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
    return { ok: false, error: refusal.success ? refusal.data.error : "network" };
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

export const hubApi = {
  conversations: () => call("/api/conversations", ConversationList),
  detail: (id: string) => call(conversationPath(id), ConversationDetail),
  create: () => call("/api/conversations", ConversationResponse, {}),
  send: (id: string, text: string, attachments: readonly string[] = []) => call(`${conversationPath(id)}/messages`, EntryResponse, { text, attachments }),
  interrupt: (id: string) => call(`${conversationPath(id)}/interrupt`, ConversationResponse, {}),
  release: (id: string, fingerprint: string) => call(`${commandPath(id)}/release`, CommandResponse, { fingerprint }),
  refuse: (id: string, fingerprint: string) => call(`${commandPath(id)}/refuse`, CommandResponse, { fingerprint }),
  tickets: (scope: "open" | "all" = "open") => call(`/api/tickets?scope=${scope}`, TicketList),
  history: (page: HistoryRequest) => call(historyPath(page), TicketHistory),
  ticket: (id: number) => call(`/api/tickets/${id}`, TicketDetail),
  work: (id: number, after: number) => call(`/api/tickets/${id}/work?after=${after}`, WorkEventList),
  messageWorker: (id: number, text: string, attachments: readonly string[] = []) => call(`/api/tickets/${id}/messages`, WorkerMessageResponse, { text, attachments }),
  createAttachment: (name: string, size: number, mediaType: string) => call(attachmentsPath, AttachmentUpload, { name, size, mediaType }),
  uploadState: (id: string) => call(`${attachmentPath(id)}/upload`, AttachmentUpload),
  uploadPart: (id: string, offset: number, part: Blob) => uploadPart(id, offset, part),
  stopTicket: (id: number) => call(`/api/tickets/${id}/stop`, TicketResponse, {}),
  answerStuck: (id: number, request: StuckAnswerRequest) => call(`/api/tickets/${id}/answer`, TicketResponse, request),
  machines: () => call("/api/machines", MachineList),
  startChains: (chains: readonly ChainStartItem[]) => call("/api/chains/start", TicketList, { chains }),
  chooseChain: (ticket: number, change: ChoiceChange) => call("/api/chains/choice", TicketList, { ticket, ...change }),
  reassign: (ticket: number, change: ChoiceChange) => call(`/api/tickets/${ticket}/reassign`, TicketList, change),
  editMemory: (id: number, text: string, revision: number) => call(`/api/memories/${id}`, MemoryList, { text, revision }, "PUT"),
  deleteMemory: (id: number, revision: number) => call(`/api/memories/${id}`, MemoryList, { revision }, "DELETE"),
  settings: () => call("/api/settings", SettingsSnapshot),
  addMachine: (name: string, system: MachineSystem) => call("/api/machines", MachineAdded, { name, system }),
  revokeMachine: (name: string) => call(`/api/machines/${encodeURIComponent(name)}/revoke`, MachineRevoked, {}),
  setOrder: (order: readonly Provider[]) => call("/api/brain/order", SettingsSnapshot, { order }, "PUT"),
  setAccount: (repository: string, account: GitHubAccount) => call("/api/repositories/account", SettingsSnapshot, { repository, account }, "PUT"),
  setTable: (table: EngineTable) => call("/api/engine-table", EngineTableBody, { table }, "PUT"),
  pushKey: () => call("/api/push", PushKey),
  subscribePush: (subscription: PushSubscriptionRequest) => call("/api/push/subscription", PushState, subscription),
  unsubscribePush: (endpoint: string) => call("/api/push/subscription", PushState, { endpoint }, "DELETE"),
};

export type HubApi = typeof hubApi;

export function attachmentPath(id: string): string {
  return `${attachmentsPath}/${encodeURIComponent(id)}`;
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
  return `/api/tickets/${ticket}/files/${encodeURIComponent(name)}`;
}
