import { z } from "zod";

export const MemoryAuthor = z.enum(["brain", "owner"]);
export type MemoryAuthor = z.infer<typeof MemoryAuthor>;

export const MemoryId = z.number().int().positive();

export const SuggestionId = z.number().int().positive();

export const MemoryScope = z.enum(["local", "general"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const sharedMemoryLimit = 4_000;
export const principleLimit = 1_600;

export const Memory = z.object({
  id: MemoryId,
  text: z.string(),
  by: MemoryAuthor,
  scope: MemoryScope.optional(),
  origin: z.string().optional(),
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  changedAt: z.number().int().nonnegative(),
});
export type Memory = z.infer<typeof Memory>;

export const SuggestionKind = z.enum(["remember", "forget", "principle"]);
export type SuggestionKind = z.infer<typeof SuggestionKind>;

export const MemorySuggestion = z.object({
  id: SuggestionId,
  kind: SuggestionKind,
  text: z.string(),
  memory: MemoryId.nullable(),
  replaces: z.array(MemoryId),
  createdAt: z.number().int().nonnegative(),
  scope: MemoryScope.optional(),
  origin: z.string().optional(),
});
export type MemorySuggestion = z.infer<typeof MemorySuggestion>;

export const MemoryList = z.object({
  memories: z.array(Memory),
  suggestions: z.array(MemorySuggestion),
  sharing: z.literal(true).optional(),
});
export type MemoryList = z.infer<typeof MemoryList>;

export const MemoriesUpdate = z.object({
  type: z.literal("memories"),
  memories: z.array(Memory),
  suggestions: z.array(MemorySuggestion),
  sharing: z.literal(true).optional(),
});
export type MemoriesUpdate = z.infer<typeof MemoriesUpdate>;

export const MemoryText = z.object({
  text: z.string(),
  scope: MemoryScope.optional(),
});
export type MemoryText = z.infer<typeof MemoryText>;

export const MemoryAction = z.enum(["added", "edited", "deleted", "replaced", "suggested", "confirmed", "declined"]);
export type MemoryAction = z.infer<typeof MemoryAction>;

export const BrainMemory = z.object({
  id: MemoryId,
  text: z.string(),
});
export type BrainMemory = z.infer<typeof BrainMemory>;

export const BrainSuggestion = z.object({
  id: SuggestionId,
  kind: SuggestionKind,
  text: z.string(),
  memory: MemoryId.nullable(),
  replaces: z.array(MemoryId),
});
export type BrainSuggestion = z.infer<typeof BrainSuggestion>;

export const SetAsideReason = z.enum(["declined", "deleted", "kept"]);
export type SetAsideReason = z.infer<typeof SetAsideReason>;

export const SetAside = z.object({
  reason: SetAsideReason,
  memory: MemoryId.nullable(),
  text: z.string(),
  at: z.number().int().nonnegative(),
});
export type SetAside = z.infer<typeof SetAside>;

export const BrainMemoryState = z.object({
  memories: z.array(BrainMemory),
  pending: z.array(BrainSuggestion),
  setAside: z.array(SetAside),
});
export type BrainMemoryState = z.infer<typeof BrainMemoryState>;

export const MemoryChange = z.object({
  action: MemoryAction,
  by: MemoryAuthor,
  memory: MemoryId.nullable(),
  suggestion: SuggestionId.nullable(),
  text: z.string(),
});
export type MemoryChange = z.infer<typeof MemoryChange>;

export const MemoryBrief = BrainMemoryState.extend({
  first: z.boolean(),
  changes: z.array(MemoryChange),
});
export type MemoryBrief = z.infer<typeof MemoryBrief>;

export function memoryKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{Cf}]/gu, "");
}

export function sameMemoryText(a: string, b: string): boolean {
  return memoryKey(a) === memoryKey(b);
}

export function isBlank(text: string): boolean {
  return !/[^\p{White_Space}]/u.test(text);
}

export function hasChinese(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function quoted(text: string): string {
  return JSON.stringify(text);
}

function suggestionLine(suggestion: BrainSuggestion): string {
  if (suggestion.kind === "forget") {
    return `- suggestion ${suggestion.id}: forget #${suggestion.memory ?? 0} ${quoted(suggestion.text)}`;
  }
  const replacing = suggestion.replaces.length === 0 ? "" : `, replacing ${suggestion.replaces.map((id) => `#${id}`).join(", ")}`;
  return `- suggestion ${suggestion.id}: remember ${quoted(suggestion.text)}${replacing}`;
}

function setAsideLine(entry: SetAside): string {
  switch (entry.reason) {
    case "declined":
      return `- declined by the owner on ${day(entry.at)}: ${quoted(entry.text)}`;
    case "deleted":
      return `- deleted by the owner on ${day(entry.at)}${entry.memory === null ? "" : ` (was #${entry.memory})`}: ${quoted(entry.text)}`;
    case "kept":
      return `- kept by the owner on ${day(entry.at)} when you suggested forgetting it: #${entry.memory ?? 0} ${quoted(entry.text)}`;
  }
}

export function describeMemoryState(state: BrainMemoryState): string[] {
  const lines =
    state.memories.length === 0
      ? ["Your memory is empty."]
      : [`Your memory (${state.memories.length}), exactly as the owner keeps it in 记忆:`, ...state.memories.map((memory) => `- #${memory.id} ${quoted(memory.text)}`)];
  if (state.pending.length > 0) {
    lines.push("Suggestions waiting for the owner in 记忆 (already made; do not suggest them again):", ...state.pending.map(suggestionLine));
  }
  if (state.setAside.length > 0) {
    lines.push("Set aside by the owner (do not suggest these again unless the owner asks for them):", ...state.setAside.map(setAsideLine));
  }
  return lines;
}
