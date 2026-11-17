import { z } from "zod";
import { GeneratedText } from "./generated.js";

export const memoryLimit = 30;

export const memoryEnglishLength = 300;

export const memoryChineseLength = 200;

export const memoryChangeLimit = 30;

export const MemoryAuthor = z.enum(["brain", "owner"]);
export type MemoryAuthor = z.infer<typeof MemoryAuthor>;

export const MemoryId = z.number().int().positive();

export const Memory = z.object({
  id: MemoryId,
  text: GeneratedText,
  by: MemoryAuthor,
  stale: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  changedAt: z.number().int().nonnegative(),
});
export type Memory = z.infer<typeof Memory>;

export const MemoryList = z.object({
  memories: z.array(Memory),
  limit: z.number().int().positive(),
});
export type MemoryList = z.infer<typeof MemoryList>;

export const MemoriesUpdate = z.object({
  type: z.literal("memories"),
  memories: z.array(Memory),
});
export type MemoriesUpdate = z.infer<typeof MemoriesUpdate>;

export const MemoryEdit = z.object({
  text: z.string(),
  revision: z.number().int().positive(),
});
export type MemoryEdit = z.infer<typeof MemoryEdit>;

export const MemoryRemoval = z.object({
  revision: z.number().int().positive(),
});
export type MemoryRemoval = z.infer<typeof MemoryRemoval>;

export const MemoryAction = z.enum(["remembered", "rewritten", "edited", "deleted"]);
export type MemoryAction = z.infer<typeof MemoryAction>;

export const BrainMemory = z.object({
  id: MemoryId,
  text: z.string(),
  ownerWords: z.boolean(),
});
export type BrainMemory = z.infer<typeof BrainMemory>;

export const MemoryChange = z.object({
  id: MemoryId,
  action: MemoryAction,
  by: MemoryAuthor,
  text: z.string(),
});
export type MemoryChange = z.infer<typeof MemoryChange>;

export const MemoryBrief = z.object({
  first: z.boolean(),
  memories: z.array(BrainMemory),
  changes: z.array(MemoryChange),
  limit: z.number().int().positive(),
});
export type MemoryBrief = z.infer<typeof MemoryBrief>;

export type MemoryTextProblem = "empty" | "long" | "chinese";

export function normalisedMemoryText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function memoryTextProblem(text: string, language: "en" | "zh"): MemoryTextProblem | null {
  const normalised = normalisedMemoryText(text);
  if (normalised === "") {
    return "empty";
  }
  if ([...normalised].length > (language === "en" ? memoryEnglishLength : memoryChineseLength)) {
    return "long";
  }
  if (language === "zh" && !/\p{Script=Han}/u.test(normalised)) {
    return "chinese";
  }
  return null;
}

export interface MemoryContent {
  readonly text: GeneratedText;
  readonly by: MemoryAuthor;
  readonly stale: boolean;
}

export function rewrittenByBrain(current: MemoryContent, given: GeneratedText): MemoryContent {
  const text = { en: normalisedMemoryText(given.en), zh: normalisedMemoryText(given.zh) };
  const translated = current.stale && current.by === "owner" && text.zh === current.text.zh;
  return { text, by: translated ? "owner" : "brain", stale: false };
}

export function editedByOwner(current: MemoryContent, zh: string): MemoryContent | null {
  const text = normalisedMemoryText(zh);
  if (text === current.text.zh) {
    return null;
  }
  return { text: { en: current.text.en, zh: text }, by: "owner", stale: true };
}

export function textForBrain(memory: Pick<MemoryContent, "text" | "stale">): string {
  return memory.stale ? memory.text.zh : memory.text.en;
}

export function hasRoomFor(count: number): boolean {
  return count < memoryLimit;
}
