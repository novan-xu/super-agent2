import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Clock } from "./clock.js";
import { type Migration, migrations as hubMigrations } from "./migrations.js";
import { defaultTicketTimeZone } from "./ticket-codes.js";

export const databaseFileName = "hub.sqlite";

const VersionRow = z.object({ version: z.number().int() });

const HubRow = z.object({ instance: z.string(), created_at: z.number().int() });

export interface HubDatabase {
  readonly connection: DatabaseSync;
  readonly dataDir: string;
  readonly instance: string;
  readonly createdAt: number;
  readonly ticketTimeZone: string;
  appliedVersions(): number[];
  healthy(): boolean;
  close(): void;
}

export interface OpenDatabaseOptions {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly migrations?: readonly Migration[];
  readonly ticketTimeZone?: string;
}

export function applyMigrations(connection: DatabaseSync, migrations: readonly Migration[], clock: Clock, timeZone = defaultTicketTimeZone): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
  const known = new Set(migrations.map((migration) => migration.version));
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  ordered.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migrations must be numbered 1, 2, 3 and so on; found ${migration.version} at position ${index + 1}`);
    }
  });
  const applied = connection
    .prepare("SELECT version FROM migrations ORDER BY version")
    .all()
    .map((row) => VersionRow.parse(row).version);
  const unknown = applied.filter((version) => !known.has(version));
  if (unknown.length > 0) {
    throw new Error(`The database has migrations this hub does not know: ${unknown.join(", ")}`);
  }
  const done = new Set(applied);
  const record = connection.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)");
  for (const migration of ordered) {
    if (done.has(migration.version)) {
      continue;
    }
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(migration.sql);
      migration.backfill?.(connection, timeZone);
      record.run(migration.version, clock.now());
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openDatabase(options: OpenDatabaseOptions): HubDatabase {
  mkdirSync(options.dataDir, { recursive: true });
  const connection = new DatabaseSync(join(options.dataDir, databaseFileName));
  const ticketTimeZone = options.ticketTimeZone ?? defaultTicketTimeZone;
  try {
    connection.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    applyMigrations(connection, options.migrations ?? hubMigrations, options.clock, ticketTimeZone);
    connection
      .prepare("INSERT INTO hub (id, instance, created_at) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING")
      .run(randomUUID(), options.clock.now());
    const row = HubRow.parse(connection.prepare("SELECT instance, created_at FROM hub WHERE id = 1").get());
    return {
      connection,
      dataDir: options.dataDir,
      instance: row.instance,
      createdAt: row.created_at,
      ticketTimeZone,
      appliedVersions: () =>
        connection
          .prepare("SELECT version FROM migrations ORDER BY version")
          .all()
          .map((entry) => VersionRow.parse(entry).version),
      healthy: () => {
        try {
          connection.prepare("SELECT 1").get();
          return true;
        } catch {
          return false;
        }
      },
      close: () => connection.close(),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
