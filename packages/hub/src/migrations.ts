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
];
