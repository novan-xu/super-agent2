import {
  editedByOwner,
  type GeneratedText,
  hasRoomFor,
  type Memory,
  type MemoryAction,
  MemoryAuthor,
  type MemoryBrief,
  type MemoryChange,
  MemoryAction as MemoryActionShape,
  memoryChangeLimit,
  memoryLimit,
  memoryTextProblem,
  normalisedMemoryText,
  rewrittenByBrain,
  textForBrain,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import { holdsCredential } from "./credentials.js";
import type { HubDatabase } from "./database.js";

export type RememberOutcome =
  | { readonly ok: true; readonly memory: Memory; readonly added: boolean; readonly count: number }
  | { readonly ok: false; readonly reason: string };

export type ForgetOutcome = { readonly ok: true; readonly memory: Memory; readonly count: number } | { readonly ok: false; readonly reason: string };

export type OwnerMemoryError = "not_found" | "conflict" | "bad_request" | "credential" | "duplicate";

export type OwnerMemoryOutcome = { readonly ok: true; readonly memories: Memory[] } | { readonly ok: false; readonly error: OwnerMemoryError };

export interface MemoryService {
  list(): Memory[];
  revision(): number;
  remember(input: { readonly id?: number; readonly text: GeneratedText; readonly conversation: string | null }): RememberOutcome;
  forget(id: number, conversation: string | null): ForgetOutcome;
  edit(id: number, zh: string, revision: number): OwnerMemoryOutcome;
  remove(id: number, revision: number): OwnerMemoryOutcome;
  brief(conversation: string, seen: number | null): MemoryBrief | null;
  subscribe(listener: (memories: readonly Memory[]) => void): () => void;
}

export interface MemoryServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly secrets?: () => readonly string[];
}

const MemoryRow = z.object({
  id: z.number().int(),
  text_en: z.string(),
  text_zh: z.string(),
  author: MemoryAuthor,
  stale: z.number().int(),
  revision: z.number().int(),
  created_at: z.number().int(),
  changed_at: z.number().int(),
});

const ChangeRow = z.object({
  revision: z.number().int(),
  memory_id: z.number().int(),
  action: MemoryActionShape,
  author: MemoryAuthor,
  conversation_id: z.string().nullable(),
  text: z.string(),
});

const NumberRow = z.object({ value: z.number().int() });

function toMemory(row: unknown): Memory {
  const value = MemoryRow.parse(row);
  return {
    id: value.id,
    text: { en: value.text_en, zh: value.text_zh },
    by: value.author,
    stale: value.stale === 1,
    revision: value.revision,
    createdAt: value.created_at,
    changedAt: value.changed_at,
  };
}

const problemWords = {
  empty: "is empty",
  long: "is too long",
  chinese: "has no Chinese",
} as const;

export const credentialRefusal =
  "Refused: this looks like a credential (a token, a key, a password or a secret value). A memory never holds a credential; the hub keeps them. Remember where a credential is used, never its value.";

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const { connection } = options.database;
  const { clock } = options;
  const listeners = new Set<(memories: readonly Memory[]) => void>();
  const selectAll = connection.prepare("SELECT * FROM memories ORDER BY revision DESC, id DESC");
  const selectOne = connection.prepare("SELECT * FROM memories WHERE id = ?");
  const selectCount = connection.prepare("SELECT COUNT(*) AS value FROM memories");
  const selectRevision = connection.prepare("SELECT COALESCE(MAX(revision), 0) AS value FROM memory_changes");
  const selectChanges = connection.prepare("SELECT * FROM memory_changes WHERE revision > ? ORDER BY revision");
  const insertChange = connection.prepare("INSERT INTO memory_changes (memory_id, action, author, conversation_id, text, at) VALUES (?, ?, ?, ?, ?, ?)");
  const insertMemory = connection.prepare(
    "INSERT INTO memories (id, text_en, text_zh, author, stale, revision, created_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const nextId = connection.prepare("SELECT COALESCE(MAX(memory_id), 0) + 1 AS value FROM memory_changes");
  const updateMemory = connection.prepare("UPDATE memories SET text_en = ?, text_zh = ?, author = ?, stale = ?, revision = ?, changed_at = ? WHERE id = ?");
  const deleteMemory = connection.prepare("DELETE FROM memories WHERE id = ?");

  const list = (): Memory[] => selectAll.all().map(toMemory);
  const get = (id: number): Memory | undefined => {
    const row = selectOne.get(id);
    return row === undefined ? undefined : toMemory(row);
  };
  const count = (): number => NumberRow.parse(selectCount.get()).value;
  const revision = (): number => NumberRow.parse(selectRevision.get()).value;

  const emit = () => {
    const memories = list();
    for (const listener of listeners) {
      try {
        listener(memories);
      } catch {
        continue;
      }
    }
  };

  const record = (id: number, action: MemoryAction, by: MemoryAuthor, conversation: string | null, text: string): number => {
    const result = insertChange.run(id, action, by, conversation, text, clock.now());
    return Number(result.lastInsertRowid);
  };

  const secretIn = (text: GeneratedText | string): boolean => {
    const values = options.secrets?.() ?? [];
    const texts = typeof text === "string" ? [text] : [text.en, text.zh];
    return texts.some((value) => holdsCredential(value, values));
  };

  const duplicateOf = (text: GeneratedText, except: number | undefined): Memory | undefined =>
    list().find((memory) => memory.id !== except && (memory.text.en === text.en || memory.text.zh === text.zh));

  const atomically = <T>(run: () => T): T => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      connection.exec("COMMIT");
      return value;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  };

  const remember: MemoryService["remember"] = ({ id, text: given, conversation }) => {
    const text = { en: normalisedMemoryText(given.en), zh: normalisedMemoryText(given.zh) };
    for (const language of ["en", "zh"] as const) {
      const problem = memoryTextProblem(text[language], language);
      if (problem !== null) {
        return { ok: false, reason: `Refused: the ${language === "en" ? "English" : "Chinese"} text ${problemWords[problem]}. A memory is one short sentence: at most 300 characters in English and 200 in Chinese.` };
      }
    }
    if (secretIn(text)) {
      return { ok: false, reason: credentialRefusal };
    }
    const outcome = atomically((): RememberOutcome => {
      const now = clock.now();
      if (id !== undefined) {
        const current = get(id);
        if (current === undefined) {
          return { ok: false, reason: `Refused: there is no memory #${id}. It may have been deleted; call recall to see your memory.` };
        }
        const duplicate = duplicateOf(text, id);
        if (duplicate !== undefined) {
          return { ok: false, reason: `Refused: memory #${duplicate.id} already says this. Forget one of the two instead.` };
        }
        const next = rewrittenByBrain(current, text);
        const changed = record(id, "rewritten", "brain", conversation, next.text.en);
        updateMemory.run(next.text.en, next.text.zh, next.by, next.stale ? 1 : 0, changed, now, id);
        const memory = get(id);
        return memory === undefined ? { ok: false, reason: `Memory #${id} was not stored` } : { ok: true, memory, added: false, count: count() };
      }
      const duplicate = duplicateOf(text, undefined);
      if (duplicate !== undefined) {
        return { ok: false, reason: `Refused: memory #${duplicate.id} already says this.` };
      }
      const held = count();
      if (!hasRoomFor(held)) {
        return {
          ok: false,
          reason: `Refused: your memory is full (${held} of ${memoryLimit}). Make room first: forget a memory that no longer holds, or merge two into one by rewriting one with remember and its id and forgetting the other. Then add this again.`,
        };
      }
      const newId = Math.max(NumberRow.parse(nextId.get()).value, 1);
      const changed = record(newId, "remembered", "brain", conversation, text.en);
      insertMemory.run(newId, text.en, text.zh, "brain", 0, changed, now, now);
      const memory = get(newId);
      return memory === undefined ? { ok: false, reason: `Memory #${newId} was not stored` } : { ok: true, memory, added: true, count: count() };
    });
    if (outcome.ok) {
      emit();
    }
    return outcome;
  };

  const forget: MemoryService["forget"] = (id, conversation) => {
    const outcome = atomically((): ForgetOutcome => {
      const current = get(id);
      if (current === undefined) {
        return { ok: false, reason: `There is no memory #${id}. Call recall to see your memory.` };
      }
      record(id, "deleted", "brain", conversation, textForBrain(current));
      deleteMemory.run(id);
      return { ok: true, memory: current, count: count() };
    });
    if (outcome.ok) {
      emit();
    }
    return outcome;
  };

  const edit: MemoryService["edit"] = (id, zh, expected) => {
    const problem = memoryTextProblem(zh, "zh");
    if (problem !== null) {
      return { ok: false, error: "bad_request" };
    }
    if (secretIn(zh)) {
      return { ok: false, error: "credential" };
    }
    const outcome = atomically((): OwnerMemoryOutcome => {
      const current = get(id);
      if (current === undefined) {
        return { ok: false, error: "not_found" };
      }
      if (current.revision !== expected) {
        return { ok: false, error: "conflict" };
      }
      const next = editedByOwner(current, zh);
      if (next === null) {
        return { ok: true, memories: list() };
      }
      if (list().some((memory) => memory.id !== id && memory.text.zh === next.text.zh)) {
        return { ok: false, error: "duplicate" };
      }
      const changed = record(id, "edited", "owner", null, next.text.zh);
      updateMemory.run(next.text.en, next.text.zh, next.by, next.stale ? 1 : 0, changed, clock.now(), id);
      return { ok: true, memories: list() };
    });
    if (outcome.ok) {
      emit();
    }
    return outcome;
  };

  const remove: MemoryService["remove"] = (id, expected) => {
    const outcome = atomically((): OwnerMemoryOutcome => {
      const current = get(id);
      if (current === undefined) {
        return { ok: false, error: "not_found" };
      }
      if (current.revision !== expected) {
        return { ok: false, error: "conflict" };
      }
      record(id, "deleted", "owner", null, textForBrain(current));
      deleteMemory.run(id);
      return { ok: true, memories: list() };
    });
    if (outcome.ok) {
      emit();
    }
    return outcome;
  };

  const brief: MemoryService["brief"] = (conversation, seen) => {
    const memories = list()
      .sort((a, b) => a.id - b.id)
      .map((memory) => ({ id: memory.id, text: textForBrain(memory), ownerWords: memory.stale }));
    if (seen === null) {
      return memories.length === 0 ? null : { first: true, memories, changes: [], limit: memoryLimit };
    }
    const changes: MemoryChange[] = selectChanges
      .all(seen)
      .map((row) => ChangeRow.parse(row))
      .filter((row) => row.author === "owner" || row.conversation_id !== conversation)
      .map((row) => ({ id: row.memory_id, action: row.action, by: row.author, text: row.text }));
    if (changes.length === 0) {
      return null;
    }
    return { first: false, memories, changes: changes.slice(-memoryChangeLimit), limit: memoryLimit };
  };

  return {
    list,
    revision,
    remember,
    forget,
    edit,
    remove,
    brief,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
