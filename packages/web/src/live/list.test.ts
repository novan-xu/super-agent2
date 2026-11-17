import type { Conversation } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { mergeConversations, upsertConversation } from "./list.js";
import { reconnectDelay } from "./reconnect.js";

function conversation(id: string, updatedAt: number, title = id): Conversation {
  return { id, title, state: "idle", provider: null, createdAt: 0, updatedAt };
}

describe("upsertConversation", () => {
  it("keeps the most recently changed first", () => {
    const list = upsertConversation(upsertConversation([conversation("a", 1)], conversation("b", 2)), conversation("a", 3));
    expect(list.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("ignores an older copy", () => {
    const list = [conversation("a", 5, "new")];
    expect(upsertConversation(list, conversation("a", 4, "old"))).toBe(list);
  });
});

describe("mergeConversations", () => {
  it("keeps what arrived while the list was being read", () => {
    const list = [conversation("new", 9), conversation("a", 7, "live")];
    const merged = mergeConversations(list, [conversation("a", 6, "stale"), conversation("b", 1)]);
    expect(merged.map((item) => `${item.id}:${item.title}`)).toEqual(["new:new", "a:live", "b:b"]);
  });
});

describe("reconnectDelay", () => {
  it("waits longer after each failure, up to a limit", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});
