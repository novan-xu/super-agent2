import { randomUUID } from "node:crypto";
import type { Conversation, HubToBrain, TopicMove } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";

export const defaultTopicArchiveMilliseconds = 86_400_000;

export type TopicEdit<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: "not_found" | "conflict" };
export type HandoverDestination = string | { readonly title: string };

const missing = { ok: false, error: "not_found" } as const;
const conflict = { ok: false, error: "conflict" } as const;
const success = <T>(value: T): TopicEdit<T> => ({ ok: true, value });

const Id = z.object({ id: z.string() });
const HandoverInput = Id.extend({ handed_over: z.number() });
const Transfer = z.object({ entry: z.string(), source: z.string(), input: z.string(), reset_session: z.number() });
const Merge = z.object({ id: z.string(), source: z.string(), destination: z.string() });
const Alias = Merge.omit({ id: true });
const Movable = z.object({
  id: z.string(), conversation_id: z.string(), turn_id: z.string().nullable(), delivery_id: z.string().nullable(),
});

interface TopicCorrectionsOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly archiveMilliseconds: number;
  readonly ready: () => boolean;
  readonly send: (message: HubToBrain) => boolean;
  readonly topic: (id: string) => Conversation | undefined;
  readonly isRouted: (entry: string) => boolean;
  readonly createMoveDestination: (entry: string, at: number, title?: string) => string;
  readonly announce: (id: string) => void;
  readonly historyChanged: (topics: string[]) => void;
  readonly ticketsChanged: (ids: number[]) => void;
  readonly deliverTopic: (id: string) => void;
  readonly saveSummary: (id: string) => void;
}

export function createTopicCorrections(options: TopicCorrectionsOptions) {
  const { connection } = options.database;
  const { clock } = options;
  const canonical = connection.prepare(`
    WITH RECURSIVE chain(id, target) AS (
      SELECT id, merged_into FROM conversations WHERE id = ?
      UNION ALL SELECT c.id, c.merged_into FROM conversations c JOIN chain ON c.id = chain.target
    ) SELECT id FROM chain WHERE target IS NULL
  `);
  const listAliases = connection.prepare("SELECT id AS source, merged_into AS destination FROM conversations WHERE merged_into IS NOT NULL");
  const selectOwner = connection.prepare("SELECT id, conversation_id, turn_id, delivery_id FROM conversation_entries WHERE id = ? AND kind = 'owner'");
  const selectInput = connection.prepare(`
    SELECT e.id, e.handed_over FROM conversation_entries e JOIN turns t ON t.id = e.turn_id
    WHERE t.id = ? AND t.conversation_id = ? AND t.state = 'running' AND t.ticket_writes_revoked = 0
      AND e.conversation_id = t.conversation_id AND e.kind = 'owner' AND e.taken = 1 AND (? IS NULL OR e.id = ?)
    ORDER BY e.seq DESC LIMIT 1
  `);
  const running = connection.prepare("SELECT 1 FROM turns WHERE conversation_id = ? AND state = 'running' LIMIT 1");
  const queued = connection.prepare("SELECT 1 FROM conversation_entries WHERE conversation_id = ? AND taken = 0 LIMIT 1");
  const renameTopic = connection.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?");
  const archiveTopic = connection.prepare("UPDATE conversations SET topic_state = 'archived', updated_at = ? WHERE id = ? AND topic_state = 'active'");
  const archiveCandidates = connection.prepare(`
    SELECT c.id FROM conversations c
    WHERE c.topic_state = 'active' AND c.system = 0 AND c.merged_into IS NULL AND max(c.activity_at, c.created_at) <= ?
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id AND t.state = 'running')
      AND NOT EXISTS (SELECT 1 FROM conversation_entries e WHERE e.conversation_id = c.id AND e.taken = 0)
      AND NOT EXISTS (SELECT 1 FROM topic_merges m WHERE m.source = c.id OR m.destination = c.id)
  `);
  const saveTransfer = connection.prepare("INSERT INTO topic_transfers (entry, source, input, reset_session) VALUES (?, ?, ?, ?) ON CONFLICT(entry) DO NOTHING");
  const blockedByTransfer = connection.prepare(`
    SELECT 1 FROM conversation_entries e JOIN topic_transfers t ON t.entry = e.id
    WHERE e.conversation_id = ? AND e.seq <= ? LIMIT 1
  `);
  const entryTopic = connection.prepare("SELECT conversation_id FROM conversation_entries WHERE id = ?");
  const clearSummary = connection.prepare("UPDATE turns SET topic_summary = NULL WHERE id = ? AND state <> 'running'");
  const transferOf = connection.prepare("SELECT * FROM topic_transfers WHERE entry = ?");
  const listTransfers = connection.prepare("SELECT * FROM topic_transfers ORDER BY rowid");
  const findTransfer = connection.prepare("SELECT entry FROM topic_transfers WHERE source = ? AND input = ?");
  const releaseTransfer = connection.prepare("DELETE FROM topic_transfers WHERE source = ? AND input = ? RETURNING *");
  const markSessionReset = connection.prepare("UPDATE topic_transfers SET reset_session = 1 WHERE source = ? AND input = ?");
  const forgetSessions = connection.prepare("DELETE FROM program_sessions WHERE conversation_id = ?");
  const incrementRevision = connection.prepare("UPDATE topic_history_revision SET revision = revision + 1");
  const selectRevision = connection.prepare("SELECT revision FROM topic_history_revision");
  const revoke = connection.prepare("UPDATE turns SET ticket_writes_revoked = 1 WHERE id = ? AND conversation_id = ? AND state = 'running'");
  const moveEntry = connection.prepare(`
    UPDATE conversation_entries SET conversation_id = ?,
      seq = (SELECT coalesce(max(seq), 0) + 1 FROM conversation_entries WHERE conversation_id = ?),
      turn_id = NULL, taken = 0, delivery_id = ?, handed_over = max(handed_over, ?), prompt = coalesce(prompt, json_extract(body, '$.text'), ''),
      body = json_remove(body, '$.possibleMatch') WHERE id = ?
  `);
  const correctRouting = connection.prepare("UPDATE routing_decisions SET moved_to = ?, moved_at = ?, brain_overridden = (brain_moved_at IS NOT NULL) WHERE entry = ?");
  const correctBrainRouting = connection.prepare("UPDATE routing_decisions SET brain_moved_to = ?, brain_moved_at = ? WHERE entry = ?");
  const activate = connection.prepare("UPDATE conversations SET topic_state = 'active', activity_at = max(activity_at, ?), updated_at = ? WHERE id = ?");
  const saveMerge = connection.prepare("INSERT INTO topic_merges (id, source, destination) VALUES (?, ?, ?)");
  const selectMerge = connection.prepare("SELECT * FROM topic_merges WHERE id = ?");
  const mergeOf = connection.prepare("SELECT * FROM topic_merges WHERE source = ? OR destination = ?");
  const listMerges = connection.prepare("SELECT * FROM topic_merges ORDER BY rowid");
  const deleteMerge = connection.prepare("DELETE FROM topic_merges WHERE id = ?");
  const beginSequences = connection.prepare("UPDATE conversation_entries SET seq = -stream_seq WHERE conversation_id IN (?, ?)");
  const mergeEntries = connection.prepare(`
    WITH combined AS MATERIALIZED (
      SELECT id, row_number() OVER (ORDER BY stream_seq) AS new_seq
      FROM conversation_entries WHERE conversation_id IN (?, ?)
    )
    UPDATE conversation_entries AS e SET conversation_id = ?, seq = combined.new_seq FROM combined WHERE e.id = combined.id
  `);
  const mergeTurns = connection.prepare("UPDATE turns SET conversation_id = ? WHERE conversation_id = ?");
  const mergeTickets = connection.prepare("UPDATE tickets SET conversation_id = ? WHERE conversation_id = ? RETURNING id");
  const mergeCommands = connection.prepare("UPDATE brain_commands SET conversation_id = ? WHERE conversation_id = ?");
  const discardVersions = connection.prepare("DELETE FROM topic_ticket_versions WHERE conversation_id IN (?, ?)");
  const mergeSource = connection.prepare("UPDATE conversations SET merged_into = ?, topic_state = 'archived', updated_at = ? WHERE id = ?");
  const mergeDestination = connection.prepare(`
    UPDATE conversations AS c SET updated_at = ?,
      activity_at = max(activity_at, (SELECT activity_at FROM conversations WHERE id = ?)),
      topic_state = CASE WHEN EXISTS (SELECT 1 FROM conversation_entries WHERE conversation_id = c.id AND taken = 0)
        THEN 'active' ELSE topic_state END
    WHERE c.id = ?
  `);
  const acknowledgements = new Map<string, Set<string>>();

  function transaction<T>(apply: () => T): T {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = apply();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }

  const resolve = (id: string): string | undefined => Id.safeParse(canonical.get(id)).data?.id;
  const pending = (topic: string) => mergeOf.get(topic, topic) !== undefined;
  const withdraw = ({ source, input }: z.infer<typeof Transfer>) => options.send({ type: "input.withdraw", conversation: source, input });
  const gates = () => {
    const pending = listMerges.all().map((row) => {
      const { id, ...pair } = Merge.parse(row);
      return { merge: id, ...pair };
    });
    const merged = listAliases.all().map((row) => Alias.parse(row));
    if (pending.length > 0 || merged.length > 0) {
      options.send({ type: "topic.gates", pending, merged });
    }
  };

  const finishMerge = ({ id, source, destination }: z.infer<typeof Merge>) => {
    const now = clock.now();
    const ticketIds = transaction(() => {
      beginSequences.run(source, destination);
      mergeEntries.run(source, destination, destination);
      mergeTurns.run(destination, source);
      mergeCommands.run(destination, source);
      const ids = mergeTickets.all(destination, source).map((row) => z.number().parse(row["id"]));
      discardVersions.run(source, destination);
      mergeSource.run(destination, now, source);
      mergeDestination.run(now, source, destination);
      deleteMerge.run(id);
      incrementRevision.run();
      return ids;
    });
    acknowledgements.delete(id);
    gates();
    options.announce(source);
    options.announce(destination);
    options.ticketsChanged(ticketIds);
    options.historyChanged([source, destination]);
    options.deliverTopic(destination);
  };

  const finishOfflineMerges = () => {
    if (options.ready()) {
      return;
    }
    for (const row of listMerges.all()) {
      const merge = Merge.parse(row);
      if ([merge.source, merge.destination].every((id) => running.get(id) === undefined && queued.get(id) === undefined)) {
        finishMerge(merge);
      }
    }
  };

  const move = (
    id: string, destinationId: TopicMove["destination"],
    { expectedSource, title, byBrain = false }: { expectedSource?: string | undefined; title?: string; byBrain?: boolean } = {},
  ): TopicEdit<string> => {
    const row = selectOwner.get(id);
    const destination = destinationId === null ? null : resolve(destinationId);
    if (row === undefined || destination === undefined) {
      return missing;
    }
    const owner = Movable.parse(row);
    const source = owner.conversation_id;
    if (source === destination) {
      return success(destination);
    }
    if (expectedSource !== undefined && resolve(expectedSource) !== source) {
      return conflict;
    }
    const now = clock.now();
    const moved = transaction(() => {
      const target = destination ?? options.createMoveDestination(id, now, title);
      saveTransfer.run(id, source, owner.delivery_id ?? id, Number(owner.turn_id !== null));
      moveEntry.run(target, target, randomUUID(), Number(byBrain), id);
      (byBrain ? correctBrainRouting : correctRouting).run(target, now, id);
      if (owner.turn_id !== null) {
        revoke.run(owner.turn_id, source);
        if (clearSummary.run(owner.turn_id).changes > 0) {
          options.saveSummary(source);
        }
      }
      activate.run(now, now, target);
      incrementRevision.run();
      return { target, transfer: Transfer.parse(transferOf.get(id)) };
    });
    options.announce(moved.target);
    options.historyChanged([source, moved.target]);
    withdraw(moved.transfer);
    options.deliverTopic(source);
    return success(moved.target);
  };

  const archive = (id: string) => {
    const changed = transaction(() => {
      options.saveSummary(id);
      return archiveTopic.run(clock.now(), id).changes > 0;
    });
    if (changed) {
      options.announce(id);
    }
  };
  const archiveIdle = () => archiveCandidates.all(clock.now() - options.archiveMilliseconds).map((row) => Id.parse(row).id).forEach(archive);
  const timer = setInterval(archiveIdle, Math.min(options.archiveMilliseconds, 60_000));
  timer.unref();

  return {
    resolve,
    pending,
    archiveIdle,
    revision: () => z.number().parse(selectRevision.get()?.["revision"]),
    close: () => clearInterval(timer),
    blocked: (conversation: string, seq: number) => pending(conversation) || blockedByTransfer.get(conversation, seq) !== undefined,
    sync: () => {
      acknowledgements.clear();
      gates();
      for (const row of listTransfers.all()) {
        withdraw(Transfer.parse(row));
      }
    },
    finishOfflineMerges,
    move: (id: string, destination: TopicMove["destination"], expectedSource?: string) => move(id, destination, { expectedSource }),
    withdrawing: (source: string, turn: string, input: string) => {
      if (findTransfer.get(source, input) !== undefined) {
        revoke.run(turn, source);
        markSessionReset.run(source, input);
      }
    },
    withdrawn: (source: string, input: string) => {
      const transfer = transaction(() => {
        const row = releaseTransfer.get(source, input);
        if (row === undefined) {
          return undefined;
        }
        const found = Transfer.parse(row);
        if (found.reset_session === 1) {
          forgetSessions.run(found.source);
        }
        return found;
      });
      if (transfer !== undefined) {
        const target = entryTopic.get(transfer.entry);
        if (target !== undefined) {
          options.deliverTopic(z.string().parse(target["conversation_id"]));
        }
      }
    },
    handover: (source: string, turn: string, destination: HandoverDestination, message?: string, ownerRequested = false): TopicEdit<string> => {
      if (typeof destination === "string" && resolve(destination) === source) {
        return conflict;
      }
      const input = selectInput.get(turn, source, message ?? null, message ?? null);
      if (input === undefined) {
        return conflict;
      }
      const { id, handed_over } = HandoverInput.parse(input);
      if (handed_over === 1 || (!ownerRequested && !options.isRouted(id))) {
        return conflict;
      }
      const moved = typeof destination === "string" ? move(id, destination, { byBrain: true })
        : move(id, null, { byBrain: true, title: destination.title });
      return moved.ok ? success(id) : moved;
    },
    rename: (id: string, title: string): TopicEdit<string> => {
      const topic = resolve(id);
      if (topic === undefined) {
        return missing;
      }
      renameTopic.run(title, clock.now(), topic);
      options.announce(topic);
      return success(topic);
    },
    archive: (id: string): TopicEdit<string> => {
      const topic = resolve(id);
      if (topic === undefined) {
        return missing;
      }
      archive(topic);
      return success(topic);
    },
    merge: (sourceId: string, destinationId: string): TopicEdit<string> => {
      const source = resolve(sourceId);
      const destination = resolve(destinationId);
      if (source === undefined || destination === undefined) {
        return missing;
      }
      if (source === destination) {
        return sourceId === source ? conflict : success(destination);
      }
      if (options.topic(source)?.system === true || pending(source) || pending(destination)) {
        return conflict;
      }
      saveMerge.run(randomUUID(), source, destination);
      options.announce(source);
      options.announce(destination);
      gates();
      finishOfflineMerges();
      return success(destination);
    },
    paused: (id: string, topic: string) => {
      const row = selectMerge.get(id);
      if (row === undefined) {
        return;
      }
      const merge = Merge.parse(row);
      if ((topic !== merge.source && topic !== merge.destination) || running.get(topic) !== undefined) {
        return;
      }
      const ready = acknowledgements.get(id) ?? new Set<string>();
      ready.add(topic);
      acknowledgements.set(id, ready);
      if (ready.has(merge.source) && ready.has(merge.destination)) {
        finishMerge(merge);
      }
    },
  };
}
