import { randomUUID } from "node:crypto";
import { text } from "@super-agent2/catalog";
import { Revision } from "@super-agent2/protocol";
import { z } from "zod";
import type { ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import { sharedUpdateRepository, type PeerQueue } from "./peer-exchange.js";
import { short, type TaskTickets } from "./task-tickets.js";

export interface PeerUpdates {
  merged(repository: string, commit: string): void;
  receive(commit: string): () => void;
  resume(): void;
  close(): void;
}

export function createPeerUpdates(options: {
  readonly database: HubDatabase;
  readonly queue: PeerQueue;
  readonly tasks: TaskTickets;
  readonly conversations: ConversationService;
  readonly running: string;
  readonly local: boolean;
}): PeerUpdates {
  const db = options.database.connection;
  const insert = db.prepare("INSERT OR IGNORE INTO peer_update_requests (commit_sha) VALUES (?)");
  const pending = db.prepare("SELECT commit_sha FROM peer_update_requests WHERE handled = 0 ORDER BY id");
  const handled = db.prepare("UPDATE peer_update_requests SET handled = 1 WHERE commit_sha = ?");
  const cursor = db.prepare("SELECT commit_sha, ticket_id FROM peer_update_cursor WHERE id = 1");
  const remember = db.prepare(`
    INSERT INTO peer_update_cursor (id, commit_sha, ticket_id) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET commit_sha = excluded.commit_sha, ticket_id = excluded.ticket_id
  `);
  const Waiting = z.object({ commit_sha: Revision });
  const Cursor = z.object({ commit_sha: Revision, ticket_id: z.number().int() }).transform(({ commit_sha, ticket_id }) => ({ commit: commit_sha, ticket: ticket_id }));
  let closed = false;
  let working = false;
  let runAgain = false;
  let retry: NodeJS.Timeout | undefined;

  const drain = async () => {
    for (const row of pending.all()) {
      if (closed) return;
      const { commit_sha: commit } = Waiting.parse(row);
      const previous = Cursor.optional().parse(cursor.get());
      let entry: string | undefined;
      try {
        const outcome = await options.tasks.peerUpdate({
          running: options.running, commit, previous,
          record: (ticket) => {
            remember.run(commit, ticket.id);
            handled.run(commit);
            if (ticket.conversation !== null) {
              entry = randomUUID();
              const source = options.local ? "NAS" : text("notice.peerUpdateLocal");
              options.conversations.writePromptNotice(entry, ticket.conversation, text("notice.peerUpdateReceived", {
                source, ticket: ticket.code.toUpperCase(), commit: short(commit),
              }));
            }
          },
        });
        if (closed) return;
        if (outcome === "ignored") handled.run(commit);
        if (outcome === "applied" && entry !== undefined) options.conversations.publishPromptNotice(entry);
      } catch {
        if (closed) return;
      }
    }
  };
  const pump = () => {
    if (closed) return;
    if (working) { runAgain = true; return; }
    working = true;
    void drain().finally(() => {
      working = false;
      if (runAgain) { runAgain = false; pump(); }
    });
  };
  return {
    merged: (repository, commit) => {
      if (repository.toLowerCase() === sharedUpdateRepository && Revision.safeParse(commit).success) {
        options.queue.enqueue({ kind: "update", repository: sharedUpdateRepository, commit });
      }
    },
    receive: (commit) => {
      insert.run(commit);
      return pump;
    },
    resume: () => {
      retry ??= setInterval(pump, 30_000).unref();
      pump();
    },
    close: () => { closed = true; clearInterval(retry); },
  };
}
