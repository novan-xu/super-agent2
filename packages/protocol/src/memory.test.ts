import { describe, expect, it } from "vitest";
import { Prepared } from "./brain.js";
import { hasChinese, isBlank, memoryKey, sameMemoryText } from "./memory.js";

describe("when two memory texts are the same text", () => {
  it("ignores white space of every kind, including the ideographic space and line breaks", () => {
    expect(sameMemoryText("你的仓库一律用 pnpm", "你的仓库一律用pnpm")).toBe(true);
    expect(sameMemoryText("回答　要短", "回答要短")).toBe(true);
    expect(sameMemoryText("先说结论\n再列细节", "先说结论 再列细节")).toBe(true);
  });

  it("ignores punctuation in either width, and whether a sentence ends with a stop", () => {
    expect(sameMemoryText("回答要短，先说结论。", "回答要短,先说结论")).toBe(true);
    expect(sameMemoryText("用「pnpm」，不用“npm”！", "用pnpm不用npm")).toBe(true);
    expect(sameMemoryText("周报：标题带日期", "周报:标题带日期")).toBe(true);
  });

  it("ignores letter case and full-width letters and digits", () => {
    expect(sameMemoryText("PR 等 CI 全绿再合并", "pr 等 ci 全绿再合并")).toBe(true);
    expect(sameMemoryText("ＰＲ 等 ＣＩ 全绿", "PR 等 CI 全绿")).toBe(true);
    expect(sameMemoryText("每周１次", "每周1次")).toBe(true);
  });

  it("ignores invisible format characters", () => {
    expect(sameMemoryText("先说​结论", "先说结论")).toBe(true);
  });

  it("does not equate different words, different numbers or different characters", () => {
    expect(sameMemoryText("Rhino 的工作放在 pc 上", "Rhino 的工作放在 Mac mini 上")).toBe(false);
    expect(sameMemoryText("每周 1 次", "每周 2 次")).toBe(false);
    expect(sameMemoryText("不要用 npm", "要用 npm")).toBe(false);
    expect(sameMemoryText("C++ 项目", "C 项目")).toBe(false);
  });

  it("has an empty key for a text of only white space and punctuation", () => {
    expect(memoryKey(" 。，！ \n")).toBe("");
  });
});

describe("memory text checks", () => {
  it("finds a blank text, and only a blank one", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank(" \n\t　")).toBe(true);
    expect(isBlank(" 。")).toBe(false);
  });

  it("finds Chinese anywhere in a text", () => {
    expect(hasChinese("用 pnpm 而不是 npm")).toBe(true);
    expect(hasChinese("Use pnpm")).toBe(false);
  });
});

describe("the memory brief", () => {
  it("is absent from a prepared answer unless given", () => {
    expect(Prepared.parse({ type: "prepared", request: "r", session: null, history: [] }).memory).toBeNull();
    const brief = {
      first: true,
      memories: [{ id: 1, text: "先说结论" }],
      pending: [{ id: 2, kind: "remember", text: "回答要短", memory: null, replaces: [1] }],
      setAside: [{ reason: "declined", memory: null, text: "每天汇报", at: 5 }],
      changes: [],
    };
    expect(Prepared.parse({ type: "prepared", request: "r", session: null, history: [], memory: brief }).memory).toEqual(brief);
  });
});
