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
];
