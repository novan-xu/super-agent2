import { type Memory, memoryChineseLength, memoryTextProblem, normalisedMemoryText } from "@super-agent2/protocol";

export interface MemoryState {
  readonly loaded: boolean;
  readonly memories: readonly Memory[];
}

export const initialMemory: MemoryState = { loaded: false, memories: [] };

export function newestFirst(a: Memory, b: Memory): number {
  return b.changedAt - a.changedAt || b.revision - a.revision || b.id - a.id;
}

export function receiveMemories(memories: readonly Memory[]): MemoryState {
  return { loaded: true, memories: [...memories].sort(newestFirst) };
}

export type EditProblem = "empty" | "long" | "chinese" | "unchanged" | "duplicate";

export function editProblem(memories: readonly Memory[], id: number, draft: string): EditProblem | null {
  const problem = memoryTextProblem(draft, "zh");
  if (problem !== null) {
    return problem;
  }
  const text = normalisedMemoryText(draft);
  const current = memories.find((memory) => memory.id === id);
  if (current !== undefined && current.text.zh === text) {
    return "unchanged";
  }
  return memories.some((memory) => memory.id !== id && memory.text.zh === text) ? "duplicate" : null;
}

export function shownProblem(problem: EditProblem | null): Exclude<EditProblem, "unchanged" | "empty"> | null {
  return problem === "long" || problem === "chinese" || problem === "duplicate" ? problem : null;
}

export const editLength = memoryChineseLength;
