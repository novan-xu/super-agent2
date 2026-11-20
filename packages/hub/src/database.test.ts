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
  it("backfills codes in local creation order and preserves the old work branch", () => {
    using connection = new DatabaseSync(":memory:");
    const clock = new TestClock();
    applyMigrations(connection, migrations.filter(({ version }) => version < 43), clock);
    const insert = connection.prepare(`
      INSERT INTO tickets (id, repository, kind, title_en, title_zh, summary_en, summary_zh, state, branch, created_at, updated_at)
      VALUES (?, 'novan-xu/a', 'fix', 't', 't', 's', 's', 'working', 'sa2/ticket-1-beef', ?, ?)
    `);
    const midnight = Date.parse("2026-11-19T05:00:00Z");
    for (const [id, at] of [[4, midnight - 1], [3, midnight - 1], [2, midnight], [1, midnight - 2]] as const) {
      insert.run(id, at, at);
    }
    applyMigrations(connection, migrations, clock, "America/New_York");
    expect(connection.prepare("SELECT id, code, code_date, branch FROM tickets ORDER BY id").all()).toEqual([
      { id: 1, code: "aa", code_date: "2026-11-18", branch: "sa2/ticket-1-beef" },
      { id: 2, code: "aa", code_date: "2026-11-19", branch: "sa2/ticket-1-beef" },
      { id: 3, code: "ab", code_date: "2026-11-18", branch: "sa2/ticket-1-beef" },
      { id: 4, code: "ac", code_date: "2026-11-18", branch: "sa2/ticket-1-beef" },
    ]);
    expect(() => connection.exec("UPDATE tickets SET code = 'aa' WHERE id = 3")).toThrow(/UNIQUE constraint failed/);
    expect(() => connection.exec("UPDATE tickets SET code = 'abc' WHERE id = 3")).toThrow(/CHECK constraint failed/);
    expect(() => connection.exec("UPDATE tickets SET code = NULL WHERE id = 3")).toThrow(/require a code and creation day/);
  });

  it("keeps routing vectors per entry, model and text hash, and drops them with their entry", () => {
    using connection = new DatabaseSync(":memory:");
    connection.exec("PRAGMA foreign_keys = ON");
    const clock = new TestClock();
    applyMigrations(connection, migrations.filter(({ version }) => version < 44), clock);
    connection.prepare("INSERT INTO conversations (id, title, state, created_at, updated_at) VALUES ('c', 'Topic', 'idle', 1, 1)").run();
    const entry = connection.prepare("INSERT INTO conversation_entries (id, conversation_id, seq, kind, body, created_at, stream_seq) VALUES (?, 'c', ?, 'owner', '{}', 1, ?)");
    entry.run("kept", 1, 1);
    entry.run("gone", 2, 2);
    applyMigrations(connection, migrations, clock);
    const insert = connection.prepare("INSERT INTO routing_vectors (entry, model, text_hash, vector, computed_at) VALUES (?, ?, ?, ?, 1)");
    const hash = new Uint8Array(32);
    const vector = new Uint8Array(new Float32Array([0.6, 0.8]).buffer);
    insert.run("kept", "m", hash, vector);
    insert.run("kept", "n", hash, vector);
    insert.run("kept", "m", new Uint8Array(32).fill(1), vector);
    insert.run("gone", "m", hash, vector);
    expect(() => insert.run("kept", "m", hash, vector)).toThrow(/UNIQUE constraint failed/);
    expect(() => insert.run("missing", "m", hash, vector)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insert.run("kept", "o", new Uint8Array(31), vector)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run("kept", "o", hash, new Uint8Array(6))).toThrow(/CHECK constraint failed/);
    connection.exec("UPDATE conversations SET topic_state = 'archived' WHERE id = 'c'");
    connection.exec("DELETE FROM conversation_entries WHERE id = 'gone'");
    const rows = connection.prepare("SELECT entry, model, hex(text_hash) AS hash FROM routing_vectors ORDER BY entry, model, text_hash").all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { entry: "kept", model: "m", hash: "00".repeat(32) },
      { entry: "kept", model: "m", hash: "01".repeat(32) },
      { entry: "kept", model: "n", hash: "00".repeat(32) },
    ]);
  });

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

  it("turns writing tickets into task tickets, drops the hub's deployments, and withdraws a deployment command still held", () => {
    const connection = new DatabaseSync(":memory:");
    const clock = new TestClock();
    const tasks = migrations.find((migration) => migration.sql.includes("RENAME TO ticket_tasks"))?.version ?? 0;
    expect(tasks).toBeGreaterThan(22);
    applyMigrations(
      connection,
      migrations.filter((migration) => migration.version < tasks),
      clock,
    );
    const ticket = connection.prepare(
      "INSERT INTO tickets (id, repository, kind, title_en, title_zh, summary_en, summary_zh, state, created_at, updated_at) VALUES (?, ?, ?, 't', 't', 's', 's', ?, 1, 1)",
    );
    ticket.run(1, null, "writing", "pending");
    ticket.run(2, "novan-xu/a", "fix", "merged");
    connection.prepare("INSERT INTO ticket_writing (ticket_id, task, materials) VALUES (1, 'Translate it.', '[]')").run();
    const command = connection.prepare("INSERT INTO commands (id, target, command, account, cwd, environment, state, created_at) VALUES (?, 'hub', ?, 'novan-xu', NULL, ?, 'held', 1)");
    command.run("deploy", "rm -rf releases/$SUPERAGENT2_PREVIOUS_COMMIT", JSON.stringify({ SUPERAGENT2_COMMIT: "abc1234" }));
    command.run("plain", "gh repo delete novan-xu/a --yes", null);
    const hold = connection.prepare("INSERT INTO holds (command_id, form, description, evidence, fingerprint, held_at) VALUES (?, 'file-deletion', 'd', 'e', 'f', 1)");
    hold.run("deploy");
    hold.run("plain");
    connection.prepare("INSERT INTO deployments (repository, commit_sha, target, file, phase, started_at) VALUES ('novan-xu/a', 'abc1234', 'hub', '{}', 'deploy', 1)").run();
    connection.prepare("INSERT INTO deployment_steps (deployment_id, seq, kind, command_id) VALUES (1, 1, 'deploy', 'deploy')").run();
    applyMigrations(connection, migrations, clock);
    expect(connection.prepare("SELECT id, form, kind, required_machine FROM tickets ORDER BY id").all().map((row) => ({ ...row }))).toEqual([
      { id: 1, form: "task", kind: "writing", required_machine: null },
      { id: 2, form: "code", kind: "fix", required_machine: null },
    ]);
    expect(connection.prepare("SELECT ticket_id, task, commit_ref, commit_sha, deploys FROM ticket_tasks").all().map((row) => ({ ...row }))).toEqual([
      { ticket_id: 1, task: "Translate it.", commit_ref: null, commit_sha: null, deploys: 0 },
    ]);
    const commands = connection.prepare("SELECT id, state, reason FROM commands ORDER BY id").all().map((row) => ({ ...row }));
    expect(commands).toEqual([
      { id: "deploy", state: "dropped", reason: expect.stringContaining("部署") },
      { id: "plain", state: "held", reason: null },
    ]);
    expect(connection.prepare("SELECT command_id, answer FROM holds ORDER BY command_id").all().map((row) => ({ ...row }))).toEqual([
      { command_id: "deploy", answer: "withdrawn" },
      { command_id: "plain", answer: null },
    ]);
    const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'deployment%'").all();
    expect(tables).toEqual([]);
    expect(connection.prepare("SELECT name FROM pragma_table_info('commands') WHERE name = 'environment'").all()).toEqual([]);
    connection.close();
  });

  it("refuses migrations that are not numbered in sequence", () => {
    const connection = new DatabaseSync(":memory:");
    expect(() => applyMigrations(connection, [{ version: 2, sql: "SELECT 1;" }], new TestClock())).toThrow(/numbered/);
    connection.close();
  });
});
