import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "@super-agent2/catalog";
import { type HistoryPosition, positionOfCursor, type Ticket, ticketKinds, ticketStates } from "@super-agent2/protocol";
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
      freeRetry: false,
      stuck: null,
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

function end(tickets: ReturnType<typeof createTicketService>, id: number, to: "merged" | "stopped" | "delivered" = "merged"): void {
  if (to === "stopped") {
    tickets.stop(id, { en: "No longer needed", zh: "不再需要" });
    return;
  }
  tickets.move(id, "working");
  tickets.move(id, to === "merged" ? "verifying" : "delivered");
  if (to === "merged") {
    tickets.move(id, "merged");
  }
}

function issued(number: number, title: { en: string; zh: string }, summary: { en: string; zh: string }, repo = repository): TicketToOpen {
  return {
    repository: repo,
    issues: [{ repository: repo, number, url: `https://github.com/${repo}/issues/${number}`, title, summary }],
    title: { en: `Ticket for ${title.en}`, zh: `${title.zh}的工单` },
    summary: { en: "Do the work", zh: "做这件事" },
    kind: "fix",
  };
}

describe("the history", () => {
  it("records when a ticket ended and keeps it when the ticket is touched later", () => {
    const tickets = createTicketService({ database: open(), clock });
    const ticket = tickets.open(request(1));
    expect(ticket.endedAt).toBeNull();
    clock.advance(1000);
    tickets.move(ticket.id, "working");
    expect(tickets.get(ticket.id)?.endedAt).toBeNull();
    clock.advance(1000);
    tickets.move(ticket.id, "verifying");
    clock.advance(1000);
    tickets.move(ticket.id, "merged");
    const endedAt = clock.now();
    expect(tickets.get(ticket.id)?.endedAt).toBe(endedAt);
    clock.advance(5000);
    tickets.change((writes) => writes.deployed(ticket.id));
    expect(tickets.get(ticket.id)).toMatchObject({ endedAt, updatedAt: clock.now() });
  });

  it("lists merged, delivered and stopped tickets by when they ended, not when they were filed", () => {
    const tickets = createTicketService({ database: open(), clock });
    const first = tickets.open(request(1));
    clock.advance(10);
    const second = tickets.open(request(2));
    clock.advance(10);
    const third = tickets.open(request(3, { kind: "writing", repository: null, issues: [] }));
    clock.advance(10);
    const ongoing = tickets.open(request(4));
    tickets.move(ongoing.id, "working");
    clock.advance(10);
    end(tickets, second.id, "merged");
    clock.advance(10);
    end(tickets, third.id, "delivered");
    clock.advance(10);
    end(tickets, first.id, "stopped");
    expect(tickets.history().tickets.map((ticket) => [ticket.id, ticket.state])).toEqual([
      [first.id, "stopped"],
      [third.id, "delivered"],
      [second.id, "merged"],
    ]);
    expect(tickets.history()).toMatchObject({ next: null });
  });

  it("reads in pages that neither repeat nor skip a ticket, including tickets that ended at the same moment", () => {
    const tickets = createTicketService({ database: open(), clock });
    const ids: number[] = [];
    for (let number = 1; number <= 7; number += 1) {
      ids.push(tickets.open(request(number)).id);
    }
    clock.advance(100);
    for (const id of ids.slice(0, 4)) {
      end(tickets, id, "stopped");
    }
    clock.advance(100);
    for (const id of ids.slice(4)) {
      end(tickets, id, "stopped");
    }
    const seen: number[] = [];
    let before: HistoryPosition | undefined;
    const sizes: number[] = [];
    for (;;) {
      const page = tickets.history({ limit: 3, ...(before === undefined ? {} : { before }) });
      sizes.push(page.tickets.length);
      seen.push(...page.tickets.map((ticket) => ticket.id));
      if (page.next === null) {
        break;
      }
      before = positionOfCursor(page.next);
    }
    expect(sizes).toEqual([3, 3, 1]);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("does not list a ticket that was joined into another by an arrangement, but still has it", () => {
    const tickets = createTicketService({ database: open(), clock });
    const kept = tickets.open(request(1));
    const absorbed = tickets.open(request(2));
    tickets.change((writes) => writes.join(absorbed.id, kept.id, { en: `Joined ticket ${kept.id} by an arrangement`, zh: "并入" }));
    expect(tickets.get(absorbed.id)).toMatchObject({ state: "stopped", joinedInto: kept.id, stopReason: { zh: "并入" } });
    expect(tickets.get(absorbed.id)?.endedAt).not.toBeNull();
    expect(tickets.history().tickets).toEqual([]);
    end(tickets, kept.id, "stopped");
    expect(tickets.history().tickets.map((ticket) => ticket.id)).toEqual([kept.id]);
    expect(() => tickets.change((writes) => writes.join(kept.id, kept.id, { en: "x", zh: "x" }))).toThrow(/cannot join itself/);
  });

  describe("search", () => {
    function filled() {
      const tickets = createTicketService({ database: open(), clock });
      const entries = [
        issued(1, { en: "Parse relative dates", zh: "解析相对日期" }, { en: "Words like tomorrow become dates", zh: "把明天这样的词变成日期" }),
        issued(2, { en: "Export notes", zh: "导出笔记" }, { en: "Write every note to Markdown", zh: "把每条笔记写成 Markdown" }, "nuofan-island/plant-log"),
        issued(3, { en: "Discount is 50% off", zh: "五折优惠" }, { en: "Show the sale_price", zh: "显示折后价" }),
      ];
      const ids = entries.map((entry) => {
        const ticket = tickets.open(entry);
        clock.advance(10);
        end(tickets, ticket.id, "merged");
        clock.advance(10);
        return ticket.id;
      });
      const writing = tickets.open(request(9, { kind: "writing", repository: null, issues: [], title: { en: "Neighbour notice", zh: "给邻居的通知" }, writing: { task: "Write a short notice about the garden gate being repainted.", materials: [] } }));
      end(tickets, writing.id, "delivered");
      const stillOpen = tickets.open(issued(4, { en: "Parse times", zh: "解析时间" }, { en: "Hours and minutes", zh: "小时和分钟" }));
      tickets.move(stillOpen.id, "working");
      return { tickets, ids, writing: writing.id };
    }

    const found = (tickets: ReturnType<typeof createTicketService>, query: string) => tickets.history({ query }).tickets.map((ticket) => ticket.id);

    it("finds a ticket by a word from an issue's Chinese text, with no spaces to split on", () => {
      const { tickets, ids } = filled();
      expect(found(tickets, "日期")).toEqual([ids[0]]);
      expect(found(tickets, "明天")).toEqual([ids[0]]);
      expect(found(tickets, "笔")).toEqual([ids[1]]);
      expect(found(tickets, "相对日")).toEqual([ids[0]]);
      expect(found(tickets, "没有这个词")).toEqual([]);
    });

    it("finds a ticket by a word from an issue's English text, ignoring the case of ASCII letters", () => {
      const { tickets, ids } = filled();
      expect(found(tickets, "TOMORROW")).toEqual([ids[0]]);
      expect(found(tickets, "markdown")).toEqual([ids[1]]);
      expect(found(tickets, "relative")).toEqual([ids[0]]);
    });

    it("finds a ticket by its title, its summary, its repository and a writing ticket's task", () => {
      const { tickets, ids, writing } = filled();
      expect(found(tickets, "plant-log")).toEqual([ids[1]]);
      expect(found(tickets, "nuofan-island")).toEqual([ids[1]]);
      expect(found(tickets, "邻居")).toEqual([writing]);
      expect(found(tickets, "repainted")).toEqual([writing]);
      expect(found(tickets, "做这件事")).toEqual([ids[2], ids[1], ids[0]]);
    });

    it("wants every word, each in any of the ticket's texts, and ignores the order and spacing of words", () => {
      const { tickets, ids } = filled();
      expect(found(tickets, "date 解析")).toEqual([ids[0]]);
      expect(found(tickets, "  解析　DATES  ")).toEqual([ids[0]]);
      expect(found(tickets, "notes 日期")).toEqual([]);
      expect(found(tickets, "   ")).toEqual(found(tickets, ""));
    });

    it("takes percent signs, underscores and backslashes as themselves", () => {
      const { tickets, ids } = filled();
      expect(found(tickets, "50%")).toEqual([ids[2]]);
      expect(found(tickets, "sale_price")).toEqual([ids[2]]);
      expect(found(tickets, "sa_e")).toEqual([]);
      expect(found(tickets, "5%f")).toEqual([]);
      expect(found(tickets, "%")).toEqual([ids[2]]);
      expect(found(tickets, "_")).toEqual([ids[2]]);
      expect(found(tickets, "\\")).toEqual([]);
      expect(found(tickets, "'; DROP TABLE tickets; --")).toEqual([]);
    });

    it("searches only tickets that ended, and pages through the matches", () => {
      const { tickets, ids } = filled();
      expect(found(tickets, "解析")).toEqual([ids[0]]);
      expect(found(tickets, "Parse times")).toEqual([]);
      const page = tickets.history({ query: "做这件事", limit: 2 });
      expect(page.tickets).toHaveLength(2);
      expect(page.next).not.toBeNull();
    });
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
