import { SendId } from "@super-agent2/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadComposerDraft, saveComposerDraft, sendAttempt } from "./drafts.js";

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

  it("keeps a send's id with the draft while the content stays the same", () => {
    const attempt = { id: "4f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", content: "[\"Hi\"]" };
    saveComposerDraft("scope:daily", { text: "Hi", attempt }, 10_000);
    expect(loadComposerDraft("scope:daily", 11_000)).toEqual({ text: "Hi", attempt });
    saveComposerDraft("scope:daily", { text: "Hi", attempt: { id: "not-an-id", content: "[\"Hi\"]" } }, 12_000);
    expect(loadComposerDraft("scope:daily", 13_000)).toEqual({ text: "Hi" });
    saveComposerDraft("scope:daily", { text: "", attempt }, 14_000);
    expect(loadComposerDraft("scope:daily", 15_000)).toEqual({ text: "", attempt });

    const create = vi.fn(() => "0d8a4c7e-1f2b-4c3d-9e4f-5a6b7c8d9e0f");
    expect(sendAttempt(attempt, "[\"Hi\"]", create)).toBe(attempt);
    expect(sendAttempt(attempt, "[\"Hello\"]", create)).toEqual({ id: "0d8a4c7e-1f2b-4c3d-9e4f-5a6b7c8d9e0f", content: "[\"Hello\"]" });
    expect(sendAttempt(undefined, "[\"Hi\"]", create).content).toBe("[\"Hi\"]");
    expect(create).toHaveBeenCalledTimes(2);
    const made = new Set(Array.from({ length: 64 }, () => sendAttempt(undefined, "").id));
    expect(made.size).toBe(64);
    for (const id of made) expect(SendId.safeParse(id).success).toBe(true);
  });

  it("drops drafts older than thirty days", () => {
    saveComposerDraft("ticket:42", { text: "old" }, 10_000);

    expect(loadComposerDraft("ticket:42", 10_000 + 30 * 24 * 60 * 60 * 1000 + 1)).toEqual({ text: "" });
  });
});
