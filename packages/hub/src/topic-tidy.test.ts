import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "./database.js";
import { storeTopic, type ConversationService } from "./conversations.js";
import { createTopicTidy } from "./topic-tidy.js";

describe("built-in topic tidy", () => {
  it("reviews idle matching topics at New York 05:00 without creating a schedule, and follows daylight saving time", () => {
    const directory = mkdtempSync(join(tmpdir(), "topic-tidy-"));
    let now = Date.parse("2026-03-07T09:59:00Z");
    const clock = { now: () => now };
    const database = openDatabase({ dataDir: directory, clock });
    const tidyTopics = vi.fn();
    const tidyNotice = vi.fn();
    let tick = () => {};
    const tidy = createTopicTidy({ database, clock, conversations: { tidyTopics, tidyNotice } as unknown as ConversationService,
      ticker: (callback) => { tick = callback; return () => {}; } });
    try {
      const add = (id: string, repository: string | null, text: string) => {
        const topic = storeTopic(database, now, id, { repository });
        database.connection.prepare("INSERT INTO conversation_entries (id, conversation_id, seq, kind, body, created_at, stream_seq) VALUES (?, ?, 1, 'owner', ?, ?, ?)")
          .run(id, topic, JSON.stringify({ text }), now, id === "a" ? 1 : id === "b" ? 2 : 3);
        return topic;
      };
      add("a", "owner/repo", "Please fix issue #123");
      add("b", "owner/repo", "Follow up on issue #123");
      add("c", "owner/other", "Follow up on issue #123");
      tick();
      expect(tidyTopics).not.toHaveBeenCalled();
      now = Date.parse("2026-03-07T10:00:00Z");
      tick();
      expect(tidyTopics).toHaveBeenCalledOnce();
      expect(tidyTopics.mock.calls[0]![0]).not.toContain('"title":"c"');
      expect(database.connection.prepare("SELECT * FROM schedules").all()).toEqual([]);
      now = Date.parse("2026-03-08T08:59:00Z");
      tick();
      expect(tidyTopics).toHaveBeenCalledOnce();
      now = Date.parse("2026-03-08T09:00:00Z");
      tick();
      expect(tidyTopics).toHaveBeenCalledTimes(2);
    } finally {
      tidy.close(); database.close(); rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not start a brain turn when topics are busy or have no candidates", () => {
    const directory = mkdtempSync(join(tmpdir(), "topic-tidy-empty-"));
    let now = Date.parse("2026-11-21T09:59:00Z");
    const clock = { now: () => now };
    const database = openDatabase({ dataDir: directory, clock });
    const tidyTopics = vi.fn();
    let tick = () => {};
    const tidy = createTopicTidy({ database, clock, conversations: { tidyTopics, tidyNotice: vi.fn() } as unknown as ConversationService,
      ticker: (callback) => { tick = callback; return () => {}; } });
    try {
      const one = storeTopic(database, now, "one");
      const two = storeTopic(database, now, "two");
      const insert = database.connection.prepare("INSERT INTO conversation_entries (id, conversation_id, seq, kind, body, taken, created_at, stream_seq) VALUES (?, ?, 1, 'owner', ?, ?, ?, ?)");
      insert.run("a", one, JSON.stringify({ text: "issue #123" }), 1, now, 1);
      insert.run("b", two, JSON.stringify({ text: "issue #123" }), 0, now, 2);
      now = Date.parse("2026-11-21T10:00:00Z");
      tick();
      expect(tidyTopics).not.toHaveBeenCalled();
      expect(database.connection.prepare("SELECT * FROM schedules").all()).toEqual([]);
    } finally {
      tidy.close(); database.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

});
