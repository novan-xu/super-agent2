import { ConversationId, SendId, StreamPreview } from "@super-agent2/protocol";
import { z } from "zod";

const storageKey = "super-agent2:composer-drafts";
const maxAge = 30 * 24 * 60 * 60 * 1000;
const DraftDestination = StreamPreview.extend({ topic: ConversationId.nullable() });
export type DraftDestination = StreamPreview & { readonly topic: string | null };
const SendAttempt = z.object({ id: SendId, content: z.string() });
export type SendAttempt = z.infer<typeof SendAttempt>;

export interface ComposerDraft {
  readonly text: string;
  readonly quote?: { readonly id: string; readonly text: string };
  readonly destination?: DraftDestination | null | undefined;
  readonly attempt?: SendAttempt | undefined;
}

type DraftMap = Record<string, { readonly updatedAt: number; readonly draft: ComposerDraft }>;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readAll(now: number): DraftMap {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(storageKey) ?? "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const valid: DraftMap = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as { updatedAt?: unknown; draft?: unknown };
      if (typeof candidate.updatedAt !== "number" || now - candidate.updatedAt > maxAge || candidate.updatedAt > now + 60_000) continue;
      if (typeof candidate.draft !== "object" || candidate.draft === null || typeof (candidate.draft as ComposerDraft).text !== "string") continue;
      const { destination, attempt, ...draft } = candidate.draft as ComposerDraft;
      const parsed = DraftDestination.nullable().safeParse(destination);
      const sending = SendAttempt.safeParse(attempt);
      valid[key] = { updatedAt: candidate.updatedAt, draft: { ...draft, ...(parsed.success ? { destination: parsed.data } : {}), ...(sending.success ? { attempt: sending.data } : {}) } };
    }
    return valid;
  } catch {
    return {};
  }
}

export function loadComposerDraft(key: string, now = Date.now()): ComposerDraft {
  return readAll(now)[key]?.draft ?? { text: "" };
}

export function saveComposerDraft(key: string, draft: ComposerDraft, now = Date.now()): void {
  const target = storage();
  if (target === undefined) return;
  const all = readAll(now);
  if (draft.text === "" && draft.quote === undefined && draft.destination === undefined && draft.attempt === undefined) delete all[key];
  else all[key] = { updatedAt: now, draft };
  try {
    target.setItem(storageKey, JSON.stringify(all));
  } catch {}
}

export function newSendId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sendAttempt(previous: SendAttempt | undefined, content: string, create: () => string = newSendId): SendAttempt {
  return previous?.content === content ? previous : { id: create(), content };
}
