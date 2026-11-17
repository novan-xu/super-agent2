import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineReport, RunnerWorkEvent, StoredWorkEvent, Ticket, WorkEvent, WorkHeld } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HubDatabase, openDatabase } from "./database.js";
import type { WorkLink, WorkMessageToRunner } from "./runners.js";
import { TestClock } from "./testing/access.js";
import { testCredentials } from "./testing/commands.js";
import { createTicketService, type TicketService } from "./tickets.js";
import { createWorkService, type WorkRunners, type WorkService } from "./work.js";

const repository = "novan-xu/super-agent-sandbox";

class FakeRunners implements WorkRunners {
  link: WorkLink | undefined;
  readonly sent: { readonly machine: string; readonly message: WorkMessageToRunner }[] = [];
  readonly online = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  bindWork(link: WorkLink): void {
    this.link = link;
  }

  sendWork(machine: string, message: WorkMessageToRunner): boolean {
    if (!this.online.has(machine)) {
      return false;
    }
    this.sent.push({ machine, message });
    return true;
  }

  report(machine: string): MachineReport | undefined {
    const total = this.online.get(machine);
    if (total === undefined) {
      return undefined;
    }
    return { hostname: machine, platform: "win32", release: "1", arch: "x64", user: "owner", slots: { total, free: total }, programs: [], allowances: [] };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(machine: string, slots: number, held: readonly WorkHeld[] = []): void {
    this.online.set(machine, slots);
    this.link?.hello(machine, held);
    for (const listener of this.listeners) {
      listener();
    }
  }

  drop(machine: string): void {
    this.online.delete(machine);
    this.link?.closed(machine);
  }

  of<T extends WorkMessageToRunner["type"]>(type: T, machine?: string): Extract<WorkMessageToRunner, { readonly type: T }>[] {
    return this.sent
      .filter((entry) => entry.message.type === type && (machine === undefined || entry.machine === machine))
      .map((entry) => entry.message as Extract<WorkMessageToRunner, { readonly type: T }>);
  }
}

let dataDir: string;
let clock: TestClock;
let database: HubDatabase;
let tickets: TicketService;
let runners: FakeRunners;
let work: WorkService;
let told: { readonly conversation: string | null; readonly notice: string; readonly prompt: string }[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-work-"));
  clock = new TestClock();
  database = openDatabase({ dataDir, clock });
  runners = new FakeRunners();
  told = [];
  let bound: WorkService | undefined;
  tickets = createTicketService({
    database,
    clock,
    work: { begin: (ticket) => bound?.begin(ticket), stop: (ticket) => bound?.stop(ticket), reassign: (ticket) => bound?.reassign(ticket) },
  });
  work = createWorkService({
    database,
    clock,
    tickets,
    runners,
    credentials: testCredentials,
    tell: (conversation, notice, prompt) => told.push({ conversation, notice, prompt }),
    branchSuffix: () => "beef",
  });
  bound = work;
});

afterEach(() => {
  work.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function working(issues: readonly number[] = [21], machine = "pc", engine: "codex" | "claude" | "dsh" = "codex"): Ticket {
  const title = { en: "Add a greeting", zh: "加一句问候" };
  const summary = { en: "Print hello", zh: "打印问候" };
  const opened = tickets.open({
    repository,
    issues: issues.map((number) => ({ repository, number, url: `https://github.com/${repository}/issues/${number}`, title: { en: `Issue ${number}`, zh: `问题 ${number}` }, summary })),
    title,
    summary,
    kind: "feature",
    conversation: "c-1",
  });
  tickets.change((writes) => {
    writes.choose(opened.id, { machine, engine, model: "gpt-6-luna", effort: "low", by: { machine: "default", engine: "default", model: "default", effort: "default" } });
    writes.move(opened.id, "working");
  });
  const ticket = tickets.get(opened.id);
  if (ticket === undefined) {
    throw new Error("ticket missing");
  }
  return ticket;
}

function emit(machine: string, ticket: number, attempt: number, seq: number, event: WorkEvent): void {
  const message: RunnerWorkEvent = { type: "work.event", ticket, attempt, seq, at: clock.now(), event };
  runners.link?.event(machine, message);
}

function current(id: number): Ticket {
  const ticket = tickets.get(id);
  if (ticket === undefined) {
    throw new Error("ticket missing");
  }
  return ticket;
}

describe("work for a started ticket", () => {
  it("queues the first attempt, starts it on the chosen machine with the owner's token, and begins only once", () => {
    const ticket = working([21, 22]);
    work.begin(ticket);
    expect(current(ticket.id)).toMatchObject({ branch: "sa2/ticket-1-beef", work: { attempt: 1, state: "queued", machine: "pc" } });
    expect(runners.sent).toEqual([]);
    runners.connect("pc", 2);
    const [start] = runners.of("work.start", "pc");
    expect(start?.task).toMatchObject({
      ticket: ticket.id,
      attempt: 1,
      repository,
      account: "novan-xu",
      branch: "sa2/ticket-1-beef",
      issues: [
        { number: 21, title: "Issue 21" },
        { number: 22, title: "Issue 22" },
      ],
      engine: "codex",
      model: "gpt-6-luna",
      effort: "low",
      session: null,
      note: null,
    });
    expect(Object.keys(start?.task.environment ?? {}).sort()).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
    expect(current(ticket.id).work?.state).toBe("preparing");
    work.begin(current(ticket.id));
    work.begin(current(ticket.id));
    expect(runners.of("work.start")).toHaveLength(1);
    expect(current(ticket.id).work?.attempt).toBe(1);
  });

  it("waits for a free slot on a full machine", () => {
    runners.connect("pc", 1);
    const first = working([21]);
    const second = working([22]);
    work.begin(first);
    work.begin(second);
    expect(runners.of("work.start").map((message) => message.task.ticket)).toEqual([first.id]);
    expect(current(second.id).work?.state).toBe("queued");
    emit("pc", first.id, 1, 1, { kind: "failed", failure: "program", reason: "boom" });
    expect(runners.of("work.start").map((message) => message.task.ticket)).toEqual([first.id, second.id]);
  });

  it("stores the worker's output in order, records what ran, the pull request and the report, and moves to verifying", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    const seen: StoredWorkEvent[] = [];
    work.subscribe((event) => seen.push(event));
    emit("pc", ticket.id, 1, 1, { kind: "phase", phase: "preparing", detail: "Preparing" });
    emit("pc", ticket.id, 1, 2, { kind: "phase", phase: "started", detail: "Started" });
    emit("pc", ticket.id, 1, 3, { kind: "session", session: "thread-1" });
    emit("pc", ticket.id, 1, 3, { kind: "session", session: "thread-duplicate" });
    emit("pc", ticket.id, 1, 5, { kind: "text", block: "b", delta: "skipped ahead" });
    expect(runners.of("work.sync")).toEqual([{ type: "work.sync", ticket: ticket.id, attempt: 1, after: 3 }]);
    emit("pc", ticket.id, 1, 4, { kind: "ran", model: "gpt-6-luna", effort: "low" });
    emit("pc", ticket.id, 1, 5, { kind: "text", block: "b", delta: "done" });
    expect(current(ticket.id)).toMatchObject({ state: "working", work: { state: "running", session: "thread-1", last: 5 }, ran: { machine: "pc", engine: "codex", model: "gpt-6-luna", effort: "low" } });
    emit("pc", ticket.id, 1, 6, { kind: "finished", pullRequest: 77, url: `https://github.com/${repository}/pull/77`, report: { en: "Done", zh: "完成了" } });
    expect(current(ticket.id)).toMatchObject({ state: "verifying", pullRequest: 77, report: { en: "Done", zh: "完成了" }, work: { state: "finished" } });
    expect(work.events(ticket.id).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(work.events(ticket.id, seen[2]?.id ?? 0).map((event) => event.seq)).toEqual([4, 5, 6]);
    expect(told).toEqual([]);
  });

  it("records a worker that ends without a pull request and tells the brain with its output", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "text", block: "b", delta: "I could not find the file" });
    emit("pc", ticket.id, 1, 2, { kind: "failed", failure: "no-pull-request", reason: "You have not handed back" });
    expect(current(ticket.id)).toMatchObject({ state: "working", work: { state: "failed", failure: "no-pull-request", reason: "You have not handed back" } });
    expect(told).toHaveLength(1);
    expect(told[0]?.conversation).toBe("c-1");
    expect(told[0]?.prompt).toContain("ended without a pull request");
    expect(told[0]?.prompt).toContain("I could not find the file");
    expect(work.output(ticket.id)).toContain("I could not find the file");
  });

  it("refuses to start without a token and tells the brain", () => {
    work.close();
    work = createWorkService({
      database,
      clock,
      tickets,
      runners,
      credentials: () => ({ ok: false, reason: "GITHUB_TOKEN_NOVAN_XU is not set" }),
      tell: (conversation, notice, prompt) => told.push({ conversation, notice, prompt }),
    });
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    expect(current(ticket.id).work).toMatchObject({ state: "failed", failure: "prepare", reason: "GITHUB_TOKEN_NOVAN_XU is not set" });
    expect(runners.of("work.start")).toEqual([]);
    expect(told[0]?.prompt).toContain("could not prepare");
  });

  it("passes a message to the running worker, and refuses when nothing runs", () => {
    const ticket = working();
    expect(work.message(ticket.id, "hello", "owner")).toEqual({ ok: false, reason: `Ticket ${ticket.id} has no running worker` });
    runners.connect("pc", 2);
    work.begin(ticket);
    const sent = work.message(ticket.id, "Also update the README", "brain");
    expect(sent.ok).toBe(true);
    expect(runners.of("work.message")).toEqual([{ type: "work.message", ticket: ticket.id, attempt: 1, id: sent.ok ? sent.id : "", from: "brain", text: "Also update the README" }]);
    runners.drop("pc");
    expect(work.message(ticket.id, "again", "owner")).toMatchObject({ ok: false });
  });

  it("stops the worker and removes its worktree when the ticket stops, or once it merges", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    tickets.stop(ticket.id, { en: "Not needed", zh: "不需要了" });
    expect(current(ticket.id).work).toMatchObject({ state: "stopped", reason: "Not needed" });
    expect(runners.of("work.stop")).toEqual([{ type: "work.stop", ticket: ticket.id, save: false, remove: true }]);
    const merged = working([30]);
    work.begin(merged);
    emit("pc", merged.id, 1, 1, { kind: "finished", pullRequest: 5, url: "u", report: { en: "Done", zh: "完成" } });
    expect(runners.of("work.stop").filter((message) => message.ticket === merged.id)).toEqual([]);
    tickets.move(merged.id, "merged");
    expect(runners.of("work.stop").filter((message) => message.ticket === merged.id)).toEqual([{ type: "work.stop", ticket: merged.id, save: false, remove: true }]);
  });
});

describe("work across restarts and lost connections", () => {
  it("marks a worker unreachable while its machine is away, then catches up when it is back", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "phase", phase: "started", detail: "Started" });
    clock.advance(1000);
    runners.drop("pc");
    expect(current(ticket.id).work).toMatchObject({ state: "running", unreachableSince: clock.now() });
    runners.connect("pc", 2, [{ ticket: ticket.id, attempt: 1, last: 7, live: true, ended: false }]);
    expect(current(ticket.id).work?.unreachableSince).toBeNull();
    expect(runners.of("work.sync").at(-1)).toEqual({ type: "work.sync", ticket: ticket.id, attempt: 1, after: 1 });
    expect(runners.of("work.start")).toHaveLength(1);
  });

  it("resumes the same session when the runner came back without its worker running", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "phase", phase: "started", detail: "Started" });
    emit("pc", ticket.id, 1, 2, { kind: "session", session: "thread-9" });
    runners.drop("pc");
    runners.connect("pc", 2, [{ ticket: ticket.id, attempt: 1, last: 4, live: false, ended: false }]);
    const starts = runners.of("work.start");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.task).toMatchObject({ attempt: 1, session: "thread-9", note: null });
  });

  it("tells the ticket its worker was lost when the runner comes back without it", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "phase", phase: "started", detail: "Started" });
    runners.drop("pc");
    runners.connect("pc", 2, []);
    expect(current(ticket.id).work).toMatchObject({ state: "failed", failure: "lost" });
    expect(told[0]?.prompt).toContain("was lost");
  });

  it("sends the start again when the runner never received it", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    runners.drop("pc");
    runners.connect("pc", 2, []);
    expect(runners.of("work.start")).toHaveLength(2);
    expect(current(ticket.id).work?.state).toBe("preparing");
  });

  it("has a runner drop work for a ticket that has ended while it was away", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    runners.drop("pc");
    tickets.stop(ticket.id, { en: "Not needed", zh: "不需要了" });
    expect(runners.of("work.stop")).toEqual([]);
    runners.connect("pc", 2, [{ ticket: ticket.id, attempt: 1, last: 3, live: true, ended: false }]);
    expect(runners.of("work.stop")).toEqual([{ type: "work.stop", ticket: ticket.id, save: false, remove: true }]);
  });

  it("marks every running worker unreachable when the hub starts, until its runner says hello", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "phase", phase: "started", detail: "Started" });
    work.resume();
    expect(current(ticket.id).work?.unreachableSince).toBe(clock.now());
  });
});

describe("reassigning and trying again", () => {
  it("restarts on the same machine in a new attempt that continues the work", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "session", session: "thread-1" });
    tickets.change((writes) => writes.choose(ticket.id, { machine: "pc", engine: "codex", model: "gpt-6.1-sol", effort: "high", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } }));
    work.reassign(current(ticket.id));
    const starts = runners.of("work.start");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.task).toMatchObject({ attempt: 2, model: "gpt-6.1-sol", effort: "high", session: "thread-1", branch: "sa2/ticket-1-beef" });
    expect(starts[1]?.task.note).toContain("reassigned");
    expect(current(ticket.id).work).toMatchObject({ attempt: 2, state: "preparing" });
  });

  it("moves to another machine only after the first has saved its work", () => {
    runners.connect("pc", 2);
    runners.connect("mac", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "session", session: "thread-1" });
    tickets.change((writes) => writes.choose(ticket.id, { machine: "mac", engine: "claude", model: "claude-opus-5-5", effort: "high", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } }));
    work.reassign(current(ticket.id));
    expect(runners.of("work.stop", "pc")).toEqual([{ type: "work.stop", ticket: ticket.id, save: true, remove: true }]);
    expect(runners.of("work.start", "mac")).toEqual([]);
    emit("pc", ticket.id, 1, 2, { kind: "stopped", saved: true, detail: "Pushed the branch" });
    const [start] = runners.of("work.start", "mac");
    expect(start?.task).toMatchObject({ attempt: 2, engine: "claude", session: null, branch: "sa2/ticket-1-beef" });
    expect(start?.task.note).toContain("moved this ticket here from pc");
  });

  it("starts again on the same branch after a pull request, resuming the session, for the rounds to come", () => {
    runners.connect("pc", 2);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, 1, { kind: "session", session: "thread-1" });
    emit("pc", ticket.id, 1, 2, { kind: "finished", pullRequest: 5, url: "u", report: { en: "Done", zh: "完成" } });
    expect(current(ticket.id).state).toBe("verifying");
    const outcome = work.again(ticket.id, "The pipeline failed in the lint step; fix it and push.");
    expect(outcome.ok).toBe(true);
    expect(current(ticket.id)).toMatchObject({ state: "working", work: { attempt: 2 } });
    expect(runners.of("work.start")[1]?.task).toMatchObject({ attempt: 2, session: "thread-1", note: "The pipeline failed in the lint step; fix it and push." });
    expect(work.again(ticket.id, "again")).toEqual({ ok: false, reason: `Ticket ${ticket.id} already has a worker` });
  });
});
