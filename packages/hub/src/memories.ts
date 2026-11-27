import {
  type BrainMemoryState,
  hasChinese,
  isBlank,
  type Memory,
  type MemoryAction,
  MemoryAction as MemoryActionShape,
  MemoryAuthor,
  type MemoryBrief,
  type MemoryChange,
  type MemoryList,
  type MemorySuggestion,
  memoryKey,
  MemoryScope,
  principleLimit,
  sharedMemoryLimit,
  type SetAside,
  SuggestionKind,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import { holdsCredential } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import type { PeerPayload, PeerQueue, PeerSource } from "./peer-exchange.js";

export type Refusal =
  | { readonly kind: "empty" }
  | { readonly kind: "chinese" }
  | { readonly kind: "credential" }
  | { readonly kind: "unknown"; readonly memory: number }
  | { readonly kind: "memory"; readonly memory: Memory }
  | { readonly kind: "pending"; readonly suggestion: MemorySuggestion }
  | { readonly kind: "declined"; readonly text: string; readonly at: number }
  | { readonly kind: "deleted"; readonly memory: number; readonly text: string; readonly at: number }
  | { readonly kind: "kept"; readonly memory: Memory; readonly at: number };

export type SuggestOutcome = { readonly ok: true; readonly suggestion: MemorySuggestion } | { readonly ok: false; readonly refusal: Refusal };

export type OwnerMemoryError = "not_found" | "bad_request";

export type OwnerMemoryOutcome = { readonly ok: true; readonly list: MemoryList } | { readonly ok: false; readonly error: OwnerMemoryError };

export interface RememberInput {
  readonly text: string;
  readonly replaces?: readonly number[];
  readonly scope?: MemoryScope;
  readonly ownerAsked?: boolean;
  readonly conversation: string | null;
}

export interface ForgetInput {
  readonly id: number;
  readonly ownerAsked?: boolean;
  readonly conversation: string | null;
}

export interface MemoryService {
  list(): Memory[];
  suggestions(): MemorySuggestion[];
  snapshot(): MemoryList;
  state(): BrainMemoryState;
  revision(): number;
  remember(input: RememberInput): SuggestOutcome;
  forget(input: ForgetInput): SuggestOutcome;
  add(text: string, scope?: MemoryScope): OwnerMemoryOutcome;
  edit(id: number, text: string, scope?: MemoryScope): OwnerMemoryOutcome;
  remove(id: number): OwnerMemoryOutcome;
  confirm(suggestion: number, scope?: MemoryScope): OwnerMemoryOutcome;
  decline(suggestion: number): OwnerMemoryOutcome;
  brief(conversation: string, seen: number | null): MemoryBrief | null;
  sharing(): boolean;
  readonly canProposePrinciples: boolean;
  proposePrinciple(text: string, conversation: string): SuggestOutcome;
  receivePeer(source: PeerSource, payload: Extract<PeerPayload, { kind: "remember" | "forget" }>): (() => void) | undefined;
  subscribe(listener: (list: MemoryList) => void): () => void;
}

export interface MemoryServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly secrets?: () => readonly string[];
  readonly peerQueue?: PeerQueue;
  readonly proposePrinciples?: boolean;
}

const ShareColumns = {
  scope: MemoryScope,
  origin: z.string().nullable(),
  peer_key: z.string().nullable(),
};

const MemoryRow = z.object({
  ...ShareColumns,
  id: z.number().int(),
  text: z.string(),
  author: MemoryAuthor,
  revision: z.number().int(),
  created_at: z.number().int(),
  changed_at: z.number().int(),
});

const SuggestionRow = z.object({
  ...ShareColumns,
  id: z.number().int(),
  kind: SuggestionKind,
  text: z.string(),
  memory_id: z.number().int().nullable(),
  replaces: z.string(),
  state: z.enum(["pending", "confirmed", "declined", "moot"]),
  created_at: z.number().int(),
  decided_at: z.number().int().nullable(),
});

const ChangeRow = z.object({
  revision: z.number().int(),
  memory_id: z.number().int(),
  suggestion_id: z.number().int().nullable(),
  action: MemoryActionShape,
  author: MemoryAuthor,
  conversation_id: z.string().nullable(),
  text: z.string(),
  at: z.number().int(),
});

const NumberRow = z.object({ value: z.number().int() });

const Replaces = z.array(z.number().int().positive());

function shareFields(value: { scope: MemoryScope; origin: string | null }) {
  return {
    ...(value.scope === "general" ? { scope: value.scope } : {}),
    ...(value.origin === null ? {} : { origin: value.origin }),
  };
}

type StoredMemory = Memory & { readonly peerKey: string | null };

function toMemory(row: unknown): StoredMemory {
  const value = MemoryRow.parse(row);
  return { id: value.id, text: value.text, by: value.author, revision: value.revision, createdAt: value.created_at, changedAt: value.changed_at,
    ...shareFields(value), peerKey: value.peer_key };
}

type StoredSuggestion = MemorySuggestion & {
  readonly state: z.infer<typeof SuggestionRow>["state"];
  readonly decidedAt: number | null;
  readonly peerKey: string | null;
};

function toSuggestion(row: unknown): StoredSuggestion {
  const value = SuggestionRow.parse(row);
  return {
    id: value.id,
    kind: value.kind,
    text: value.text,
    memory: value.memory_id,
    replaces: Replaces.parse(JSON.parse(value.replaces)),
    createdAt: value.created_at,
    state: value.state,
    decidedAt: value.decided_at,
    ...shareFields(value),
    peerKey: value.peer_key,
  };
}

interface NewSuggestion {
  readonly kind: z.infer<typeof SuggestionKind>;
  readonly text: string;
  readonly memory: number | null;
  readonly replaces: readonly number[];
  readonly conversation: string | null;
  readonly scope?: MemoryScope;
  readonly origin?: string;
  readonly peerKey?: string;
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const { connection } = options.database;
  const { clock } = options;
  const listeners = new Set<(list: MemoryList) => void>();
  const selectAll = connection.prepare("SELECT * FROM memories ORDER BY id");
  const selectOne = connection.prepare("SELECT * FROM memories WHERE id = ?");
  const selectRevision = connection.prepare("SELECT COALESCE(MAX(revision), 0) AS value FROM memory_changes");
  const selectChanges = connection.prepare("SELECT * FROM memory_changes WHERE revision > ? ORDER BY revision");
  const selectRemoved = connection.prepare("SELECT * FROM memory_changes WHERE author = 'owner' AND action IN ('deleted', 'replaced') ORDER BY revision");
  const insertChange = connection.prepare("INSERT INTO memory_changes (memory_id, suggestion_id, action, author, conversation_id, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertMemory = connection.prepare("INSERT INTO memories (id, text, author, revision, created_at, changed_at, scope, origin, peer_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const nextId = connection.prepare("SELECT MAX(COALESCE((SELECT MAX(memory_id) FROM memory_changes), 0), COALESCE((SELECT MAX(id) FROM memories), 0)) + 1 AS value");
  const updateMemory = connection.prepare("UPDATE memories SET text = ?, author = ?, revision = ?, changed_at = ?, scope = ? WHERE id = ?");
  const deleteMemory = connection.prepare("DELETE FROM memories WHERE id = ?");
  const selectSuggestions = connection.prepare("SELECT * FROM memory_suggestions WHERE state = ? ORDER BY id");
  const selectSuggestion = connection.prepare("SELECT * FROM memory_suggestions WHERE id = ?");
  const insertSuggestion = connection.prepare(
    "INSERT INTO memory_suggestions (kind, text, memory_id, replaces, conversation_id, state, created_at, scope, origin, peer_key) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
  );
  const decideSuggestion = connection.prepare("UPDATE memory_suggestions SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'");
  const settleForgets = connection.prepare("UPDATE memory_suggestions SET state = 'moot', decided_at = ? WHERE kind = 'forget' AND memory_id = ? AND state = 'pending'");

  const findShared = connection.prepare("SELECT * FROM memories WHERE peer_key = ?");
  const supersede = connection.prepare("UPDATE memory_suggestions SET state = 'moot', decided_at = ? WHERE peer_key = ? AND state = 'pending'");
  const sharing = () => options.peerQueue?.available() ?? false;
  const list = (): Memory[] => selectAll.all().map((row) => {
    const { peerKey: _key, ...memory } = toMemory(row);
    return memory;
  });
  const get = (id: number): StoredMemory | undefined => {
    const row = selectOne.get(id);
    return row === undefined ? undefined : toMemory(row);
  };
  const revision = (): number => NumberRow.parse(selectRevision.get()).value;
  const suggestionsIn = (state: StoredSuggestion["state"]): StoredSuggestion[] => selectSuggestions.all(state).map(toSuggestion);
  const pending = (): MemorySuggestion[] => suggestionsIn("pending").map(({ state: _state, decidedAt: _at, peerKey: _key, ...suggestion }) => suggestion);
  const snapshot = (): MemoryList => ({ memories: list(), suggestions: pending(), ...(sharing() ? { sharing: true } : {}) });

  const emit = () => {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        continue;
      }
    }
  };

  const record = (input: { memory: number; suggestion?: number; action: MemoryAction; by: z.infer<typeof MemoryAuthor>; conversation?: string | null; text: string }): number => {
    const result = insertChange.run(input.memory, input.suggestion ?? null, input.action, input.by, input.conversation ?? null, input.text, clock.now());
    return Number(result.lastInsertRowid);
  };

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

  const changed = <T extends { readonly ok: boolean }>(outcome: T): T => {
    if (outcome.ok) {
      emit();
    }
    return outcome;
  };

  const removed = (): { memory: number; text: string; at: number }[] =>
    selectRemoved
      .all()
      .map((row) => ChangeRow.parse(row))
      .map((row) => ({ memory: row.memory_id, text: row.text, at: row.at }));

  const declined = (): StoredSuggestion[] => suggestionsIn("declined");

  const setAside = (): SetAside[] => {
    const memories = list();
    const held = new Set(memories.map((memory) => memoryKey(memory.text)));
    const latest = new Map<string, SetAside>();
    const texts: SetAside[] = [
      ...declined()
        .filter((suggestion) => suggestion.kind === "remember")
        .map((suggestion): SetAside => ({ reason: "declined", memory: null, text: suggestion.text, at: suggestion.decidedAt ?? suggestion.createdAt })),
      ...removed().map((entry): SetAside => ({ reason: "deleted", memory: entry.memory, text: entry.text, at: entry.at })),
    ];
    for (const entry of texts) {
      const key = memoryKey(entry.text);
      if (held.has(key)) {
        continue;
      }
      const before = latest.get(key);
      if (before === undefined || before.at <= entry.at) {
        latest.delete(key);
        latest.set(key, entry);
      }
    }
    const kept = declined()
      .filter((suggestion) => suggestion.kind === "forget" && suggestion.memory !== null)
      .flatMap((suggestion): SetAside[] => {
        const memory = memories.find((candidate) => candidate.id === suggestion.memory);
        return memory === undefined || memoryKey(memory.text) !== memoryKey(suggestion.text)
          ? []
          : [{ reason: "kept", memory: memory.id, text: memory.text, at: suggestion.decidedAt ?? suggestion.createdAt }];
      });
    const seenKept = new Set<number>();
    const uniqueKept = kept.filter((entry) => {
      if (entry.memory === null || seenKept.has(entry.memory)) {
        return false;
      }
      seenKept.add(entry.memory);
      return true;
    });
    return [...latest.values(), ...uniqueKept].sort((a, b) => a.at - b.at);
  };

  const state = (): BrainMemoryState => ({
    memories: list().map((memory) => ({ id: memory.id, text: memory.text })),
    pending: pending().filter(({ kind }) => kind !== "principle").map((suggestion) => ({ id: suggestion.id, kind: suggestion.kind, text: suggestion.text, memory: suggestion.memory, replaces: suggestion.replaces })),
    setAside: setAside(),
  });

  const secretIn = (text: string): boolean => holdsCredential(text, options.secrets?.() ?? []);

  const shareable = (text: string) => text.trim().length <= sharedMemoryLimit && hasChinese(text) && !secretIn(text);

  const createSuggestion = (input: NewSuggestion): MemorySuggestion => {
    const now = clock.now();
    const { kind, text, memory, replaces, conversation, scope = "local", origin, peerKey } = input;
    const result = insertSuggestion.run(kind, text, memory, JSON.stringify(replaces), conversation, now, scope, origin ?? null, peerKey ?? null);
    const id = Number(result.lastInsertRowid);
    if (kind !== "principle") record({ memory: memory ?? 0, suggestion: id, action: "suggested", by: "brain", conversation, text });
    return { id, kind, text, memory, replaces: [...replaces], createdAt: now, ...shareFields({ scope, origin: origin ?? null }) };
  };

  const refusedMemory = (text: string, ownerAsked: boolean, pendingId?: number): Refusal | undefined => {
    const key = memoryKey(text);
    const held = list().find((memory) => memoryKey(memory.text) === key);
    if (held !== undefined) return { kind: "memory", memory: held };
    const waiting = pending().find((suggestion) => suggestion.id !== pendingId && suggestion.kind === "remember" && memoryKey(suggestion.text) === key);
    if (waiting !== undefined) return { kind: "pending", suggestion: waiting };
    if (ownerAsked) return undefined;
    const refused = declined().find((suggestion) => suggestion.kind === "remember" && memoryKey(suggestion.text) === key);
    if (refused !== undefined) return { kind: "declined", text: refused.text, at: refused.decidedAt ?? refused.createdAt };
    const deleted = removed().find((entry) => memoryKey(entry.text) === key);
    return deleted === undefined ? undefined : { kind: "deleted", memory: deleted.memory, text: deleted.text, at: deleted.at };
  };

  const remember: MemoryService["remember"] = (input) => {
    const text = input.text.trim();
    if (isBlank(text) || memoryKey(text) === "") return { ok: false, refusal: { kind: "empty" } };
    if (!hasChinese(text)) return { ok: false, refusal: { kind: "chinese" } };
    if (secretIn(text)) return { ok: false, refusal: { kind: "credential" } };
    return changed(
      atomically((): SuggestOutcome => {
        const replaces = [...new Set(input.replaces ?? [])];
        const unknown = replaces.find((id) => get(id) === undefined);
        if (unknown !== undefined) return { ok: false, refusal: { kind: "unknown", memory: unknown } };
        const refusal = refusedMemory(text, input.ownerAsked === true);
        if (refusal !== undefined) return { ok: false, refusal };
        const scope = sharing() && input.scope === "general" && shareable(text) ? "general" : "local";
        return { ok: true, suggestion: createSuggestion({ kind: "remember", text, memory: null, replaces, conversation: input.conversation, scope }) };
      }),
    );
  };

  const receivePeer: MemoryService["receivePeer"] = (source, payload) => {
    const peerKey = JSON.stringify([source.id, payload.item]);
    const row = findShared.get(peerKey);
    const prior = row === undefined ? undefined : toMemory(row);
    if (payload.kind === "remember" && (!shareable(payload.text) || memoryKey(payload.text) === "")) return undefined;
    const removedPending = supersede.run(clock.now(), peerKey).changes > 0;
    const metadata = { conversation: null, scope: "general" as const, origin: source.name, peerKey };
    if (payload.kind === "remember" && refusedMemory(payload.text, false) === undefined) {
      createSuggestion({ ...metadata, kind: "remember", text: payload.text, memory: null, replaces: prior === undefined ? [] : [prior.id] });
      return emit;
    }
    if (payload.kind === "forget" && prior !== undefined && !pending().some(({ kind, memory }) => kind === "forget" && memory === prior.id)
      && !declined().some(({ kind, memory, text }) => kind === "forget" && memory === prior.id && memoryKey(text) === memoryKey(prior.text))) {
      createSuggestion({ ...metadata, kind: "forget", text: prior.text, memory: prior.id, replaces: [] });
      return emit;
    }
    return removedPending ? emit : undefined;
  };

  const proposePrinciple: MemoryService["proposePrinciple"] = (value, conversation) => {
    const text = value.trim();
    if (options.proposePrinciples !== true || memoryKey(text) === "") return { ok: false, refusal: { kind: "empty" } };
    if (secretIn(text)) return { ok: false, refusal: { kind: "credential" } };
    const key = memoryKey(text);
    return changed(atomically((): SuggestOutcome => {
      const prior = pending().find((suggestion) => suggestion.kind === "principle" && memoryKey(suggestion.text) === key);
      if (prior !== undefined) return { ok: false, refusal: { kind: "pending", suggestion: prior } };
      return { ok: true, suggestion: createSuggestion({ kind: "principle", text, memory: null, replaces: [], conversation }) };
    }));
  };

  const forget: MemoryService["forget"] = (input) =>
    changed(
      atomically((): SuggestOutcome => {
        const memory = get(input.id);
        if (memory === undefined) {
          return { ok: false, refusal: { kind: "unknown", memory: input.id } };
        }
        const waiting = pending().find((suggestion) => suggestion.kind === "forget" && suggestion.memory === input.id);
        if (waiting !== undefined) {
          return { ok: false, refusal: { kind: "pending", suggestion: waiting } };
        }
        if (input.ownerAsked !== true) {
          const kept = declined().find((suggestion) => suggestion.kind === "forget" && suggestion.memory === input.id && memoryKey(suggestion.text) === memoryKey(memory.text));
          if (kept !== undefined) {
            return { ok: false, refusal: { kind: "kept", memory, at: kept.decidedAt ?? kept.createdAt } };
          }
        }
        return { ok: true, suggestion: createSuggestion({ kind: "forget", text: memory.text, memory: memory.id, replaces: [], conversation: input.conversation }) };
      }),
    );

  const drop = (memory: StoredMemory, action: "deleted" | "replaced", suggestion?: number) => {
    record({ memory: memory.id, ...(suggestion === undefined ? {} : { suggestion }), action, by: "owner", text: memory.text });
    deleteMemory.run(memory.id);
    settleForgets.run(clock.now(), memory.id);
    if (memory.scope === "general" && memory.peerKey === null) options.peerQueue?.enqueue({ kind: "forget", item: memory.id });
  };

  const create = (text: string, by: z.infer<typeof MemoryAuthor>, action: MemoryAction, scope: MemoryScope, suggestion?: StoredSuggestion): void => {
    const now = clock.now();
    const id = NumberRow.parse(nextId.get()).value;
    const at = record({ memory: id, ...(suggestion === undefined ? {} : { suggestion: suggestion.id }), action, by: "owner", text });
    insertMemory.run(id, text, by, at, now, now, scope, suggestion?.origin ?? null, suggestion?.peerKey ?? null);
    if (scope === "general" && suggestion?.peerKey == null) options.peerQueue?.enqueue({ kind: "remember", item: id, text: text.trim() });
  };

  const add: MemoryService["add"] = (text, scope = "local") => {
    if (isBlank(text) || (scope === "general" && (!sharing() || !shareable(text)))) return { ok: false, error: "bad_request" };
    return changed(
      atomically((): OwnerMemoryOutcome => {
        create(text, "owner", "added", scope);
        return { ok: true, list: snapshot() };
      }),
    );
  };

  const edit: MemoryService["edit"] = (id, text, selectedScope) => {
    if (isBlank(text)) return { ok: false, error: "bad_request" };
    let touched = false;
    const outcome = atomically((): OwnerMemoryOutcome => {
      const current = get(id);
      if (current === undefined) return { ok: false, error: "not_found" };
      const oldScope = current.scope ?? "local";
      const scope = current.peerKey === null ? selectedScope ?? (current.text === text ? oldScope : "local") : oldScope;
      if (current.peerKey === null && scope === "general" && (selectedScope !== undefined || sharing()) && !shareable(text)) {
        return { ok: false, error: "bad_request" };
      }
      if (scope === "general" && oldScope === "local" && !sharing()) return { ok: false, error: "bad_request" };
      if (current.text !== text || scope !== oldScope) {
        const at = record({ memory: id, action: "edited", by: "owner", text });
        updateMemory.run(text, "owner", at, clock.now(), scope, id);
        if (current.peerKey === null) {
          if (scope === "general") options.peerQueue?.enqueue({ kind: "remember", item: id, text: text.trim() });
          else if (oldScope === "general") options.peerQueue?.enqueue({ kind: "forget", item: id });
        }
        touched = true;
      }
      return { ok: true, list: snapshot() };
    });
    return touched ? changed(outcome) : outcome;
  };

  const remove: MemoryService["remove"] = (id) =>
    changed(
      atomically((): OwnerMemoryOutcome => {
        const current = get(id);
        if (current === undefined) {
          return { ok: false, error: "not_found" };
        }
        drop(current, "deleted");
        return { ok: true, list: snapshot() };
      }),
    );

  const pendingSuggestion = (id: number): StoredSuggestion | undefined => {
    const row = selectSuggestion.get(id);
    const suggestion = row === undefined ? undefined : toSuggestion(row);
    return suggestion?.state === "pending" ? suggestion : undefined;
  };

  const confirm: MemoryService["confirm"] = (id, selectedScope) =>
    changed(
      atomically((): OwnerMemoryOutcome => {
        const suggestion = pendingSuggestion(id);
        if (suggestion === undefined) {
          return { ok: false, error: "not_found" };
        }
        const fromPeer = suggestion.peerKey !== null;
        const scope = fromPeer ? "general" : selectedScope ?? "local";
        if (suggestion.kind === "principle") {
          if (options.proposePrinciples !== true || !sharing() || suggestion.text.length > principleLimit || secretIn(suggestion.text)) {
            return { ok: false, error: "bad_request" };
          }
          options.peerQueue?.enqueue({ kind: "principle", text: suggestion.text });
          decideSuggestion.run("confirmed", clock.now(), id);
        } else if (suggestion.kind === "remember") {
          if (fromPeer && (!shareable(suggestion.text) || refusedMemory(suggestion.text, false, id) !== undefined)) {
            return { ok: false, error: "bad_request" };
          }
          if (!fromPeer && scope === "general" && (!sharing() || !shareable(suggestion.text))) return { ok: false, error: "bad_request" };
          decideSuggestion.run("confirmed", clock.now(), id);
          if (fromPeer) {
            const prior = findShared.get(suggestion.peerKey);
            if (prior !== undefined) drop(toMemory(prior), "replaced", id);
          }
          create(suggestion.text, "brain", "confirmed", scope, suggestion);
          for (const replaced of suggestion.replaces) {
            const memory = get(replaced);
            if (memory !== undefined) drop(memory, "replaced", id);
          }
        } else {
          decideSuggestion.run("confirmed", clock.now(), id);
          const memory = suggestion.memory === null ? undefined : get(suggestion.memory);
          if (memory !== undefined) drop(memory, "deleted", id);
        }
        return { ok: true, list: snapshot() };
      }),
    );

  const decline: MemoryService["decline"] = (id) =>
    changed(
      atomically((): OwnerMemoryOutcome => {
        const suggestion = pendingSuggestion(id);
        if (suggestion === undefined) {
          return { ok: false, error: "not_found" };
        }
        decideSuggestion.run("declined", clock.now(), id);
        if (suggestion.kind !== "principle") record({ memory: suggestion.memory ?? 0, suggestion: id, action: "declined", by: "owner", text: suggestion.text });
        return { ok: true, list: snapshot() };
      }),
    );

  const brief: MemoryService["brief"] = (conversation, seen) => {
    const current = state();
    if (seen === null || seen <= 0) {
      const empty = current.memories.length === 0 && current.pending.length === 0 && current.setAside.length === 0;
      return empty ? null : { first: true, ...current, changes: [] };
    }
    const changes: MemoryChange[] = selectChanges
      .all(seen)
      .map((row) => ChangeRow.parse(row))
      .filter((row) => row.author === "owner" || row.conversation_id !== conversation)
      .map((row) => ({ action: row.action, by: row.author, memory: row.memory_id === 0 ? null : row.memory_id, suggestion: row.suggestion_id, text: row.text }));
    return changes.length === 0 ? null : { first: false, ...current, changes };
  };

  return {
    list,
    suggestions: pending,
    snapshot,
    state,
    revision,
    remember,
    forget,
    add,
    edit,
    remove,
    confirm,
    decline,
    sharing,
    canProposePrinciples: options.proposePrinciples === true,
    proposePrinciple,
    receivePeer,
    brief,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
