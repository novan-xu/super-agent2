import {
  ConversationDetail,
  ConversationList,
  ConversationResponse,
  EntryResponse,
  Refusal,
} from "@super-agent2/protocol";
import type { z } from "zod";

export type Failure = Refusal["error"] | "network";

export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure };

async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(
      path,
      body === undefined
        ? { headers: { accept: "application/json" }, cache: "no-store" }
        : { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) },
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

const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;

export const hubApi = {
  conversations: () => call("/api/conversations", ConversationList),
  detail: (id: string) => call(conversationPath(id), ConversationDetail),
  create: () => call("/api/conversations", ConversationResponse, {}),
  send: (id: string, text: string) => call(`${conversationPath(id)}/messages`, EntryResponse, { text }),
  interrupt: (id: string) => call(`${conversationPath(id)}/interrupt`, ConversationResponse, {}),
};

export type HubApi = typeof hubApi;
