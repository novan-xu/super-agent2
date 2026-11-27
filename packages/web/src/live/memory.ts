import { isBlank, type Memory, type MemoryList, type MemorySuggestion } from "@super-agent2/protocol";

export interface MemoryState {
  readonly loaded: boolean;
  readonly sharing?: true;
  readonly memories: readonly Memory[];
  readonly suggestions: readonly MemorySuggestion[];
}

export const initialMemory: MemoryState = { loaded: false, memories: [], suggestions: [] };

export function newestFirst(a: Memory, b: Memory): number {
  return b.changedAt - a.changedAt || b.revision - a.revision || b.id - a.id;
}

function newestSuggestionFirst(a: MemorySuggestion, b: MemorySuggestion): number {
  return b.createdAt - a.createdAt || b.id - a.id;
}

export function receiveMemories(list: MemoryList): MemoryState {
  return { loaded: true, ...(list.sharing ? { sharing: true } : {}), memories: [...list.memories].sort(newestFirst), suggestions: [...list.suggestions].sort(newestSuggestionFirst) };
}

export function canSave(draft: string, original: string): boolean {
  return !isBlank(draft) && draft !== original;
}

export interface SuggestionView {
  readonly suggestion: MemorySuggestion;
  readonly struck: readonly string[];
}

export function suggestionView(suggestion: MemorySuggestion, memories: readonly Memory[]): SuggestionView {
  const named = suggestion.kind === "forget" ? (suggestion.memory === null ? [] : [suggestion.memory]) : suggestion.replaces;
  const struck = named.flatMap((id) => memories.filter((memory) => memory.id === id).map((memory) => memory.text));
  return { suggestion, struck: suggestion.kind === "forget" && struck.length === 0 ? [suggestion.text] : struck };
}
