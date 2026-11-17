import {
  type ChainStartItem,
  CommandResponse,
  ConversationDetail,
  ConversationList,
  ConversationResponse,
  EntryResponse,
  PushKey,
  type PushSubscriptionRequest,
  PushState,
  Refusal,
  TicketDetail,
  TicketList,
} from "@super-agent2/protocol";
import type { z } from "zod";

export type Failure = Refusal["error"] | "network";

export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure };

async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown, method: "POST" | "DELETE" = "POST"): Promise<Answer<T>> {
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

export const hubApi = {
  conversations: () => call("/api/conversations", ConversationList),
  detail: (id: string) => call(conversationPath(id), ConversationDetail),
  create: () => call("/api/conversations", ConversationResponse, {}),
  send: (id: string, text: string) => call(`${conversationPath(id)}/messages`, EntryResponse, { text }),
  interrupt: (id: string) => call(`${conversationPath(id)}/interrupt`, ConversationResponse, {}),
  release: (id: string, fingerprint: string) => call(`${commandPath(id)}/release`, CommandResponse, { fingerprint }),
  refuse: (id: string, fingerprint: string) => call(`${commandPath(id)}/refuse`, CommandResponse, { fingerprint }),
  tickets: (scope: "open" | "all" = "open") => call(`/api/tickets?scope=${scope}`, TicketList),
  ticket: (id: number) => call(`/api/tickets/${id}`, TicketDetail),
  startChains: (chains: readonly ChainStartItem[]) => call("/api/chains/start", TicketList, { chains }),
  pushKey: () => call("/api/push", PushKey),
  subscribePush: (subscription: PushSubscriptionRequest) => call("/api/push/subscription", PushState, subscription),
  unsubscribePush: (endpoint: string) => call("/api/push/subscription", PushState, { endpoint }, "DELETE"),
};

export type HubApi = typeof hubApi;
