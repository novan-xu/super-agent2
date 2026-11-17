import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "./database.js";
import { migrations } from "./migrations.js";
import { TestClock } from "./testing/access.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-database-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("creates the file and applies every migration", () => {
    const database = openDatabase({ dataDir: join(dataDir, "nested"), clock: new TestClock() });
    expect(database.appliedVersions()).toEqual(migrations.map((migration) => migration.version));
    expect(database.healthy()).toBe(true);
    database.close();
  });

  it("keeps its state across a restart", () => {
    const clock = new TestClock();
    const first = openDatabase({ dataDir, clock });
    const { instance, createdAt } = first;
    first.close();
    clock.advance(86_400_000);
    const second = openDatabase({ dataDir, clock });
    expect(second.instance).toBe(instance);
    expect(second.createdAt).toBe(createdAt);
    expect(second.appliedVersions()).toEqual(migrations.map((migration) => migration.version));
    second.close();
  });

  it("applies a new migration once, at the next start", () => {
    const clock = new TestClock();
    openDatabase({ dataDir, clock }).close();
    const later = [...migrations, { version: migrations.length + 1, sql: "CREATE TABLE note (body TEXT NOT NULL) STRICT;" }];
    const upgraded = openDatabase({ dataDir, clock, migrations: later });
    upgraded.connection.prepare("INSERT INTO note (body) VALUES (?)").run("kept");
    upgraded.close();
    const again = openDatabase({ dataDir, clock, migrations: later });
    expect(again.appliedVersions()).toEqual(later.map((migration) => migration.version));
    expect(again.connection.prepare("SELECT body FROM note").all()).toEqual([{ body: "kept" }]);
    again.close();
  });

  it("refuses a database written by a newer hub", () => {
    const clock = new TestClock();
    const later = [...migrations, { version: migrations.length + 1, sql: "CREATE TABLE later (x INTEGER) STRICT;" }];
    openDatabase({ dataDir, clock, migrations: later }).close();
    expect(() => openDatabase({ dataDir, clock })).toThrow(/does not know/);
  });
});

describe("applyMigrations", () => {
  it("rolls back a migration that fails and applies nothing after it", () => {
    const connection = new DatabaseSync(":memory:");
    const broken = [
      { version: 1, sql: "CREATE TABLE a (x INTEGER) STRICT;" },
      { version: 2, sql: "CREATE TABLE b (x INTEGER) STRICT; INSERT INTO missing VALUES (1);" },
      { version: 3, sql: "CREATE TABLE c (x INTEGER) STRICT;" },
    ];
    expect(() => applyMigrations(connection, broken, new TestClock())).toThrow();
    const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables.map((row) => ({ ...row }))).toEqual([{ name: "a" }, { name: "migrations" }]);
    connection.close();
  });

  it("gives tickets that ended before the history existed the time they ended, and marks those that were joined", () => {
    const connection = new DatabaseSync(":memory:");
    const clock = new TestClock();
    applyMigrations(
      connection,
      migrations.filter((migration) => migration.version < 15),
      clock,
    );
    const insert = connection.prepare(
      "INSERT INTO tickets (id, repository, kind, title_en, title_zh, summary_en, summary_zh, state, stop_reason_en, created_at, updated_at) VALUES (?, 'novan-xu/a', 'fix', 't', 't', 's', 's', ?, ?, 1, ?)",
    );
    insert.run(1, "merged", null, 900);
    insert.run(2, "stopped", "Joined ticket 1 by an arrangement", 900);
    insert.run(3, "working", null, 900);
    insert.run(4, "stopped", "Joined the ticket of a friend", 900);
    const move = connection.prepare("INSERT INTO ticket_moves (ticket_id, seq, from_state, to_state, at) VALUES (?, ?, ?, ?, ?)");
    move.run(1, 1, "verifying", "merged", 500);
    move.run(2, 1, "pending", "stopped", 600);
    applyMigrations(connection, migrations, clock);
    const rows = connection.prepare("SELECT id, ended_at, joined_into FROM tickets ORDER BY id").all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { id: 1, ended_at: 500, joined_into: null },
      { id: 2, ended_at: 600, joined_into: 1 },
      { id: 3, ended_at: null, joined_into: null },
      { id: 4, ended_at: 900, joined_into: null },
    ]);
    connection.close();
  });

  it("refuses migrations that are not numbered in sequence", () => {
    const connection = new DatabaseSync(":memory:");
    expect(() => applyMigrations(connection, [{ version: 2, sql: "SELECT 1;" }], new TestClock())).toThrow(/numbered/);
    connection.close();
  });
});
