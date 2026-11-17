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
];
