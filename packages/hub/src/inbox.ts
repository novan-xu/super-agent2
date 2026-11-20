import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AccessServiceTokens } from "./cloudflare.js";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import type { PushService } from "./push-service.js";

const Source = z.object({ id: z.string(), name: z.string(), client_id: z.string(), token_id: z.string(), topic: z.string().nullable() });
const Previous = z.object({ body_hash: z.string(), entry: z.string() });
export const InboxName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const InboxMessage = z.object({ text: z.string().min(1).max(16000).refine((value) => value.trim() !== ""), title: z.string().max(200).optional(), link: z.url().max(2048).refine((value) => /^https?:\/\//i.test(value)).optional() }).strict();
export type InboxMessage = z.infer<typeof InboxMessage>;

export function createInbox(options: { database: HubDatabase; clock: Clock; conversations: ConversationService; tokens?: AccessServiceTokens | undefined; push?: PushService | undefined }) {
  const db = options.database.connection;
  const rates = new Map<string, number[]>();
  return {
    list: () => db.prepare("SELECT id, name FROM inbox_sources WHERE revoked_at IS NULL ORDER BY name").all(),
    create: async (name: string) => {
      if (options.tokens === undefined) return { error: "unavailable" as const };
      if (db.prepare("SELECT id FROM inbox_sources WHERE name = ? AND revoked_at IS NULL").get(name) !== undefined) return { error: "conflict" as const };
      const token = await options.tokens.create(`superagent2-inbox-${name}`);
      const id = randomUUID();
      try {
        db.prepare("INSERT INTO inbox_sources (id, name, client_id, token_id) VALUES (?, ?, ?, ?)").run(id, name, token.clientId, token.id);
      } catch (error) {
        await options.tokens.remove(token.id).catch(() => undefined);
        throw error;
      }
      return { id, name, clientId: token.clientId, clientSecret: token.clientSecret };
    },
    revoke: async (id: string) => {
      const raw = db.prepare("SELECT * FROM inbox_sources WHERE id = ? AND revoked_at IS NULL").get(id);
      if (raw === undefined) return undefined;
      const source = Source.parse(raw);
      db.prepare("UPDATE inbox_sources SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(options.clock.now(), id);
      rates.delete(id);
      try {
        if (options.tokens === undefined) return { removed: false };
        await options.tokens.remove(source.token_id);
        return { removed: true };
      } catch {
        return { removed: false };
      }
    },
    receive: (clientId: string, body: InboxMessage, key: string | undefined) => {
      const raw = db.prepare("SELECT * FROM inbox_sources WHERE client_id = ? AND revoked_at IS NULL").get(clientId);
      if (raw === undefined) return { error: "forbidden" as const };
      const source = Source.parse(raw);
      const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      if (key !== undefined) {
        const previous = db.prepare("SELECT body_hash, entry FROM inbox_idempotency WHERE source = ? AND key = ?").get(source.id, key);
        if (previous !== undefined) {
          const found = Previous.parse(previous);
          return found.body_hash === hash ? { entry: found.entry } : { error: "conflict" as const };
        }
      }
      const now = options.clock.now();
      const recent = (rates.get(source.id) ?? []).filter((at) => at > now - 60000);
      if (recent.length >= 60) return { error: "rate_limited" as const };
      const message = [body.title, body.text, body.link].filter((value) => value !== undefined && value !== "").join("\n\n");
      db.exec("BEGIN IMMEDIATE");
      let entry: { topic: string; entry: string };
      try {
        entry = options.conversations.inbox(source.topic, source.name, message);
        db.prepare("UPDATE inbox_sources SET topic = ? WHERE id = ?").run(entry.topic, source.id);
        if (key !== undefined) db.prepare("INSERT INTO inbox_idempotency (source, key, body_hash, entry) VALUES (?, ?, ?, ?)").run(source.id, key, hash, entry.entry);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      rates.set(source.id, [...recent, now]);
      options.push?.inbox(source.name, body.text, entry.topic);
      return { entry: entry.entry };
    },
  };
}
export type Inbox = ReturnType<typeof createInbox>;
