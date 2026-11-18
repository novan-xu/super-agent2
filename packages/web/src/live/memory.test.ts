import type { Memory, MemorySuggestion } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { canSave, initialMemory, receiveMemories, suggestionView } from "./memory.js";
import { initialPage, pageReducer } from "./page.js";

function memory(id: number, text: string, changedAt: number, revision: number = id): Memory {
  return { id, text, by: "brain", revision, createdAt: 1, changedAt };
}

function suggestion(id: number, text: string, createdAt: number, more: Partial<MemorySuggestion> = {}): MemorySuggestion {
  return { id, kind: "remember", text, memory: null, replaces: [], createdAt, ...more };
}

describe("the memories on the page", () => {
  it("start unread and show the newest change first, whatever order they arrive in", () => {
    expect(initialMemory.loaded).toBe(false);
    const state = receiveMemories({ memories: [memory(1, "甲", 100), memory(2, "乙", 300), memory(3, "丙", 300, 9)], suggestions: [suggestion(1, "丁", 5), suggestion(2, "戊", 9)] });
    expect(state.loaded).toBe(true);
    expect(state.memories.map((item) => item.id)).toEqual([3, 2, 1]);
    expect(state.suggestions.map((item) => item.id)).toEqual([2, 1]);
  });

  it("are replaced whole by each list the hub sends", () => {
    const first = pageReducer(initialPage, { type: "server", message: { type: "memories", memories: [memory(1, "甲", 1), memory(2, "乙", 2)], suggestions: [suggestion(1, "丙", 1)] } });
    const second = pageReducer(first, { type: "server", message: { type: "memories", memories: [memory(2, "乙改", 3)], suggestions: [] } });
    expect(second.memory).toEqual({ loaded: true, memories: [memory(2, "乙改", 3)], suggestions: [] });
  });
});

describe("a suggestion on the page", () => {
  const memories = [memory(1, "PR 失败时可以手动合并", 1), memory(2, "周报用中文写", 2)];

  it("shows the memories it replaces as they read now, leaving out those already gone", () => {
    expect(suggestionView(suggestion(5, "PR 必须等 CI 全绿", 3, { replaces: [1, 9] }), memories).struck).toEqual(["PR 失败时可以手动合并"]);
    expect(suggestionView(suggestion(6, "回答要短", 3), memories).struck).toEqual([]);
  });

  it("to forget shows the memory it would remove", () => {
    expect(suggestionView(suggestion(7, "旧的文字", 3, { kind: "forget", memory: 2 }), memories).struck).toEqual(["周报用中文写"]);
    expect(suggestionView(suggestion(8, "旧的文字", 3, { kind: "forget", memory: 9 }), memories).struck).toEqual(["旧的文字"]);
  });
});

describe("what the owner writes", () => {
  it("is saved whatever it says, unless the box is blank or nothing changed", () => {
    expect(canSave("先说结论", "")).toBe(true);
    expect(canSave(" 先说结论\n\n再列细节 ", "先说结论")).toBe(true);
    expect(canSave("Answer in English", "")).toBe(true);
    expect(canSave("长".repeat(5000), "")).toBe(true);
    expect(canSave(" \n　", "")).toBe(false);
    expect(canSave("先说结论", "先说结论")).toBe(false);
    expect(canSave(" 先说结论", "先说结论")).toBe(true);
  });
});
