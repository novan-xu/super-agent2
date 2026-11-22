import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { bigramSimilarity, bigramVector, dot, ownerTextLimit, replyTextLimit, referencesIn } from "@super-agent2/routing";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import { intervalTicker, type Ticker } from "./verification.js";

const day = 24 * 60 * 60 * 1000;
const Topic = z.object({ id: z.string(), title: z.string(), repository: z.string().nullable() });
const Entry = z.object({ id: z.string(), body: z.string(), kind: z.string() });
const Vector = z.object({ model: z.string(), vector: z.instanceof(Uint8Array) });

export function createTopicTidy(options: {
  database: HubDatabase; clock: Clock; conversations: ConversationService; time?: string | undefined;
  enabled?: boolean | undefined; ticker?: Ticker | undefined; report?: ((line: string) => void) | undefined;
}) {
  const { connection } = options.database;
  const [hour, minute] = (options.time ?? "05:00").split(":").map(Number);
  const cron = `${minute} ${hour} * * *`;
  const next = (at: number) => CronExpressionParser.parse(cron, { currentDate: new Date(at), tz: "America/New_York" }).next().getTime();
  const topics = connection.prepare(`SELECT c.id, c.title, c.repository
    FROM conversations c WHERE c.system = 0 AND c.code_system = 0 AND c.needs_repository = 0 AND c.merged_into IS NULL
      AND (max(c.activity_at, c.created_at) >= ? OR c.archived_at >= ?)
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id AND t.state = 'running')
      AND NOT EXISTS (SELECT 1 FROM conversation_entries e WHERE e.conversation_id = c.id AND e.taken = 0)
      AND NOT EXISTS (SELECT 1 FROM topic_merges m WHERE m.source = c.id OR m.destination = c.id)
    ORDER BY c.id`);
  const entries = connection.prepare("SELECT id, body, kind FROM conversation_entries WHERE conversation_id = ? AND kind IN ('owner', 'text') ORDER BY seq DESC LIMIT 8");
  const vectors = connection.prepare("SELECT model, vector FROM routing_vectors WHERE entry = ? AND text_hash = ?");
  const inFlight = connection.prepare(`SELECT 1 FROM conversation_entries e
    LEFT JOIN turns t ON t.id = e.turn_id WHERE e.hidden = 1 AND json_extract(e.body, '$.topicTidy') = 1
      AND (e.taken = 0 OR t.state = 'running') LIMIT 1`);
  const due = connection.prepare("SELECT next_at, time FROM topic_tidy_state WHERE id = 1");
  const advance = connection.prepare("INSERT INTO topic_tidy_state VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET next_at = excluded.next_at, time = excluded.time");
  const completed = connection.prepare(`SELECT p.source, p.destination FROM topic_tidy_merges p
    JOIN conversations c ON c.id = p.source WHERE c.merged_into = p.destination`);
  const forget = connection.prepare("DELETE FROM topic_tidy_merges WHERE source = ?");
  const reportMerges = () => {
    for (const row of completed.all()) {
      const pair = z.object({ source: z.string(), destination: z.string() }).parse(row);
      options.conversations.tidyNotice(`Topics merged: ${pair.source} → ${pair.destination}.`);
      forget.run(pair.source);
    }
  };
  const run = () => {
    if (inFlight.get() !== undefined) return;
    const all = topics.all(options.clock.now() - day, options.clock.now() - day).map((row) => {
      const topic = Topic.parse(row);
      const texts = entries.all(topic.id).map((entry) => {
        const value = Entry.parse(entry);
        let body: unknown;
        try { body = JSON.parse(value.body); } catch { body = {}; }
        const text = z.object({ text: z.string().optional() }).passthrough().parse(body).text ?? "";
        const hash = createHash("sha256").update(text.slice(0, value.kind === "owner" ? ownerTextLimit : replyTextLimit)).digest();
        const stored = vectors.all(value.id, hash).map((item) => Vector.parse(item)).map(({ model, vector }) => ({
          model, vector: new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)),
        }));
        return { text, stored, bigram: bigramVector(text) };
      }).filter(({ text }) => text.trim() !== "");
      return { ...topic, texts, refs: referencesIn([topic.title, ...texts.map(({ text }) => text)].join("\n"), false) };
    });
    const candidates: string[] = [];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!; const b = all[j]!;
      if (a.repository?.toLowerCase() !== b.repository?.toLowerCase()) continue;
      const reference = [...a.refs].some((ref) => b.refs.has(ref));
      const similar = a.texts.some((left) => b.texts.some((right) => bigramSimilarity(left.bigram, right.bigram) >= 0.8
        || left.stored.some((lv) => right.stored.some((rv) => lv.model === rv.model && lv.vector.length === rv.vector.length && dot(lv.vector, rv.vector) >= 0.85))));
      if (!reference && !similar) continue;
      candidates.push(JSON.stringify([a, b].map(({ id, title, texts }) => ({ id, title, excerpts: texts.slice(0, 2).map(({ text }) => text.slice(0, 500)) }))));
    }
    if (candidates.length > 0) {
      options.conversations.tidyTopics([
        "[hub] Built-in daily topic tidy. Review these candidate pairs; merge only topics clearly about the same subject using merge_topics.",
        "These are suggestions, not an instruction to merge. Do not ask the owner, send a message, or perform other work.",
        ...candidates,
      ].join("\n"));
    }
  };
  const poll = () => {
    try {
      reportMerges();
      const now = options.clock.now();
      const state = z.object({ next_at: z.number(), time: z.string() }).optional().parse(due.get());
      if (state === undefined || state.time !== cron) { advance.run(next(now), cron); return; }
      if (now >= state.next_at) { run(); advance.run(next(now), cron); }
    } catch (error) { options.report?.(`Topic tidy failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  if (options.enabled === false) return { close: () => undefined };
  poll();
  const stop = (options.ticker ?? intervalTicker(5_000))(poll);
  return { close: stop };
}
