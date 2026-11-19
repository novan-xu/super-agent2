import { ticketReference } from "@super-agent2/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "@super-agent2/catalog";
import { type HistoryPosition, positionOfCursor, type Ticket, ticketKinds, ticketStates } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeTopic } from "./conversations.js";
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

const writing: Partial<TicketToOpen> = { kind: "writing", repository: null, issues: [] };

describe("tickets", () => {
  it("allocates codes across forms, wraps the last letter, and resets at local midnight", () => {
    const midnight = Date.parse("2026-07-19T04:00:00Z");
    clock = new TestClock(midnight - 1);
    const database = open();
    const tickets = createTicketService({ database, clock });
    const first = tickets.open(request(1));
    const second = tickets.open(request(2, { ...writing, task: { task: "Translate.", materials: [] } }));
    expect([ticketReference(first), ticketReference(second)]).toEqual(["aa-2026-07-18", "ab-2026-07-18"]);
    const rest = Array.from({ length: 25 }, (_, index) => tickets.open(request(index + 3)).code);
    expect(rest.slice(-2)).toEqual(["az", "ba"]);
    database.connection.prepare("UPDATE tickets SET code = 'zz' WHERE code = 'ba'").run();
    expect(() => tickets.open(request(28))).toThrow(/All 676 ticket codes for 2026-07-18 have been used/);
    clock.advance(1);
    expect(ticketReference(tickets.open(request(28)))).toBe("aa-2026-07-19");
    expect(ticketReference(tickets.open(request(29)))).toBe("ab-2026-07-19");
  });

  it("opens a pending ticket with its issue, records that it was filed, and announces it", () => {
    const database = open();
    const tickets = createTicketService({ database, clock });
    const conversation = storeTopic(database, clock.now(), "Code");
    const seen: Ticket[] = [];
    tickets.subscribe((ticket) => seen.push(ticket));
    const ticket = tickets.open(request(7, { difficulty: "standard", platform: "any", conversation }));
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
      pullRequests: [],
      round: 0,
      freeRetry: false,
      stuck: null,
      waitsFor: [],
      stopReason: null,
      conversation,
    });
    expect(ticket.issues.map((issue) => issue.number)).toEqual([7]);
    expect(tickets.moves(ticket.id)).toEqual([{ ticket: ticket.id, seq: 1, from: null, to: "pending", reason: null, at: clock.now() }]);
    expect(seen).toEqual([ticket]);
  });

  it.each([
    { name: "its repository topic", topicRepository: repository, finalRepository: repository },
    { name: "a claimable daily topic", topicRepository: null, finalRepository: repository },
    { name: "a daily topic with repository-free work", topicRepository: null, finalRepository: null, existingTask: true },
    { name: "a topic for another repository", topicRepository: "owner/other", finalRepository: "owner/other" },
    { name: "a code topic filing repository-free work", topicRepository: repository, finalRepository: repository, repositoryFree: true },
  ])("keeps a new ticket in $name", ({ topicRepository, finalRepository, existingTask, repositoryFree }) => {
    const database = open();
    const conversation = storeTopic(database, clock.now(), "Filing topic", { repository: topicRepository });
    const tickets = createTicketService({ database, clock });
    if (existingTask === true) tickets.open(request(1, { ...writing, conversation }));

    const ticket = tickets.open(request(2, { ...(repositoryFree === true ? writing : {}), conversation }));

    expect(ticket).toMatchObject({ conversation, repository: repositoryFree === true ? null : repository });
    expect(database.connection.prepare("SELECT id, repository FROM conversations").all()).toEqual([{ id: conversation, repository: finalRepository }]);
  });

  it("follows a merged filing topic to the final destination", () => {
    const database = open();
    const source = storeTopic(database, clock.now(), "Source");
    const intermediate = storeTopic(database, clock.now(), "Intermediate");
    const destination = storeTopic(database, clock.now(), "Destination", { repository: "owner/other" });
    const merge = database.connection.prepare("UPDATE conversations SET merged_into = ? WHERE id = ?");
    merge.run(intermediate, source);
    merge.run(destination, intermediate);
    const tickets = createTicketService({ database, clock });

    expect(tickets.open(request(1, { conversation: source }))).toMatchObject({ conversation: destination, repository });
    expect(database.connection.prepare("SELECT count(*) AS count FROM conversations").get()).toEqual({ count: 3 });
  });

  it("uses a predecessor's topic for a legacy ticket without one", () => {
    const database = open();
    const conversation = storeTopic(database, clock.now(), "Code", { repository });
    const tickets = createTicketService({ database, clock });
    const first = tickets.open(request(1, { conversation }));
    const later = tickets.open(request(2, { conversation, waitsFor: [first.id] }));
    database.connection.prepare("UPDATE tickets SET conversation_id = NULL WHERE id = ?").run(later.id);

    expect(tickets.topic(later.id)).toBe(conversation);
    expect(tickets.get(later.id)?.conversation).toBe(conversation);
    expect(database.connection.prepare("SELECT id FROM conversations").all()).toEqual([{ id: conversation }]);
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
    expect(() => tickets.open(request(1, { kind: "writing" }))).toThrow(/A task ticket has no issues/);
    expect(() => tickets.open(request(1, { waitsFor: [99] }))).toThrow(/predecessor ticket could not be found/);
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

  it("keeps a task ticket's task and material, and refuses them on a ticket for code", () => {
    const database = open();
    const tickets = createTicketService({ database, clock });
    const task = { task: "Translate the notice.", materials: [{ name: "notice.txt", source: "pasted", text: "你好" }, { name: "terms", source: "https://example.com", text: null }] };
    const stored = { ...task, commitRef: null, commit: null, deploys: false };
    const ticket = tickets.open(request(1, { kind: "writing", repository: null, issues: [], task }));
    expect(ticket.form).toBe("task");
    expect(tickets.task(ticket.id)).toEqual(stored);
    expect(tickets.task(99)).toBeUndefined();
    expect(() => tickets.open(request(2, { form: "code", task }))).toThrow(/Only a task ticket has a task/);
    expect(() => tickets.open(request(5, { kind: "fix", repository: null, issues: [], task }))).toThrow(/cannot be of kind fix/);
    expect(() => tickets.open(request(3, { kind: "writing", repository: null, issues: [], task: { task: " ", materials: [] } }))).toThrow(/needs its task/);
    expect(() => tickets.open(request(4, { kind: "writing", repository: null, issues: [], task: { task: "x", materials: [{ name: "../x", source: "s", text: null }] } }))).toThrow();
    const reopened = createTicketService({ database, clock });
    expect(reopened.task(ticket.id)).toEqual(stored);
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
      const writing = tickets.open(request(9, { kind: "writing", repository: null, issues: [], title: { en: "Neighbour notice", zh: "给邻居的通知" }, task: { task: "Write a short notice about the garden gate being repainted.", materials: [] } }));
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

describe("repair tickets", () => {
  const reason = { en: "Stopped", zh: "停了" };

  function stopped(tickets: ReturnType<typeof createTicketService>, numbers: readonly number[] = [7, 8]): Ticket {
    const title = { en: "Two steps", zh: "两步" };
    const summary = { en: "Both steps", zh: "两个步骤" };
    const ticket = tickets.open({
      repository,
      issues: numbers.map((number) => ({ repository, number, url: `https://github.com/${repository}/issues/${number}`, title, summary })),
      title,
      summary,
      kind: "feature",
      difficulty: "standard",
      platform: "windows",
    });
    tickets.change((writes) => {
      writes.setBranch(ticket.id, "sa2/ticket-1-aaaa");
      writes.move(ticket.id, "working");
      writes.setPullRequest(ticket.id, 21, { en: "First", zh: "第一" }, { closes: [numbers[0] ?? 0] });
      writes.pullRequestMerged(ticket.id, { number: 21, closes: [numbers[0] ?? 0], mergeCommit: "m21", deployment: null });
      writes.move(ticket.id, "stopped", reason);
    });
    return tickets.get(ticket.id) ?? ticket;
  }

  it("opens one repair for a stopped ticket, holding what is open on the same branch, and links both ways", () => {
    const tickets = createTicketService({ database: open(), clock });
    const ended = stopped(tickets);
    const result = tickets.repair(ended.id, "brain", " please ");
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.ticket).toMatchObject({ state: "pending", repairs: ended.id, repairedBy: null, branch: "sa2/ticket-1-aaaa", kind: "feature", difficulty: "standard", platform: "windows", repository });
    expect(result.ticket.issues.map((issue) => issue.number)).toEqual([8]);
    expect(tickets.get(ended.id)).toMatchObject({ state: "stopped", repairs: null, repairedBy: result.ticket.id });
    expect(tickets.repairRecord(result.ticket.id)).toMatchObject({ openedBy: "brain", words: "please", failure: null, where: null, saved: null });
    expect(tickets.lineage(result.ticket.id).map((ticket) => ticket.id)).toEqual([ended.id]);
    expect(tickets.repair(ended.id, "brain", "")).toEqual({ ok: false, reason: `Ticket ${ticketReference(ended)} already has a repair ticket` });
  });

  it("refuses a ticket that has not stopped, was joined, or has nothing left", () => {
    const tickets = createTicketService({ database: open(), clock });
    const working = tickets.open(request(7));
    expect(tickets.repair(working.id, "brain", "")).toMatchObject({ ok: false });
    expect(tickets.repair(999, "brain", "")).toEqual({ ok: false, reason: "There is no ticket (unavailable)." });
    const joined = tickets.open(request(8));
    tickets.change((writes) => writes.join(joined.id, working.id, reason));
    expect(tickets.repair(joined.id, "brain", "")).toMatchObject({ ok: false, reason: expect.stringContaining("joined") as unknown as string });
    const done = stopped(tickets, [20]);
    expect(tickets.repair(done.id, "brain", "")).toMatchObject({ ok: false, reason: expect.stringContaining("nothing remains") as unknown as string });
  });

  it("opens a repair in the same step as giving up, redirecting every wait that was not waived and keeping the deployment flag", () => {
    const tickets = createTicketService({ database: open(), clock });
    const title = { en: "Two steps", zh: "两步" };
    const stuck = tickets.open({ ...request(7), issues: [7, 8].map((number) => ({ repository, number, url: `https://github.com/${repository}/issues/${number}`, title, summary: title })) });
    const after = (number: number) => tickets.open(request(number, { waitsFor: [stuck.id] }));
    const pending = after(20);
    const started = after(21);
    const deployed = after(22);
    const waived = after(23);
    const working = after(24);
    tickets.change((writes) => {
      writes.setWaits(deployed.id, [{ ticket: stuck.id, deployment: true }]);
      writes.move(started.id, "waiting");
      writes.move(waived.id, "waiting");
      writes.waive(waived.id, stuck.id);
      writes.move(working.id, "working");
      writes.move(stuck.id, "working");
      writes.stick(stuck.id, { kind: "workflow", detail: "red" });
      writes.describeStuck(stuck.id, { en: "Where", zh: "卡在这里" });
    });
    const seen: Ticket[] = [];
    tickets.subscribe((ticket) => seen.push(ticket));
    const outcome = tickets.giveUp(stuck.id, reason, " words ");
    if (!outcome.ok || outcome.repair === null) {
      throw new Error("no repair");
    }
    const repair = outcome.repair;
    expect(outcome.ticket).toMatchObject({ state: "stopped", repairedBy: repair.id });
    expect(outcome.followers.map((ticket) => ticket.id)).toEqual([pending.id, started.id, deployed.id]);
    const waits = (id: number) => tickets.get(id)?.waits.map((wait) => [wait.ticket, wait.deployment, wait.waived]);
    expect(waits(pending.id)).toEqual([[repair.id, false, false]]);
    expect(waits(started.id)).toEqual([[repair.id, false, false]]);
    expect(waits(deployed.id)).toEqual([[repair.id, true, false]]);
    expect(waits(waived.id)).toEqual([[stuck.id, false, true]]);
    expect(waits(working.id)).toEqual([[stuck.id, false, false]]);
    expect(tickets.waitingFor(stuck.id).map((ticket) => ticket.id)).toEqual([waived.id, working.id]);
    expect(tickets.repairRecord(repair.id)).toMatchObject({ openedBy: "owner", words: "words", failure: { kind: "workflow", detail: "red" }, where: { en: "Where" } });
    expect(seen.find((ticket) => ticket.id === stuck.id)?.repairedBy).toBe(repair.id);
    expect(tickets.giveUp(stuck.id, reason, "")).toEqual({ ok: false, error: "refused" });
    expect(tickets.giveUp(999, reason, "")).toEqual({ ok: false, error: "not_found" });
  });

  it("copies a task's text, material, commit and deployment, and keeps the waits it already had", () => {
    const tickets = createTicketService({ database: open(), clock });
    const before = tickets.open(request(7));
    const title = { en: "Deploy", zh: "部署" };
    const task = tickets.open({
      form: "task",
      repository,
      issues: [],
      title,
      summary: title,
      kind: "operation",
      requiredMachine: "pc",
      waitsFor: [before.id],
      task: { task: "Deploy it.", materials: [{ name: "notes.txt", source: "owner", text: "careful" }], commitRef: "merged", deploys: true },
    });
    tickets.change((writes) => {
      writes.setCommit(task.id, "abc1234");
      writes.move(task.id, "working");
      writes.move(task.id, "stopped", reason);
    });
    const outcome = tickets.repair(task.id, "brain", "");
    if (!outcome.ok) {
      throw new Error(outcome.reason);
    }
    expect(outcome.ticket).toMatchObject({ form: "task", kind: "operation", requiredMachine: "pc", deploys: true, commitRef: "merged", commit: "abc1234", branch: null, issues: [] });
    expect(tickets.task(outcome.ticket.id)).toMatchObject({ task: "Deploy it.", materials: [{ name: "notes.txt", text: "careful" }] });
    expect(outcome.ticket.waits.map((wait) => wait.ticket)).toEqual([before.id]);
  });

  it("hands in a decision once across the whole lineage", () => {
    const tickets = createTicketService({ database: open(), clock });
    const ended = stopped(tickets);
    const decision = { chosen: { en: "Use CSV", zh: "用 CSV" }, why: { en: "Simple", zh: "简单" }, otherOptions: { en: "Excel", zh: "用 Excel" } };
    tickets.change((writes) => writes.recordDecisions(ended.id, "brain", [decision]));
    const first = tickets.repair(ended.id, "brain", "");
    if (!first.ok) {
      throw new Error(first.reason);
    }
    const recorded = tickets.change((writes) => writes.recordDecisions(first.ticket.id, "worker", [decision, { ...decision, chosen: { en: "Use TSV", zh: "用 TSV" } }]));
    expect(recorded.map((entry) => entry.chosen.en)).toEqual(["Use TSV"]);
    expect(tickets.get(ended.id)?.decisions).toHaveLength(1);
    expect(tickets.get(first.ticket.id)?.decisions).toHaveLength(1);
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
