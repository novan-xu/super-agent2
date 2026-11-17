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
];
