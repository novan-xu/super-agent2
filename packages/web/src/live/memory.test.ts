import { type Memory, memoryChineseLength } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { editProblem, initialMemory, receiveMemories, shownProblem } from "./memory.js";
import { initialPage, pageReducer } from "./page.js";

function memory(id: number, zh: string, changedAt: number, revision: number = id): Memory {
  return { id, text: { en: `Memory ${id}`, zh }, by: "brain", stale: false, revision, createdAt: 1, changedAt };
}

describe("the memories on the page", () => {
  it("start unread and show the newest change first, whatever order they arrive in", () => {
    expect(initialMemory.loaded).toBe(false);
    const state = receiveMemories([memory(1, "甲", 100), memory(2, "乙", 300), memory(3, "丙", 300, 9)]);
    expect(state.loaded).toBe(true);
    expect(state.memories.map((item) => item.id)).toEqual([3, 2, 1]);
  });

  it("are replaced whole by each list the hub sends", () => {
    const first = pageReducer(initialPage, { type: "server", message: { type: "memories", memories: [memory(1, "甲", 1), memory(2, "乙", 2)] } });
    const second = pageReducer(first, { type: "server", message: { type: "memories", memories: [memory(2, "乙改", 3)] } });
    expect(second.memory).toEqual({ loaded: true, memories: [memory(2, "乙改", 3)] });
    const emptied = pageReducer(second, { type: "server", message: { type: "memories", memories: [] } });
    expect(emptied.memory).toEqual({ loaded: true, memories: [] });
  });
});

describe("an edit on the page", () => {
  const all = [memory(1, "回答要简短", 1), memory(2, "用 pnpm", 2)];

  it("can be saved only when it holds Chinese, is not too long, changes something and copies no other memory", () => {
    expect(editProblem(all, 1, "先说结论")).toBeNull();
    expect(editProblem(all, 1, "  ")).toBe("empty");
    expect(editProblem(all, 1, " 回答要简短 ")).toBe("unchanged");
    expect(editProblem(all, 1, "用  pnpm")).toBe("duplicate");
    expect(editProblem(all, 1, "short answers")).toBe("chinese");
    expect(editProblem(all, 1, "长".repeat(memoryChineseLength + 1))).toBe("long");
  });

  it("explains only what the owner can act on", () => {
    expect(shownProblem("empty")).toBeNull();
    expect(shownProblem("unchanged")).toBeNull();
    expect(shownProblem("duplicate")).toBe("duplicate");
    expect(shownProblem("chinese")).toBe("chinese");
    expect(shownProblem(null)).toBeNull();
  });
});
