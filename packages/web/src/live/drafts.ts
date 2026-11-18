const storageKey = "super-agent2:composer-drafts";
const maxAge = 30 * 24 * 60 * 60 * 1000;

export interface ComposerDraft {
  readonly text: string;
  readonly quote?: { readonly id: string; readonly text: string };
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
      valid[key] = { updatedAt: candidate.updatedAt, draft: candidate.draft as ComposerDraft };
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
  if (draft.text === "" && draft.quote === undefined) delete all[key];
  else all[key] = { updatedAt: now, draft };
  try {
    target.setItem(storageKey, JSON.stringify(all));
  } catch {
    // Draft persistence is best effort when browser storage is unavailable or full.
  }
}
