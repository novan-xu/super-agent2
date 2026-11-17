import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "@super-agent2/catalog";
import { type Ticket, ticketKinds, ticketStates } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HubDatabase, openDatabase } from "./database.js";
import { TestClock } from "./testing/access.js";
import { createTicketService, type TicketToOpen } from "./tickets.js";

let dataDir: string;
let clock: TestClock;
const opened: HubDatabase[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-tickets-"));
  clock = new TestClock();
});

afterEach(() => {
  for (const database of opened.splice(0)) {
    database.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function open(): HubDatabase {
  const database = openDatabase({ dataDir, clock });
  opened.push(database);
  return database;
}

const repository = "novan-xu/super-agent-sandbox";

function request(number = 7, overrides: Partial<TicketToOpen> = {}): TicketToOpen {
  const title = { en: "Add a greeting", zh: "加一句问候" };
  const summary = { en: "Print hello on start", zh: "启动时打印问候" };
  return {
    repository,
    issues: [{ repository, number, url: `https://github.com/${repository}/issues/${number}`, title, summary }],
    title,
    summary,
    kind: "feature",
    ...overrides,
  };
}

describe("tickets", () => {
  it("opens a pending ticket with its issue, records that it was filed, and announces it", () => {
    const tickets = createTicketService({ database: open(), clock });
    const seen: Ticket[] = [];
    tickets.subscribe((ticket) => seen.push(ticket));
    const ticket = tickets.open(request(7, { difficulty: "standard", platform: "any", conversation: "c-1" }));
    expect(ticket).toMatchObject({
      repository,
      state: "pending",
      kind: "feature",
      difficulty: "standard",
      platform: "any",
      machine: null,
      engine: null,
      model: null,
      effort: null,
      branch: null,
      pullRequest: null,
      round: 0,
      waitsFor: [],
      stopReason: null,
      conversation: "c-1",
    });
    expect(ticket.issues.map((issue) => issue.number)).toEqual([7]);
    expect(tickets.moves(ticket.id)).toEqual([{ ticket: ticket.id, seq: 1, from: null, to: "pending", reason: null, at: clock.now() }]);
    expect(seen).toEqual([ticket]);
  });

  it("keeps a chain's issues in working order and the tickets it waits for", () => {
    const tickets = createTicketService({ database: open(), clock });
    const first = tickets.open(request(1));
    const chain = request(4);
    const second = tickets.open({
      ...chain,
      issues: [5, 3, 4].map((number) => ({ ...chain.issues[0]!, number, url: `u${number}` })),
      waitsFor: [first.id],
    });
    expect(second.issues.map((issue) => issue.number)).toEqual([5, 3, 4]);
    expect(second.waitsFor).toEqual([first.id]);
    expect(tickets.forIssue(repository, 3).map((ticket) => ticket.id)).toEqual([second.id]);
  });

  it("refuses a ticket that does not hold together", () => {
    const tickets = createTicketService({ database: open(), clock });
    expect(() => tickets.open(request(1, { repository: null }))).toThrow(/repository/);
    expect(() => tickets.open(request(1, { issues: [] }))).toThrow(/at least one issue/);
    expect(() => tickets.open(request(1, { kind: "writing" }))).toThrow(/writing/);
    expect(() => tickets.open(request(1, { waitsFor: [99] }))).toThrow(/no ticket 99/);
    expect(() => tickets.open(request(1, { title: { en: "x", zh: "x" } }))).toThrow();
    const twice = request(1);
    expect(() => tickets.open({ ...twice, issues: [twice.issues[0]!, twice.issues[0]!] })).toThrow(/twice/);
    expect(() => tickets.open({ ...twice, issues: [{ ...twice.issues[0]!, repository: "novan-xu/other" }] })).toThrow(/not in the ticket's repository/);
    expect(tickets.list({})).toEqual([]);
  });

  it("opens a writing ticket with no repository and no issues", () => {
    const tickets = createTicketService({ database: open(), clock });
    const ticket = tickets.open(request(1, { kind: "writing", repository: null, issues: [] }));
    expect(ticket.repository).toBeNull();
    expect(ticket.issues).toEqual([]);
    expect(tickets.move(ticket.id, "working").ok).toBe(true);
    expect(tickets.move(ticket.id, "verifying")).toMatchObject({ ok: false, error: "refused" });
    expect(tickets.move(ticket.id, "delivered").ok).toBe(true);
  });

  it("keeps a writing ticket's task and material, and refuses them on a ticket for code", () => {
    const database = open();
    const tickets = createTicketService({ database, clock });
    const writing = { task: "Translate the notice.", materials: [{ name: "notice.txt", source: "pasted", text: "你好" }, { name: "terms", source: "https://example.com", text: null }] };
    const ticket = tickets.open(request(1, { kind: "writing", repository: null, issues: [], writing }));
    expect(tickets.writing(ticket.id)).toEqual(writing);
    expect(tickets.writing(99)).toBeUndefined();
    expect(() => tickets.open(request(2, { writing }))).toThrow(/Only a writing ticket/);
    expect(() => tickets.open(request(3, { kind: "writing", repository: null, issues: [], writing: { task: " ", materials: [] } }))).toThrow(/needs its task/);
    expect(() => tickets.open(request(4, { kind: "writing", repository: null, issues: [], writing: { task: "x", materials: [{ name: "../x", source: "s", text: null }] } }))).toThrow();
    const reopened = createTicketService({ database, clock });
    expect(reopened.writing(ticket.id)).toEqual(writing);
    reopened.change((writes) => writes.setReport(ticket.id, { en: "Done", zh: "完成" }));
    expect(reopened.get(ticket.id)?.report).toEqual({ en: "Done", zh: "完成" });
  });

  it("moves only along the table, and records each move with its time and reason", () => {
    const tickets = createTicketService({ database: open(), clock });
    const ticket = tickets.open(request());
    expect(tickets.move(ticket.id, "merged")).toMatchObject({ ok: false, error: "refused", ticket: { state: "pending" } });
    clock.advance(1000);
    expect(tickets.move(ticket.id, "working")).toMatchObject({ ok: true, ticket: { state: "working", updatedAt: clock.now() } });
    clock.advance(1000);
    const reason = { en: "The pull request is open", zh: "拉取请求已打开" };
    expect(tickets.move(ticket.id, "verifying", reason).ok).toBe(true);
    expect(tickets.move(ticket.id, "merged").ok).toBe(true);
    expect(tickets.move(ticket.id, "working")).toMatchObject({ ok: false, error: "refused" });
    expect(tickets.moves(ticket.id).map((move) => [move.from, move.to])).toEqual([
      [null, "pending"],
      ["pending", "working"],
      ["working", "verifying"],
      ["verifying", "merged"],
    ]);
    expect(tickets.moves(ticket.id)[2]?.reason).toEqual(reason);
    expect(tickets.move(999, "working")).toEqual({ ok: false, error: "not_found" });
  });

  it("stops a ticket with its reason, hands it to the work that would stop a worker, and refuses to stop it twice", () => {
    const stoppedWork: number[] = [];
    const tickets = createTicketService({ database: open(), clock, work: { begin: () => undefined, stop: (ticket) => stoppedWork.push(ticket.id) } });
    const ticket = tickets.open(request());
    const reason = { en: "The owner changed their mind", zh: "主人改主意了" };
    const result = tickets.stop(ticket.id, reason);
    expect(result).toMatchObject({ ok: true, ticket: { state: "stopped", stopReason: reason } });
    expect(stoppedWork).toEqual([ticket.id]);
    expect(tickets.stop(ticket.id, reason)).toMatchObject({ ok: false, error: "refused" });
    expect(stoppedWork).toEqual([ticket.id]);
    expect(() => tickets.stop(ticket.id, { en: "x", zh: "x" })).toThrow();
  });

  it("lists open tickets, or all of them, newest first", () => {
    const tickets = createTicketService({ database: open(), clock });
    const a = tickets.open(request(1));
    clock.advance(10);
    const b = tickets.open(request(2));
    clock.advance(10);
    const c = tickets.open(request(3));
    tickets.stop(b.id, { en: "No longer needed", zh: "不再需要" });
    expect(tickets.list({ open: true }).map((ticket) => ticket.id)).toEqual([c.id, a.id]);
    expect(tickets.list().map((ticket) => ticket.id)).toEqual([c.id, b.id, a.id]);
    expect(tickets.list({ limit: 1 }).map((ticket) => ticket.id)).toEqual([c.id]);
  });

  it("keeps tickets, their state and their history across a restart of the hub", () => {
    const first = open();
    const before = createTicketService({ database: first, clock });
    const ticket = before.open(request(1, { waitsFor: [] }));
    const other = before.open(request(2, { waitsFor: [ticket.id] }));
    before.move(ticket.id, "working");
    before.stop(other.id, { en: "Replaced", zh: "被替换了" });
    const snapshot = before.get(ticket.id);
    first.close();
    opened.splice(opened.indexOf(first), 1);
    const after = createTicketService({ database: open(), clock });
    expect(snapshot?.state).toBe("working");
    expect(after.get(ticket.id)).toEqual(snapshot);
    expect(after.get(other.id)).toMatchObject({ state: "stopped", waitsFor: [ticket.id], stopReason: { zh: "被替换了" } });
    expect(after.moves(ticket.id).map((move) => move.to)).toEqual(["pending", "working"]);
  });
});

describe("the catalog", () => {
  it("names every ticket state and kind in Chinese", () => {
    for (const state of ticketStates) {
      expect(messages[`ticket.state.${state}`]).toMatch(/\p{Script=Han}/u);
    }
    for (const kind of ticketKinds) {
      expect(messages[`ticket.kind.${kind}`]).toMatch(/\p{Script=Han}/u);
    }
  });
});
