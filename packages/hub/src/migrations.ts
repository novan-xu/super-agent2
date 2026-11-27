import { text } from "@super-agent2/catalog";
import type { DatabaseSync } from "node:sqlite";
import { codeAt, ticketCodesExhausted, ticketDate, ticketDateFormatter } from "./ticket-codes.js";

export interface Migration {
  readonly version: number;
  readonly sql: string;
  readonly backfill?: (connection: DatabaseSync, timeZone: string, now: number) => void;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE hub (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        instance TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE commands (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        command TEXT NOT NULL,
        account TEXT NOT NULL,
        cwd TEXT,
        state TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      ) STRICT;
      CREATE INDEX commands_by_creation ON commands (created_at, id);
      CREATE TABLE command_output (
        command_id TEXT NOT NULL REFERENCES commands (id),
        seq INTEGER NOT NULL,
        stream TEXT NOT NULL,
        data TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (command_id, seq)
      ) STRICT;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE holds (
        command_id TEXT PRIMARY KEY REFERENCES commands (id),
        form TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        held_at INTEGER NOT NULL,
        answer TEXT,
        answered_at INTEGER,
        answered_by TEXT
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        provider TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX conversations_by_update ON conversations (updated_at, id);
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      ) STRICT;
      CREATE INDEX turns_by_conversation ON turns (conversation_id, started_at);
      CREATE TABLE conversation_entries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        turn_id TEXT,
        provider TEXT,
        body TEXT NOT NULL,
        prompt TEXT,
        taken INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (conversation_id, seq)
      ) STRICT;
      CREATE INDEX entries_waiting ON conversation_entries (taken, created_at) WHERE taken = 0;
      CREATE TABLE program_sessions (
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        provider TEXT NOT NULL,
        session TEXT,
        through INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, provider)
      ) STRICT;
      CREATE TABLE brain_commands (
        command_id TEXT PRIMARY KEY REFERENCES commands (id),
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        held INTEGER NOT NULL DEFAULT 0,
        reported INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        vapid_key TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE machines (
        name TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        access_client_id TEXT NOT NULL,
        access_token_id TEXT,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_seen_at INTEGER,
        report TEXT
      ) STRICT;
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY,
        repository TEXT,
        kind TEXT NOT NULL,
        title_en TEXT NOT NULL,
        title_zh TEXT NOT NULL,
        summary_en TEXT NOT NULL,
        summary_zh TEXT NOT NULL,
        difficulty TEXT,
        platform TEXT,
        state TEXT NOT NULL,
        machine TEXT,
        engine TEXT,
        model TEXT,
        effort TEXT,
        branch TEXT,
        pull_request INTEGER,
        round INTEGER NOT NULL DEFAULT 0,
        stop_reason_en TEXT,
        stop_reason_zh TEXT,
        conversation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX tickets_by_state ON tickets (state, created_at);
      CREATE TABLE ticket_issues (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        position INTEGER NOT NULL,
        repository TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        title_en TEXT NOT NULL,
        title_zh TEXT NOT NULL,
        summary_en TEXT NOT NULL,
        summary_zh TEXT NOT NULL,
        PRIMARY KEY (ticket_id, position)
      ) STRICT;
      CREATE INDEX ticket_issues_by_issue ON ticket_issues (repository, number);
      CREATE TABLE ticket_waits (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        waits_for INTEGER NOT NULL REFERENCES tickets (id),
        PRIMARY KEY (ticket_id, waits_for)
      ) STRICT;
      CREATE TABLE ticket_moves (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        seq INTEGER NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason_en TEXT,
        reason_zh TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (ticket_id, seq)
      ) STRICT;
      CREATE TABLE issue_filings (
        key TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        number INTEGER,
        url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE tickets ADD COLUMN deployed_at INTEGER;
      ALTER TABLE ticket_waits ADD COLUMN deployment INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ticket_waits ADD COLUMN waived_at INTEGER;
      CREATE INDEX ticket_waits_by_before ON ticket_waits (waits_for);
      CREATE TABLE ticket_begins (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets (id),
        due_at INTEGER NOT NULL,
        done_at INTEGER,
        failed_at INTEGER,
        failure TEXT
      ) STRICT;
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE tickets ADD COLUMN difficulty_reason_en TEXT;
      ALTER TABLE tickets ADD COLUMN difficulty_reason_zh TEXT;
      ALTER TABLE tickets ADD COLUMN brain_engine TEXT;
      ALTER TABLE tickets ADD COLUMN owner_machine TEXT;
      ALTER TABLE tickets ADD COLUMN owner_engine TEXT;
      ALTER TABLE tickets ADD COLUMN owner_model TEXT;
      ALTER TABLE tickets ADD COLUMN owner_effort TEXT;
      ALTER TABLE tickets ADD COLUMN chosen_by TEXT;
      ALTER TABLE tickets ADD COLUMN chosen_at INTEGER;
      ALTER TABLE tickets ADD COLUMN ran TEXT;
      CREATE TABLE hub_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE tickets ADD COLUMN report_en TEXT;
      ALTER TABLE tickets ADD COLUMN report_zh TEXT;
      CREATE TABLE ticket_attempts (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        attempt INTEGER NOT NULL,
        machine TEXT NOT NULL,
        engine TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        state TEXT NOT NULL,
        session TEXT,
        resume_session TEXT,
        note TEXT,
        handover INTEGER NOT NULL DEFAULT 0,
        failure TEXT,
        reason TEXT,
        unreachable_since INTEGER,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        PRIMARY KEY (ticket_id, attempt)
      ) STRICT;
      CREATE INDEX ticket_attempts_by_state ON ticket_attempts (state, machine);
      CREATE TABLE ticket_work_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        attempt INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        event TEXT NOT NULL,
        UNIQUE (ticket_id, attempt, seq)
      ) STRICT;
      CREATE INDEX ticket_work_events_by_ticket ON ticket_work_events (ticket_id, id);
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE ticket_writing (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets (id),
        task TEXT NOT NULL,
        materials TEXT NOT NULL
      ) STRICT;
      CREATE TABLE ticket_files (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (ticket_id, name)
      ) STRICT;
    `,
  },
  {
    version: 12,
    sql: `
      CREATE TABLE ticket_verifications (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets (id),
        entry INTEGER NOT NULL DEFAULT 0,
        head TEXT,
        level TEXT,
        rule TEXT,
        state TEXT NOT NULL,
        waiting TEXT,
        reason TEXT,
        pipeline TEXT,
        workflows TEXT NOT NULL DEFAULT '[]',
        failures TEXT NOT NULL DEFAULT '[]',
        logs TEXT NOT NULL DEFAULT '[]',
        told TEXT,
        skip_reason TEXT,
        skip_at INTEGER,
        conflict_head TEXT,
        merging_head TEXT,
        merging_rule TEXT,
        merge_commit TEXT,
        merged_at INTEGER,
        closed_issues TEXT NOT NULL DEFAULT '[]',
        branch_done INTEGER NOT NULL DEFAULT 0,
        deployment INTEGER,
        reported_at INTEGER,
        checked_at INTEGER
      ) STRICT;
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE tickets ADD COLUMN free_retry INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tickets ADD COLUMN stuck_at INTEGER;
      ALTER TABLE tickets ADD COLUMN stuck_round INTEGER;
      ALTER TABLE tickets ADD COLUMN stuck_from TEXT;
      ALTER TABLE tickets ADD COLUMN stuck_failure TEXT;
      ALTER TABLE tickets ADD COLUMN stuck_detail TEXT;
      ALTER TABLE tickets ADD COLUMN stuck_where_en TEXT;
      ALTER TABLE tickets ADD COLUMN stuck_where_zh TEXT;
      CREATE TABLE ticket_rounds (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        seq INTEGER NOT NULL,
        round INTEGER,
        attempt INTEGER NOT NULL,
        failure TEXT NOT NULL,
        detail TEXT NOT NULL,
        guidance_en TEXT NOT NULL,
        guidance_zh TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (ticket_id, seq)
      ) STRICT;
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE commands ADD COLUMN environment TEXT;
      CREATE TABLE deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        previous TEXT,
        target TEXT NOT NULL,
        file TEXT NOT NULL,
        conversation_id TEXT,
        phase TEXT NOT NULL,
        result TEXT,
        reason TEXT,
        notes TEXT NOT NULL DEFAULT '[]',
        health_from INTEGER,
        deployed_tickets TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        told_at INTEGER
      ) STRICT;
      CREATE INDEX deployments_by_repository ON deployments (repository COLLATE NOCASE, id);
      CREATE TABLE deployment_steps (
        deployment_id INTEGER NOT NULL REFERENCES deployments (id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        command_id TEXT NOT NULL REFERENCES commands (id),
        PRIMARY KEY (deployment_id, seq)
      ) STRICT;
    `,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE tickets ADD COLUMN ended_at INTEGER;
      ALTER TABLE tickets ADD COLUMN joined_into INTEGER;
      UPDATE tickets
        SET ended_at = COALESCE((SELECT MAX(at) FROM ticket_moves WHERE ticket_moves.ticket_id = tickets.id AND ticket_moves.to_state IN ('merged', 'delivered', 'stopped')), updated_at)
        WHERE state IN ('merged', 'delivered', 'stopped');
      UPDATE tickets
        SET joined_into = CAST(substr(stop_reason_en, 15) AS INTEGER)
        WHERE state = 'stopped' AND stop_reason_en GLOB 'Joined ticket [0-9]* by an arrangement' AND CAST(substr(stop_reason_en, 15) AS INTEGER) > 0;
      CREATE INDEX tickets_by_end ON tickets (ended_at, id);
    `,
  },
  {
    version: 16,
    sql: `
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text_en TEXT NOT NULL,
        text_zh TEXT NOT NULL,
        author TEXT NOT NULL,
        stale INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE memory_changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        author TEXT NOT NULL,
        conversation_id TEXT,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
      ALTER TABLE program_sessions ADD COLUMN memory_offered INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE program_sessions ADD COLUMN memory_seen INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE install_codes (
        name TEXT PRIMARY KEY,
        system TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        hub TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER
      ) STRICT;
      CREATE TABLE repository_accounts (
        repository TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 18,
    sql: `
      ALTER TABLE ticket_verifications DROP COLUMN conflict_head;
      ALTER TABLE ticket_verifications ADD COLUMN conflict_returns INTEGER NOT NULL DEFAULT 0;
      UPDATE tickets SET stuck_failure = 'workflow' WHERE stuck_failure = 'conflict';
      UPDATE ticket_rounds SET failure = 'workflow' WHERE failure = 'conflict';
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE ticket_files_kept (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        data BLOB,
        attempt INTEGER,
        part INTEGER,
        PRIMARY KEY (ticket_id, name)
      ) STRICT;
      INSERT INTO ticket_files_kept (ticket_id, name, size, media_type, data) SELECT ticket_id, name, size, media_type, data FROM ticket_files;
      DROP TABLE ticket_files;
      ALTER TABLE ticket_files_kept RENAME TO ticket_files;
    `,
  },
  {
    version: 20,
    sql: `
      ALTER TABLE memories DROP COLUMN text_en;
      ALTER TABLE memories DROP COLUMN stale;
      ALTER TABLE memories RENAME COLUMN text_zh TO text;
      ALTER TABLE memory_changes ADD COLUMN suggestion_id INTEGER;
      UPDATE memory_changes SET action = 'added' WHERE action = 'remembered';
      UPDATE memory_changes SET action = 'edited' WHERE action = 'rewritten';
      CREATE TABLE memory_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        memory_id INTEGER,
        replaces TEXT NOT NULL,
        conversation_id TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      ) STRICT;
      CREATE INDEX memory_suggestions_by_state ON memory_suggestions (state, id);
      UPDATE program_sessions SET memory_seen = 0, memory_offered = 0;
    `,
  },
  {
    version: 21,
    sql: `
      CREATE TABLE ticket_pull_requests (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        seq INTEGER NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        branch TEXT NOT NULL,
        state TEXT NOT NULL,
        closes TEXT NOT NULL DEFAULT '[]',
        merge_commit TEXT,
        deployment INTEGER,
        handed_at INTEGER NOT NULL,
        merged_at INTEGER,
        PRIMARY KEY (ticket_id, seq)
      ) STRICT;
      ALTER TABLE ticket_verifications ADD COLUMN closes TEXT;
      INSERT INTO ticket_pull_requests (ticket_id, seq, number, url, branch, state, closes, merge_commit, deployment, handed_at, merged_at)
        SELECT
          t.id,
          1,
          t.pull_request,
          'https://github.com/' || t.repository || '/pull/' || t.pull_request,
          COALESCE(t.branch, ''),
          CASE WHEN t.state = 'merged' THEN 'merged' ELSE 'open' END,
          CASE WHEN t.state = 'merged' THEN COALESCE((SELECT json_group_array(number) FROM (SELECT i.number AS number FROM ticket_issues i WHERE i.ticket_id = t.id ORDER BY i.position)), '[]') ELSE '[]' END,
          v.merge_commit,
          v.deployment,
          COALESCE((SELECT MIN(m.at) FROM ticket_moves m WHERE m.ticket_id = t.id AND m.to_state = 'verifying'), t.updated_at),
          CASE WHEN t.state = 'merged' THEN COALESCE(v.merged_at, t.ended_at, t.updated_at) ELSE NULL END
        FROM tickets t
        LEFT JOIN ticket_verifications v ON v.ticket_id = t.id
        WHERE t.pull_request IS NOT NULL AND t.repository IS NOT NULL;
      UPDATE ticket_verifications
        SET closes = (SELECT p.closes FROM ticket_pull_requests p WHERE p.ticket_id = ticket_verifications.ticket_id AND p.seq = 1)
        WHERE EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_verifications.ticket_id AND t.state = 'merged');
    `,
  },
  {
    version: 22,
    sql: `
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE ticket_attachments (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        attachment_id TEXT NOT NULL REFERENCES attachments (id),
        PRIMARY KEY (ticket_id, attachment_id)
      ) STRICT;
      CREATE TABLE worker_messages (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        attempt INTEGER NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      ) STRICT;
      CREATE INDEX worker_messages_waiting ON worker_messages (ticket_id, attempt) WHERE delivered_at IS NULL;
    `,
  },
  {
    version: 23,
    sql: `
      CREATE TABLE pipeline_durations (
        repository TEXT NOT NULL,
        number INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        PRIMARY KEY (repository, number)
      ) STRICT;
      CREATE INDEX pipeline_durations_recent ON pipeline_durations (repository, finished_at);
      ALTER TABLE ticket_verifications ADD COLUMN head_at INTEGER;
      ALTER TABLE ticket_verifications ADD COLUMN wait_since INTEGER;
      ALTER TABLE ticket_verifications ADD COLUMN notice_key TEXT;
      ALTER TABLE ticket_verifications ADD COLUMN notice_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 24,
    sql: `
      ALTER TABLE tickets ADD COLUMN form TEXT NOT NULL DEFAULT 'code';
      UPDATE tickets SET form = 'task' WHERE kind = 'writing';
      ALTER TABLE tickets ADD COLUMN required_machine TEXT;
      ALTER TABLE ticket_writing RENAME TO ticket_tasks;
      ALTER TABLE ticket_tasks ADD COLUMN commit_ref TEXT;
      ALTER TABLE ticket_tasks ADD COLUMN commit_sha TEXT;
      ALTER TABLE ticket_tasks ADD COLUMN deploys INTEGER NOT NULL DEFAULT 0;
      UPDATE holds SET answer = 'withdrawn', answered_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        WHERE answer IS NULL AND command_id IN (SELECT id FROM commands WHERE state = 'held' AND environment IS NOT NULL AND environment NOT IN ('', '{}'));
      UPDATE commands SET state = 'dropped', reason = '${sqlText(text("command.reason.deploymentRetired"))}', ended_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        WHERE state = 'held' AND environment IS NOT NULL AND environment NOT IN ('', '{}');
      ALTER TABLE commands DROP COLUMN environment;
      DROP TABLE deployment_steps;
      DROP TABLE deployments;
    `,
  },
  {
    version: 25,
    sql: `
      CREATE TABLE ticket_decisions (
        id INTEGER PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        source TEXT NOT NULL,
        attempt INTEGER,
        pull_request INTEGER,
        chosen_en TEXT NOT NULL,
        chosen_zh TEXT NOT NULL,
        why_en TEXT NOT NULL,
        why_zh TEXT NOT NULL,
        options_en TEXT NOT NULL,
        options_zh TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        verdict TEXT,
        opinion TEXT,
        reviewed_at INTEGER,
        sent_at INTEGER
      ) STRICT;
      CREATE INDEX ticket_decisions_by_ticket ON ticket_decisions (ticket_id, id);
      CREATE INDEX ticket_decisions_unsettled ON ticket_decisions (ticket_id) WHERE verdict IS NULL;
    `,
  },
  {
    version: 26,
    sql: `
      CREATE TABLE provider_marks (
        program TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        since INTEGER NOT NULL,
        until INTEGER
      ) STRICT;
      CREATE TABLE ticket_switches (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        from_engine TEXT NOT NULL,
        to_engine TEXT,
        machine TEXT,
        model TEXT,
        effort TEXT,
        reason TEXT NOT NULL,
        until INTEGER,
        owner INTEGER NOT NULL,
        attempt INTEGER,
        PRIMARY KEY (ticket_id, seq)
      ) STRICT;
      ALTER TABLE ticket_attempts ADD COLUMN takeover INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 27,
    sql: `
      CREATE TABLE ticket_repairs (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets (id),
        repairs INTEGER NOT NULL UNIQUE REFERENCES tickets (id),
        opened_by TEXT NOT NULL,
        words TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        round INTEGER,
        failure TEXT,
        detail TEXT,
        where_en TEXT,
        where_zh TEXT,
        saved INTEGER,
        saved_detail TEXT
      ) STRICT;
    `,
  },
  {
    version: 28,
    sql: `
      DROP TABLE install_codes;
      ALTER TABLE machines ADD COLUMN access_expires_at INTEGER;
      ALTER TABLE machines ADD COLUMN access_warned_at INTEGER;
      ALTER TABLE machines ADD COLUMN system TEXT;
      ALTER TABLE machines ADD COLUMN hub TEXT;
      UPDATE machines SET access_expires_at = created_at + 31536000000 WHERE access_token_id IS NOT NULL;
    `,
  },
  {
    version: 29,
    sql: `
      ALTER TABLE conversations ADD COLUMN topic_state TEXT NOT NULL DEFAULT 'active' CHECK (topic_state IN ('active', 'archived'));
      ALTER TABLE conversations ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
      ALTER TABLE conversations ADD COLUMN repository TEXT CHECK (repository IS NULL OR system = 0);
      CREATE UNIQUE INDEX conversations_system ON conversations (system) WHERE system = 1;
      CREATE INDEX tickets_by_conversation ON tickets (conversation_id);
      WITH topic_repos AS (
        SELECT conversation_id, min(repository) AS repository FROM tickets WHERE conversation_id IS NOT NULL
        GROUP BY conversation_id
        HAVING count(*) = count(repository) AND count(DISTINCT lower(repository)) = 1
      )
      UPDATE conversations SET repository = topic_repos.repository FROM topic_repos WHERE conversations.id = topic_repos.conversation_id;
      ALTER TABLE conversation_entries ADD COLUMN stream_seq INTEGER NOT NULL DEFAULT 0;
      WITH arrivals AS (
        SELECT id, row_number() OVER (ORDER BY rowid) AS position FROM conversation_entries
      )
      UPDATE conversation_entries SET stream_seq = arrivals.position FROM arrivals WHERE conversation_entries.id = arrivals.id;
      CREATE UNIQUE INDEX entries_by_stream ON conversation_entries (stream_seq);
      CREATE INDEX entries_by_topic_stream ON conversation_entries (conversation_id, stream_seq);
    `,
  },
  {
    version: 30,
    sql: `
      ALTER TABLE tickets ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE turns ADD COLUMN ticket_writes_revoked INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE ticket_locks (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets (id),
        turn_id TEXT NOT NULL REFERENCES turns (id)
      ) STRICT;
      CREATE INDEX ticket_locks_by_turn ON ticket_locks (turn_id);
      CREATE TABLE topic_ticket_versions (
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        ticket_id INTEGER NOT NULL REFERENCES tickets (id),
        version INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, ticket_id)
      ) STRICT;
      CREATE TRIGGER release_ticket_locks AFTER UPDATE OF state ON turns
      WHEN NEW.state <> 'running' BEGIN
        DELETE FROM ticket_locks WHERE turn_id = NEW.id;
      END;
      CREATE TRIGGER version_ticket AFTER UPDATE ON tickets
      WHEN NEW.version = OLD.version BEGIN
        UPDATE tickets SET version = version + 1 WHERE id = NEW.id;
      END;
      ${[
        "ticket_issues", "ticket_waits", "ticket_moves", "ticket_begins", "ticket_attempts",
        "ticket_work_events", "ticket_tasks", "ticket_files", "ticket_verifications",
        "ticket_rounds", "ticket_pull_requests", "ticket_attachments", "worker_messages", "ticket_decisions",
        "ticket_switches", "ticket_repairs",
      ].map(ticketVersionTriggers).join("\n")}
    `,
  },
  {
    version: 31,
    sql: `
      ALTER TABLE conversations ADD COLUMN board_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversations ADD COLUMN board_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN merged_into TEXT REFERENCES conversations (id);
      ALTER TABLE turns ADD COLUMN topic_summary TEXT;
      ALTER TABLE conversation_entries ADD COLUMN quote_id TEXT REFERENCES conversation_entries (id);
      ALTER TABLE program_sessions ADD COLUMN board_seen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE program_sessions ADD COLUMN board_offered INTEGER NOT NULL DEFAULT 0;
      UPDATE conversations SET board_revision = rowid;
      CREATE INDEX conversations_by_board_revision ON conversations (board_revision);
      CREATE INDEX entries_by_turn_seq ON conversation_entries (turn_id, seq);
      CREATE TRIGGER topic_board_insert AFTER INSERT ON conversations BEGIN
        UPDATE conversations SET board_revision = (SELECT coalesce(max(board_revision), 0) + 1 FROM conversations)
          WHERE id = NEW.id;
      END;
      CREATE TRIGGER topic_board_update
      AFTER UPDATE OF title, repository, topic_state, board_status, merged_into ON conversations
      WHEN OLD.title IS NOT NEW.title OR OLD.repository IS NOT NEW.repository OR OLD.topic_state IS NOT NEW.topic_state
        OR OLD.board_status IS NOT NEW.board_status OR OLD.merged_into IS NOT NEW.merged_into BEGIN
        UPDATE conversations SET board_revision = (SELECT max(board_revision) + 1 FROM conversations)
          WHERE id = NEW.id;
      END;
      CREATE TRIGGER topic_merge_sessions AFTER UPDATE OF merged_into ON conversations
      WHEN OLD.merged_into IS NOT NEW.merged_into AND NEW.merged_into IS NOT NULL BEGIN
        DELETE FROM program_sessions WHERE conversation_id IN (NEW.id, NEW.merged_into);
      END;
    `,
  },
  {
    version: 32,
    sql: `
      ALTER TABLE conversations ADD COLUMN needs_repository INTEGER NOT NULL DEFAULT 0
        CHECK (needs_repository IN (0, 1) AND (needs_repository = 0 OR (repository IS NULL AND system = 0)));
      CREATE TABLE pending_topic_inputs (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 33,
    sql: `
      ALTER TABLE conversation_entries ADD COLUMN delivery_id TEXT;
      CREATE UNIQUE INDEX entry_delivery ON conversation_entries (coalesce(delivery_id, id));
      CREATE TABLE topic_transfers (
        entry TEXT PRIMARY KEY REFERENCES conversation_entries (id),
        source TEXT NOT NULL REFERENCES conversations (id),
        input TEXT NOT NULL UNIQUE,
        reset_session INTEGER NOT NULL CHECK (reset_session IN (0, 1))
      ) STRICT;
      CREATE TABLE topic_merges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL UNIQUE REFERENCES conversations (id),
        destination TEXT NOT NULL UNIQUE REFERENCES conversations (id)
      ) STRICT;
      CREATE TABLE topic_history_revision (revision INTEGER NOT NULL) STRICT;
      INSERT INTO topic_history_revision VALUES (0);
      ALTER TABLE conversations ADD COLUMN activity_at INTEGER NOT NULL DEFAULT 0;
      UPDATE conversations AS c SET activity_at = coalesce(
        (SELECT max(created_at) FROM conversation_entries WHERE conversation_id = c.id AND kind <> 'tool'),
        c.created_at
      );
      CREATE TRIGGER topic_message_activity AFTER INSERT ON conversation_entries WHEN NEW.kind <> 'tool' BEGIN
        UPDATE conversations SET activity_at = max(activity_at, NEW.created_at) WHERE id = NEW.conversation_id;
      END;
    `,
  },
  {
    version: 34,
    sql: `
      CREATE TABLE transfer_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE transfer_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, device TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE transfer_entry_files (entry INTEGER NOT NULL REFERENCES transfer_entries(seq) ON DELETE CASCADE, file TEXT NOT NULL UNIQUE REFERENCES transfer_files(id), PRIMARY KEY(entry, file)) STRICT;
    `,
  },
  {
    version: 35,
    sql: `ALTER TABLE machines ADD COLUMN storage TEXT;`,
  },
  {
    version: 36,
    sql: `
      CREATE TABLE routing_decisions (
        entry TEXT PRIMARY KEY,
        decided_at INTEGER NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('daily', 'code', 'repository')),
        candidates INTEGER NOT NULL,
        configuration TEXT NOT NULL CHECK (configuration IN ('model', 'bigram')),
        fallback_reason TEXT,
        rule TEXT NOT NULL CHECK (rule IN ('a', 'e', 'b', 'c', 'd')),
        topic TEXT,
        placed_in TEXT NOT NULL,
        best_topic TEXT,
        best_score REAL,
        runner_up_score REAL,
        shadow_configuration TEXT CHECK (shadow_configuration IN ('model', 'bigram')),
        shadow_rule TEXT CHECK (shadow_rule IN ('a', 'e', 'b', 'c', 'd')),
        shadow_topic TEXT,
        shadow_best_topic TEXT,
        shadow_best_score REAL,
        shadow_runner_up_score REAL,
        moved_to TEXT,
        moved_at INTEGER
      ) STRICT;
      CREATE INDEX routing_decisions_by_time ON routing_decisions (decided_at);
    `,
  },
  {
    version: 37,
    sql: `ALTER TABLE routing_decisions ADD COLUMN owner_changed INTEGER NOT NULL DEFAULT 0 CHECK (owner_changed IN (0, 1));`,
  },
  {
    version: 38,
    sql: `
      ALTER TABLE routing_decisions ADD COLUMN owner_placed INTEGER CHECK (owner_placed IN (0, 1));
      ALTER TABLE routing_decisions ADD COLUMN brain_moved_to TEXT;
      ALTER TABLE routing_decisions ADD COLUMN brain_moved_at INTEGER;
      ALTER TABLE routing_decisions ADD COLUMN brain_overridden INTEGER NOT NULL DEFAULT 0 CHECK (brain_overridden IN (0, 1));
      ALTER TABLE conversation_entries ADD COLUMN handed_over INTEGER NOT NULL DEFAULT 0 CHECK (handed_over IN (0, 1));
      UPDATE routing_decisions SET owner_placed = 1 WHERE owner_changed = 1;
    `,
  },
  {
    version: 39,
    sql: `
      ALTER TABLE conversations ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'owner'
        CHECK (title_origin IN ('automatic', 'brain', 'owner'));
      UPDATE conversations SET title_origin = 'automatic' WHERE title = '' AND system = 0;
      ALTER TABLE turns ADD COLUMN proposed_title TEXT;
    `,
  },
  {
    version: 40,
    sql: `
      CREATE TABLE repositories (
        repository TEXT PRIMARY KEY COLLATE NOCASE,
        account TEXT CHECK (account IN ('novan-xu', 'nuofan-island')),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1)),
        github_archived INTEGER NOT NULL DEFAULT 0 CHECK (github_archived IN (0, 1))
      ) STRICT;
      INSERT INTO repositories (repository, pinned)
        SELECT min(repository), 1 FROM tickets WHERE repository IS NOT NULL GROUP BY lower(repository);
    `,
  },
  { version: 41, sql: `ALTER TABLE repositories ADD COLUMN alias TEXT;` },
  { version: 42, sql: `ALTER TABLE tickets ADD COLUMN closed_outside TEXT NOT NULL DEFAULT '[]';` },
  {
    version: 43,
    sql: `
      ALTER TABLE tickets ADD COLUMN code TEXT CHECK (code GLOB '[a-z][a-z]');
      ALTER TABLE tickets ADD COLUMN code_date TEXT CHECK (code_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
      CREATE UNIQUE INDEX ticket_codes_by_date ON tickets (code_date, code);
      CREATE INDEX ticket_codes_by_creation ON tickets (code, created_at DESC, id DESC);
    `,
    backfill(connection, timeZone) {
      const formatter = ticketDateFormatter(timeZone);
      connection.function("ticket_local_day", { deterministic: true }, (at) => ticketDate(formatter, Number(at)));
      connection.function("ticket_code_at", { deterministic: true }, (position, date) => {
        const code = codeAt(Number(position));
        if (code === undefined) throw new Error(ticketCodesExhausted(String(date)));
        return code;
      });
      connection.exec(`
        WITH dated AS (
          SELECT id, created_at, ticket_local_day(created_at) AS day FROM tickets
        ), ordered AS (
          SELECT id, day, row_number() OVER (PARTITION BY day ORDER BY created_at, id) - 1 AS position FROM dated
        )
        UPDATE tickets SET code = ticket_code_at(ordered.position, ordered.day), code_date = ordered.day
        FROM ordered WHERE tickets.id = ordered.id;
        CREATE TRIGGER ticket_codes_required_insert BEFORE INSERT ON tickets
        WHEN NEW.code IS NULL OR NEW.code_date IS NULL
        BEGIN SELECT RAISE(ABORT, 'Tickets require a code and creation day'); END;
        CREATE TRIGGER ticket_codes_required_update BEFORE UPDATE OF code, code_date ON tickets
        WHEN NEW.code IS NULL OR NEW.code_date IS NULL
        BEGIN SELECT RAISE(ABORT, 'Tickets require a code and creation day'); END;
      `);
    },
  },
  {
    version: 44,
    sql: `
      CREATE TABLE routing_vectors (
        entry TEXT NOT NULL REFERENCES conversation_entries (id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        text_hash BLOB NOT NULL CHECK (length(text_hash) = 32),
        vector BLOB NOT NULL CHECK (length(vector) > 0 AND length(vector) % 4 = 0),
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (entry, model, text_hash)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 45,
    sql: `
      ALTER TABLE tickets ADD COLUMN light TEXT CHECK (light IS NULL OR (
        light IN ('transfer', 'agent_wring') AND form = 'task' AND repository IS NULL AND conversation_id IS NOT NULL
      ));
      ALTER TABLE conversation_entries ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
      CREATE TABLE light_task_proposals (
        id TEXT PRIMARY KEY REFERENCES conversation_entries(id),
        topic TEXT NOT NULL REFERENCES conversations(id),
        request TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ticket INTEGER UNIQUE REFERENCES tickets(id)
      ) STRICT;
      CREATE INDEX light_proposals_by_topic ON light_task_proposals(topic, created_at);
      CREATE TABLE light_task_questions (
        entry TEXT PRIMARY KEY REFERENCES conversation_entries(id),
        ticket INTEGER NOT NULL REFERENCES tickets(id),
        attempt INTEGER NOT NULL,
        answered_by TEXT REFERENCES conversation_entries(id)
      ) STRICT;
      CREATE INDEX light_questions_by_ticket ON light_task_questions(ticket, attempt);
      ALTER TABLE transfer_entries ADD COLUMN title TEXT;
      ALTER TABLE transfer_entries ADD COLUMN ticket INTEGER REFERENCES tickets(id);
      CREATE UNIQUE INDEX transfer_ticket ON transfer_entries(ticket);
    `,
  },
  {
    version: 46,
    sql: `ALTER TABLE tickets ADD COLUMN project TEXT CHECK (project IS NULL OR (form = 'task' AND repository IS NULL));`,
  },
  {
    version: 47,
    sql: `
      CREATE TABLE inbox_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE,
        token_id TEXT NOT NULL,
        topic TEXT REFERENCES conversations(id),
        revoked_at INTEGER
      ) STRICT;
      CREATE UNIQUE INDEX inbox_active_name ON inbox_sources(name) WHERE revoked_at IS NULL;
      CREATE TABLE inbox_idempotency (
        source TEXT NOT NULL REFERENCES inbox_sources(id),
        key TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        entry TEXT NOT NULL REFERENCES conversation_entries(id),
        PRIMARY KEY(source, key)
      ) STRICT;
    `,
  },
  {
    version: 48,
    sql: `
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL REFERENCES conversations(id),
        fields TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'deleted')),
        next_at INTEGER,
        confirmed_at INTEGER NOT NULL,
        confirmed_by TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE INDEX schedules_due ON schedules(next_at) WHERE state = 'active';
      CREATE TABLE schedule_proposals (
        id TEXT PRIMARY KEY REFERENCES conversation_entries(id),
        topic TEXT NOT NULL REFERENCES conversations(id),
        fields TEXT NOT NULL,
        target TEXT REFERENCES schedules(id),
        target_revision INTEGER,
        created_at INTEGER NOT NULL,
        confirmed_schedule TEXT REFERENCES schedules(id)
      ) STRICT;
      CREATE INDEX schedule_proposals_topic ON schedule_proposals(topic, created_at);
      CREATE TABLE schedule_runs (
        id TEXT PRIMARY KEY,
        schedule TEXT NOT NULL REFERENCES schedules(id),
        revision INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        entry TEXT NOT NULL UNIQUE REFERENCES conversation_entries(id),
        result_entry TEXT REFERENCES conversation_entries(id),
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'skipped', 'failed', 'interrupted', 'cancelled'))
      ) STRICT;
      CREATE INDEX schedule_runs_recent ON schedule_runs(schedule, due_at DESC);
      CREATE INDEX schedule_runs_pending ON schedule_runs(state) WHERE state = 'pending';
      ALTER TABLE tickets ADD COLUMN schedule_run TEXT REFERENCES schedule_runs(id);
      CREATE INDEX tickets_schedule_run ON tickets(schedule_run) WHERE schedule_run IS NOT NULL;
    `,
  },
  {
    version: 49,
    sql: `
      ALTER TABLE conversations ADD COLUMN code_system INTEGER NOT NULL DEFAULT 0 CHECK (code_system IN (0, 1) AND (code_system = 0 OR (system = 0 AND needs_repository = 1 AND repository IS NULL)));
      CREATE UNIQUE INDEX conversations_code_system ON conversations(code_system) WHERE code_system = 1;
      ALTER TABLE provider_marks ADD COLUMN category TEXT;
      CREATE TABLE health_incidents (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        since INTEGER NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        description TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 50,
    sql: `
      ALTER TABLE provider_marks RENAME TO provider_marks_previous;
      CREATE TABLE provider_marks (
        program TEXT NOT NULL,
        model TEXT NOT NULL,
        reason TEXT NOT NULL,
        since INTEGER NOT NULL,
        until INTEGER,
        category TEXT,
        PRIMARY KEY (program, model)
      ) STRICT;
      INSERT INTO provider_marks SELECT program, '', reason, since, until, category FROM provider_marks_previous;
      DROP TABLE provider_marks_previous;
      ALTER TABLE ticket_switches ADD COLUMN from_model TEXT;
    `,
  },
  {
    version: 51,
    sql: `
      ALTER TABLE schedule_runs ADD COLUMN continuation_entry TEXT REFERENCES conversation_entries(id);
      CREATE UNIQUE INDEX schedule_runs_continuation ON schedule_runs(continuation_entry) WHERE continuation_entry IS NOT NULL;
    `,
  },
  {
    version: 52,
    sql: `
      CREATE TABLE schedule_triggers (
        schedule TEXT PRIMARY KEY REFERENCES schedules(id),
        due_at INTEGER NOT NULL,
        batch TEXT NOT NULL
      ) STRICT;
      CREATE TABLE work_request_receipts (
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (source, key)
      ) STRICT;
      CREATE INDEX work_request_expiration ON work_request_receipts(received_at);
      CREATE INDEX work_request_rate ON work_request_receipts(source, received_at);
      CREATE INDEX schedules_triggers ON schedules(json_extract(fields, '$.recurrence.trigger')) WHERE state = 'active';
    `,
  },
  {
    version: 53,
    sql: `
      CREATE TABLE brain_usage (
        turn TEXT NOT NULL REFERENCES turns(id), attempt INTEGER NOT NULL, topic TEXT NOT NULL REFERENCES conversations(id),
        provider TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, seed TEXT,
        input INTEGER, cache_read INTEGER, cache_write INTEGER, output INTEGER, reasoning INTEGER, cost_usd REAL,
        PRIMARY KEY (turn, attempt)
      ) STRICT;
      CREATE INDEX brain_usage_at ON brain_usage(at);
    `,
  },
  {
    version: 54,
    sql: `
      ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
      UPDATE conversations SET archived_at = updated_at WHERE topic_state = 'archived';
      CREATE TRIGGER topic_archive_time AFTER UPDATE OF topic_state ON conversations
      WHEN NEW.topic_state <> OLD.topic_state BEGIN
        UPDATE conversations SET archived_at = CASE WHEN NEW.topic_state = 'archived' THEN NEW.updated_at END WHERE id = NEW.id;
      END;
      ALTER TABLE routing_decisions ADD COLUMN repository_cap INTEGER NOT NULL DEFAULT 0 CHECK (repository_cap IN (0, 1));
      ALTER TABLE routing_decisions ADD COLUMN brain_repository_cap INTEGER NOT NULL DEFAULT 0 CHECK (brain_repository_cap IN (0, 1));
    `,
  },
  {
    version: 55,
    sql: `
      ALTER TABLE topic_merges RENAME TO topic_merges_previous;
      CREATE TABLE topic_merges (
        id TEXT NOT NULL,
        source TEXT PRIMARY KEY REFERENCES conversations (id),
        destination TEXT NOT NULL REFERENCES conversations (id),
        operation TEXT NOT NULL DEFAULT 'merge' CHECK (operation IN ('merge', 'undo'))
      ) STRICT;
      INSERT INTO topic_merges (id, source, destination) SELECT id, source, destination FROM topic_merges_previous;
      DROP TABLE topic_merges_previous;
      CREATE INDEX topic_merges_by_id ON topic_merges (id);
      CREATE INDEX topic_merges_by_destination ON topic_merges (destination);
      CREATE TABLE topic_merge_history (
        source TEXT PRIMARY KEY REFERENCES conversations (id),
        destination TEXT NOT NULL REFERENCES conversations (id),
        topic_state TEXT NOT NULL,
        archived_at INTEGER,
        entries TEXT NOT NULL,
        turns TEXT NOT NULL,
        tickets TEXT NOT NULL,
        commands TEXT NOT NULL
      ) STRICT;
      CREATE INDEX topic_merge_history_by_destination ON topic_merge_history (destination);
    `,
  },
  {
    version: 56,
    sql: `
      CREATE TABLE topic_tidy_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_at INTEGER NOT NULL, time TEXT NOT NULL) STRICT;
      CREATE TABLE topic_tidy_merges (source TEXT PRIMARY KEY, destination TEXT NOT NULL) STRICT;
    `,
  },
  {
    version: 57,
    sql: `
      CREATE TABLE ticktick_receipts (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL REFERENCES conversations(id),
        connection TEXT NOT NULL,
        task TEXT NOT NULL,
        project TEXT,
        created_at INTEGER NOT NULL,
        undone_at INTEGER
      ) STRICT;
      CREATE INDEX ticktick_receipts_topic ON ticktick_receipts(topic);
    `,
  },
  {
    version: 58,
    sql: `
      CREATE TABLE mail_cursors (
        mailbox TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        provider TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        floor INTEGER NOT NULL,
        width INTEGER NOT NULL,
        progress_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        failed INTEGER NOT NULL DEFAULT 0,
        timeouts INTEGER NOT NULL DEFAULT 0,
        stalled INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE mail_messages (
        id INTEGER PRIMARY KEY,
        mailbox TEXT NOT NULL REFERENCES mail_cursors(mailbox),
        message TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        sender TEXT,
        subject TEXT,
        snippet TEXT,
        batch TEXT,
        checked INTEGER NOT NULL DEFAULT 0,
        action TEXT,
        urgent INTEGER NOT NULL DEFAULT 0,
        UNIQUE(mailbox, message)
      ) STRICT;
      CREATE INDEX mail_messages_pending ON mail_messages(received_at, id) WHERE checked = 0 AND batch IS NULL;
      CREATE INDEX mail_messages_review ON mail_messages(batch) WHERE batch IS NOT NULL;
      CREATE INDEX mail_messages_action ON mail_messages(received_at, id) WHERE action IS NOT NULL;
      CREATE TABLE mail_review_batch (
        id TEXT PRIMARY KEY REFERENCES conversation_entries(id),
        slot INTEGER UNIQUE NOT NULL DEFAULT 1 CHECK(slot = 1),
        result TEXT,
        provider TEXT
      ) STRICT;
      CREATE TABLE mail_review_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        topic TEXT REFERENCES conversations(id),
        published_at INTEGER,
        retry_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO mail_review_state (id) VALUES (1);
    `,
  },
  {
    version: 59,
    sql: `
      ALTER TABLE mail_review_state ADD COLUMN filter_failures INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mail_review_state ADD COLUMN filter_retry_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mail_review_state ADD COLUMN filter_notified INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 60,
    sql: `
      ALTER TABLE mail_messages ADD COLUMN group_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE mail_messages ADD COLUMN group_start INTEGER;
      ALTER TABLE mail_messages ADD COLUMN group_end INTEGER;
    `,
  },
  {
    version: 61,
    sql: `ALTER TABLE repositories ADD COLUMN pinned_order INTEGER;`,
  },
  {
    version: 62,
    sql: `ALTER TABLE ticket_work_events ADD COLUMN received_at INTEGER;`,
  },
  {
    version: 63,
    sql: `
      CREATE TABLE ticket_follow_ups (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
        original INTEGER NOT NULL REFERENCES tickets(id),
        previous INTEGER NOT NULL REFERENCES tickets(id),
        folder INTEGER NOT NULL REFERENCES tickets(id),
        issue INTEGER NOT NULL,
        comment TEXT NOT NULL,
        url TEXT NOT NULL
      ) STRICT;
      CREATE INDEX ticket_follow_ups_original ON ticket_follow_ups (original, ticket_id);
    `,
  },
  {
    version: 64,
    sql: `
      ALTER TABLE ticket_pull_requests ADD COLUMN screenshots TEXT;
      ALTER TABLE ticket_verifications ADD COLUMN ui_required INTEGER;
      ALTER TABLE ticket_verifications ADD COLUMN ui_base TEXT;
    `,
  },
  {
    version: 65,
    sql: `
      CREATE TABLE inbox_transfers (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL REFERENCES inbox_sources(id),
        key TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        note TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        touched_at INTEGER NOT NULL,
        result TEXT,
        UNIQUE(source, key)
      ) STRICT;
      CREATE INDEX inbox_transfer_rate ON inbox_transfers (source, started_at);
      CREATE INDEX inbox_transfer_pending ON inbox_transfers (touched_at) WHERE result IS NULL;
      CREATE TABLE inbox_transfer_files (
        upload INTEGER NOT NULL REFERENCES inbox_transfers(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        file TEXT NOT NULL UNIQUE REFERENCES transfer_files(id),
        PRIMARY KEY(upload, position)
      ) STRICT;
    `,
  },
  {
    version: 66,
    sql: `
      ALTER TABLE repositories ADD COLUMN pinned_at INTEGER;
      ALTER TABLE repositories ADD COLUMN retained INTEGER NOT NULL DEFAULT 0;
    `,
    backfill: (connection, _timeZone, now) => {
      connection.prepare("UPDATE repositories SET pinned_at = ? WHERE pinned = 1").run(now);
    },
  },
  {
    version: 67,
    sql: `
      ALTER TABLE inbox_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'oauth'));
      INSERT INTO inbox_sources (id, name, client_id, token_id, kind) VALUES ('oauth', 'OAuth MCP', '', '', 'oauth');
    `,
  },
  {
    version: 68,
    sql: `
      ALTER TABLE tickets ADD COLUMN machine_pinned INTEGER NOT NULL DEFAULT 0 CHECK (machine_pinned IN (0, 1));
      ALTER TABLE tickets ADD COLUMN engine_pin TEXT;
      UPDATE tickets SET engine_pin = owner_engine WHERE light IS NOT NULL AND owner_engine IS NOT NULL;
    `,
  },
  {
    version: 69,
    sql: `
      ALTER TABLE schedule_proposals RENAME TO legacy_schedule_proposals;
      CREATE TABLE schedule_proposals (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL REFERENCES conversations(id),
        fields TEXT NOT NULL,
        target TEXT REFERENCES schedules(id),
        target_revision INTEGER,
        created_at INTEGER NOT NULL,
        CHECK ((target IS NULL) = (target_revision IS NULL))
      ) STRICT;
      CREATE UNIQUE INDEX schedule_proposals_target ON schedule_proposals(target) WHERE target IS NOT NULL;
    `,
    backfill: (connection, _timeZone, now) => {
      connection.prepare(`
        WITH latest AS (
          SELECT p.*, e.stream_seq, row_number() OVER (PARTITION BY p.topic ORDER BY e.stream_seq DESC) AS position
          FROM legacy_schedule_proposals p JOIN conversation_entries e ON e.id = p.id AND e.conversation_id = p.topic
        )
        INSERT OR IGNORE INTO schedule_proposals (id, topic, fields, target, target_revision, created_at)
        SELECT id, topic, fields, target, target_revision, created_at FROM latest
        WHERE position = 1 AND confirmed_schedule IS NULL AND created_at > ? ORDER BY stream_seq DESC
      `).run(now - 24 * 60 * 60 * 1000);
      connection.exec("DROP TABLE legacy_schedule_proposals");
    },
  },
  {
    version: 70,
    sql: `CREATE TABLE turn_start_tickets (turn_id TEXT NOT NULL REFERENCES turns(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id), PRIMARY KEY(turn_id, ticket_id)) STRICT;`,
  },
  {
    version: 71,
    sql: `
      CREATE TABLE repository_checks (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        entry INTEGER NOT NULL,
        repository TEXT NOT NULL COLLATE NOCASE,
        head TEXT NOT NULL,
        machine TEXT NOT NULL,
        assigned_at INTEGER NOT NULL,
        result TEXT,
        UNIQUE (ticket_id, entry, head)
      ) STRICT;
      CREATE UNIQUE INDEX active_repository_check ON repository_checks(repository) WHERE result IS NULL;
    `,
  },
  {
    version: 72,
    sql: `ALTER TABLE tickets ADD COLUMN deployment_targets TEXT;`,
  },
  {
    version: 73,
    sql: `
      CREATE TABLE peers (
        name TEXT PRIMARY KEY,
        client_id TEXT NOT NULL UNIQUE,
        access_token_id TEXT NOT NULL,
        token_hash BLOB NOT NULL CHECK (length(token_hash) = 32)
      ) STRICT;
    `,
  },
  {
    version: 74,
    sql: `
      ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'local' CHECK (scope IN ('local', 'general'));
      ALTER TABLE memories ADD COLUMN origin TEXT;
      ALTER TABLE memories ADD COLUMN peer_key TEXT;
      ALTER TABLE memory_suggestions ADD COLUMN scope TEXT NOT NULL DEFAULT 'local' CHECK (scope IN ('local', 'general'));
      ALTER TABLE memory_suggestions ADD COLUMN origin TEXT;
      ALTER TABLE memory_suggestions ADD COLUMN peer_key TEXT;
      CREATE UNIQUE INDEX memory_peer_key ON memories (peer_key) WHERE peer_key IS NOT NULL;
      CREATE INDEX pending_suggestion_peer_key ON memory_suggestions (peer_key) WHERE state = 'pending';
      CREATE TABLE peer_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        item TEXT NOT NULL,
        id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        UNIQUE (target, item)
      ) STRICT;
      CREATE TRIGGER clear_revoked_peer_queue AFTER DELETE ON peers BEGIN
        DELETE FROM peer_outbox WHERE target = OLD.client_id;
      END;
      CREATE TABLE peer_receipts (
        source TEXT NOT NULL,
        id TEXT NOT NULL,
        PRIMARY KEY (source, id)
      ) STRICT;
    `,
  },
  {
    version: 75,
    sql: `
      ALTER TABLE ticket_tasks ADD COLUMN local_build INTEGER NOT NULL DEFAULT 0 CHECK (local_build IN (0, 1));
      ALTER TABLE ticket_tasks ADD COLUMN local_restart TEXT CHECK (local_restart IN ('waiting', 'requested', 'failed'));
    `,
  },
  {
    version: 76,
    sql: `
      CREATE TABLE peer_update_requests (
        id INTEGER PRIMARY KEY,
        commit_sha TEXT NOT NULL UNIQUE,
        handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0, 1))
      ) STRICT;
      CREATE TABLE peer_update_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        commit_sha TEXT NOT NULL,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id)
      ) STRICT;
    `,
  },
  {
    version: 77,
    sql: `
      CREATE TABLE todo_lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        position INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL,
        list TEXT REFERENCES todo_lists(id),
        date TEXT,
        time TEXT CHECK (time IS NULL OR date IS NOT NULL),
        done_at INTEGER,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        topic TEXT REFERENCES conversations(id) ON DELETE SET NULL
      ) STRICT;
      CREATE INDEX todos_open_order ON todos(position, id) WHERE deleted = 0 AND done_at IS NULL;
      CREATE INDEX todos_recently_done ON todos(done_at DESC, id) WHERE deleted = 0 AND done_at IS NOT NULL;
    `,
  },
];

function ticketVersionTriggers(table: string): string {
  const keys = table === "ticket_repairs" ? ["ticket_id", "repairs"] : ["ticket_id"];
  return (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => {
    const rows = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
    const ids = rows.flatMap((row) => keys.map((key) => `${row}.${key}`));
    return `CREATE TRIGGER version_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
      UPDATE tickets SET version = version + 1 WHERE id IN (${ids.join(", ")});
    END;`;
  }).join("\n");
}

function sqlText(value: string): string {
  return value.replaceAll("'", "''");
}
