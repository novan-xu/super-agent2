import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadComposerDraft, saveComposerDraft } from "./drafts.js";

describe("composer drafts", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  it("persists text and a quoted message", () => {
    saveComposerDraft("scope:code", { text: "unfinished", quote: { id: "entry-1", text: "Quoted text" } }, 10_000);

    expect(loadComposerDraft("scope:code", 11_000)).toEqual({ text: "unfinished", quote: { id: "entry-1", text: "Quoted text" } });
  });

  it("isolates scopes and removes a draft when it is cleared", () => {
    saveComposerDraft("scope:code", { text: "code draft" }, 10_000);
    saveComposerDraft("scope:daily", { text: "daily draft" }, 10_000);

    expect(loadComposerDraft("scope:code", 11_000).text).toBe("code draft");
    expect(loadComposerDraft("scope:daily", 11_000).text).toBe("daily draft");
    saveComposerDraft("scope:code", { text: "" }, 12_000);
    expect(loadComposerDraft("scope:code", 13_000)).toEqual({ text: "" });
    expect(loadComposerDraft("scope:daily", 13_000).text).toBe("daily draft");
  });

  it("drops drafts older than thirty days", () => {
    saveComposerDraft("ticket:42", { text: "old" }, 10_000);

    expect(loadComposerDraft("ticket:42", 10_000 + 30 * 24 * 60 * 60 * 1000 + 1)).toEqual({ text: "" });
  });
});
