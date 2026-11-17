import { describe, expect, it } from "vitest";
import { Prepared } from "./brain.js";
import {
  editedByOwner,
  hasRoomFor,
  memoryChineseLength,
  memoryEnglishLength,
  memoryLimit,
  memoryTextProblem,
  normalisedMemoryText,
  rewrittenByBrain,
  textForBrain,
} from "./memory.js";

const written = { text: { en: "The owner wants answers short.", zh: "你希望回答简短。" }, by: "brain", stale: false } as const;

describe("memory text", () => {
  it("is kept on one line with single spaces", () => {
    expect(normalisedMemoryText("  Reply\n\tin  Chinese \r\n ")).toBe("Reply in Chinese");
    expect(normalisedMemoryText("回答　要短")).toBe("回答 要短");
  });

  it("refuses an empty text, a text over its length and a Chinese copy without Chinese", () => {
    expect(memoryTextProblem(" \n ", "en")).toBe("empty");
    expect(memoryTextProblem("a".repeat(memoryEnglishLength), "en")).toBeNull();
    expect(memoryTextProblem("a".repeat(memoryEnglishLength + 1), "en")).toBe("long");
    expect(memoryTextProblem("短".repeat(memoryChineseLength), "zh")).toBeNull();
    expect(memoryTextProblem("短".repeat(memoryChineseLength + 1), "zh")).toBe("long");
    expect(memoryTextProblem("Short answers", "zh")).toBe("chinese");
    expect(memoryTextProblem("用 pnpm 而不是 npm", "zh")).toBeNull();
  });

  it("counts characters, not code units", () => {
    expect(memoryTextProblem("𠀀".repeat(memoryChineseLength), "zh")).toBeNull();
  });

  it("has room until the limit", () => {
    expect(hasRoomFor(memoryLimit - 1)).toBe(true);
    expect(hasRoomFor(memoryLimit)).toBe(false);
  });
});

describe("how an edit resolves", () => {
  it("an owner's edit replaces the Chinese, keeps the English and marks it stale", () => {
    expect(editedByOwner(written, "  你希望回答 简短，先说结论。 ")).toEqual({
      text: { en: "The owner wants answers short.", zh: "你希望回答 简短，先说结论。" },
      by: "owner",
      stale: true,
    });
  });

  it("an edit that changes nothing is no edit", () => {
    expect(editedByOwner(written, " 你希望回答简短。")).toBeNull();
  });

  it("the brain is given the owner's Chinese while the English is stale", () => {
    const edited = editedByOwner(written, "你希望先说结论");
    expect(edited).not.toBeNull();
    expect(textForBrain(edited ?? written)).toBe("你希望先说结论");
    expect(textForBrain(written)).toBe("The owner wants answers short.");
  });

  it("the brain writing the English for the owner's Chinese leaves it the owner's", () => {
    const edited = editedByOwner(written, "你希望先说结论");
    expect(rewrittenByBrain(edited ?? written, { en: "The owner wants the conclusion first.", zh: "你希望先说结论" })).toEqual({
      text: { en: "The owner wants the conclusion first.", zh: "你希望先说结论" },
      by: "owner",
      stale: false,
    });
  });

  it("the brain changing the owner's words makes it the brain's", () => {
    const edited = editedByOwner(written, "你希望先说结论");
    expect(rewrittenByBrain(edited ?? written, { en: "Conclusion first, then details.", zh: "先说结论，再说细节" })).toMatchObject({ by: "brain", stale: false });
    expect(rewrittenByBrain(written, { en: "The owner wants answers short.", zh: "你希望回答简短。" })).toMatchObject({ by: "brain", stale: false });
  });
});

describe("the memory a turn is prepared with", () => {
  it("is none when the hub does not send it", () => {
    expect(Prepared.parse({ type: "prepared", request: "r", session: null, history: [] }).memory).toBeNull();
  });
});
