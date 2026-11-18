export interface Migration {
  readonly version: number;
  readonly sql: string;
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
];
