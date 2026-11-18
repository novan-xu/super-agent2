import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "@super-agent2/catalog";
import type { AllowanceReading, MachineStatus, ProgramId, Provider, RunnerWorkEvent, Ticket, WorkEvent } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HubDatabase, openDatabase } from "./database.js";
import { createStartDefaults, type StartDefaults } from "./defaults.js";
import { TestClock } from "./testing/access.js";
import { testCredentials } from "./testing/commands.js";
import { FakeRunners } from "./testing/runners.js";
import { createTicketService, type TicketService } from "./tickets.js";
import { createWorkService, type WorkService } from "./work.js";

const repository = "novan-xu/super-agent-sandbox";

type Offers = Partial<Record<ProgramId, readonly [string, string]>>;

const complex: Offers = { claude: ["claude-opus-5-5", "high"], codex: ["gpt-6.1-sol", "high"], dsh: ["deepseek-flash", "max"] };

let dataDir: string;
let clock: TestClock;
let database: HubDatabase;
let tickets: TicketService;
let runners: FakeRunners;
let defaults: StartDefaults;
let work: WorkService;
let statuses: Map<string, MachineStatus>;
let order: Provider[] | undefined;
let told: { readonly ticket: number; readonly notice: string; readonly prompt: string }[];
let tick: (() => void) | undefined;
let seqs: Map<string, number>;

function status(name: string, platform: "win32" | "darwin", offers: Offers, allowances: AllowanceReading[] = []): MachineStatus {
  return {
    name,
    online: true,
    createdAt: 0,
    lastSeenAt: 0,
    report: {
      hostname: name,
      platform,
      release: "1",
      arch: "x64",
      user: "owner",
      slots: { total: 2, free: 2 },
      programs: (Object.entries(offers) as [ProgramId, readonly [string, string]][]).map(([id, [model, effort]]) => ({
        id,
        installed: true,
        path: null,
        version: null,
        models: [{ id: model, efforts: [effort] }],
        source: "program" as const,
        problem: null,
      })),
      allowances,
    },
  };
}

function machine(name: string, platform: "win32" | "darwin", offers: Offers, allowances: AllowanceReading[] = []): void {
  statuses.set(name, status(name, platform, offers, allowances));
  runners.connect(name, 2);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-switch-"));
  clock = new TestClock();
  database = openDatabase({ dataDir, clock });
  runners = new FakeRunners();
  statuses = new Map();
  order = undefined;
  told = [];
  tick = undefined;
  seqs = new Map();
  defaults = createStartDefaults({ database, clock, statuses: () => [...statuses.values()], providerOrder: () => order });
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
    defaults,
    ticker: (run) => {
      tick = run;
      return () => {
        tick = undefined;
      };
    },
    tell: (ticket, notice, prompt) => told.push({ ticket, notice, prompt }),
    branchSuffix: () => "beef",
  });
  bound = work;
  work.resume();
});

afterEach(() => {
  work.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface Opened {
  readonly issues?: readonly number[];
  readonly machine?: string;
  readonly engine?: ProgramId;
  readonly by?: "default" | "owner";
  readonly form?: "code" | "task";
}

function working({ issues = [21], machine: where = "pc", engine = "claude", by = "default", form = "code" }: Opened = {}): Ticket {
  const title = { en: "Add a greeting", zh: "加一句问候" };
  const summary = { en: "Print hello", zh: "打印问候" };
  const opened =
    form === "task"
      ? tickets.open({ form: "task", task: { task: "Translate the notice", materials: [] }, repository: null, issues: [], title, summary, kind: "writing", difficulty: "complex", platform: "any", conversation: "c-1" })
      : tickets.open({
          repository,
          issues: issues.map((number) => ({ repository, number, url: `https://github.com/${repository}/issues/${number}`, title: { en: `Issue ${number}`, zh: `问题 ${number}` }, summary })),
          title,
          summary,
          kind: "feature",
          difficulty: "complex",
          platform: "any",
          conversation: "c-1",
        });
  const model = engine === "claude" ? "claude-opus-5-5" : engine === "codex" ? "gpt-6.1-sol" : engine === "dsh" ? "deepseek-flash" : "gemini-3.8-flash";
  tickets.change((writes) => {
    writes.choose(opened.id, {
      machine: where,
      engine,
      model,
      effort: engine === "dsh" ? "max" : "high",
      by: { machine: "default", engine: by, model: "default", effort: "default" },
    });
    writes.move(opened.id, "working");
  });
  return current(opened.id);
}

function current(id: number): Ticket {
  const ticket = tickets.get(id);
  if (ticket === undefined) {
    throw new Error("ticket missing");
  }
  return ticket;
}

function emit(machineName: string, ticket: number, attempt: number, event: WorkEvent): void {
  const key = `${ticket}:${attempt}`;
  const seq = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, seq);
  const message: RunnerWorkEvent = { type: "work.event", ticket, attempt, seq, at: clock.now(), event };
  runners.link?.event(machineName, message);
}

function started(machineName: string, ticket: number, attempt: number): void {
  emit(machineName, ticket, attempt, { kind: "phase", phase: "started", detail: "Started" });
}

function limit(until: number | null = clock.now() + 3_600_000, reason = "You've hit your limit", unsent: string[] = []): WorkEvent {
  return { kind: "unavailable", reason, until, unsent };
}

function starts() {
  return runners.of("work.start");
}

function attemptOf(id: number, attempt: number) {
  return tickets.detail(id)?.attempts.find((entry) => entry.attempt === attempt);
}

function switches(id: number) {
  return tickets.switches(id);
}

describe("a worker whose program becomes unavailable", () => {
  it("continues a chain's second pull request on the next provider on the same machine, without a failure, a guided round or a word to the brain", () => {
    machine("pc", "win32", complex);
    const ticket = working({ issues: [21, 22] });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, {
      kind: "finished",
      pullRequest: 7,
      url: `https://github.com/${repository}/pull/7`,
      closes: [21],
      report: { en: "First", zh: "第一个" },
      decisions: [{ chosen: { en: "Used a plain loop", zh: "用了普通循环" }, why: { en: "It is the simplest", zh: "最简单" }, otherOptions: { en: "A recursive helper", zh: "递归函数" } }],
    });
    tickets.change((writes) => writes.pullRequestMerged(ticket.id, { number: 7, closes: [21], mergeCommit: "c0ffee", deployment: null }));
    expect(work.onward(ticket.id, { pullRequest: 7, mergeCommit: "c0ffee", closes: [21], base: "main" })).toMatchObject({ ok: true });
    started("pc", ticket.id, 2);
    const given = work.message(ticket.id, "Use the new endpoint", "owner");
    expect(given.ok).toBe(true);
    emit("pc", ticket.id, 2, { kind: "message", id: given.ok ? given.id : "", from: "owner", text: "Use the new endpoint", delivery: "steered" });
    emit("pc", ticket.id, 2, { kind: "text", block: "b", delta: "Working on issue 22 with the new endpoint" });
    emit("pc", ticket.id, 2, { kind: "session", session: "claude-session" });
    const until = clock.now() + 3_600_000;
    emit("pc", ticket.id, 2, limit(until));

    const after = current(ticket.id);
    expect(after).toMatchObject({ state: "working", round: 0, freeRetry: false, engine: "codex", model: "gpt-6.1-sol", effort: "high", machine: "pc", work: { attempt: 3, engine: "codex", state: "preparing" } });
    expect(after.chosenBy).toEqual({ machine: "default", engine: "default", model: "default", effort: "default" });
    expect(attemptOf(ticket.id, 2)).toMatchObject({ state: "unavailable", failure: null, reason: "You've hit your limit", engine: "claude" });
    expect(told).toEqual([]);
    expect(tickets.rounds(ticket.id)).toEqual([]);

    const third = starts().at(-1);
    expect(third?.task).toMatchObject({ attempt: 3, engine: "codex", model: "gpt-6.1-sol", effort: "high", session: null, takeover: true, branch: after.branch });
    const note = third?.task.note ?? "";
    expect(note).toContain("Claude Code");
    expect(note).toContain("You've hit your limit");
    expect(note).toContain("#7 (merged, closes #21)");
    expect(note).toContain("Issues closed by merged pull requests: #21. Still open: #22.");
    expect(note).toContain("the owner: Use the new endpoint");
    expect(note).toContain("Working on issue 22 with the new endpoint");
    expect(note).toContain("You are Codex");
    expect(note).toContain("Decisions already recorded for this ticket (1)");
    expect(note).toContain("Chosen: Used a plain loop");
    expect(note).toContain("do not hand them in again");

    expect(switches(ticket.id)).toEqual([
      { ticket: ticket.id, seq: 1, kind: "switched", at: clock.now(), from: "claude", to: "codex", machine: "pc", model: "gpt-6.1-sol", effort: "high", reason: "You've hit your limit", until: null, owner: false, attempt: 3 },
    ]);
    expect(defaults.unavailable()).toEqual([{ program: "claude", reason: "You've hit your limit", since: clock.now(), until, given: true }]);
    expect(tickets.detail(ticket.id)?.switches).toHaveLength(1);
  });

  it("goes to another machine when this one lacks the next program, only after the first has saved its work", () => {
    machine("pc", "win32", { claude: complex.claude as readonly [string, string] });
    machine("mini", "darwin", { codex: complex.codex as readonly [string, string] });
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit());
    expect(runners.of("work.stop", "pc")).toEqual([{ type: "work.stop", ticket: ticket.id, save: true, remove: true }]);
    expect(starts()).toHaveLength(1);
    expect(current(ticket.id)).toMatchObject({ machine: "mini", engine: "codex", work: { attempt: 2, state: "queued", machine: "mini" } });
    emit("pc", ticket.id, 1, { kind: "stopped", saved: true, detail: "Pushed the branch" });
    expect(starts()).toHaveLength(2);
    expect(runners.of("work.start", "mini")[0]?.task).toMatchObject({ attempt: 2, engine: "codex", takeover: true });
    expect(runners.of("work.start", "mini")[0]?.task.note).toContain("from where the folder reached you through the branch");
    expect(switches(ticket.id)[0]).toMatchObject({ kind: "switched", from: "claude", to: "codex", machine: "mini" });
  });

  it("keeps a task ticket on its machine and takes the next provider that machine has", () => {
    machine("pc", "win32", { claude: complex.claude as readonly [string, string], dsh: complex.dsh as readonly [string, string] });
    machine("mini", "darwin", { codex: complex.codex as readonly [string, string] });
    const ticket = working({ form: "task" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit());
    expect(runners.of("work.stop")).toEqual([]);
    expect(runners.of("work.task", "pc").at(-1)?.task).toMatchObject({ attempt: 2, engine: "dsh", model: "deepseek-flash", effort: "max", takeover: true });
  });

  it("falls to dsh only when both Claude and Codex are unavailable", () => {
    machine("pc", "win32", complex);
    defaults.markUnavailable("codex", "Usage limit", clock.now() + 1_000_000);
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit());
    expect(current(ticket.id)).toMatchObject({ engine: "dsh", model: "deepseek-flash", effort: "max", work: { attempt: 2, engine: "dsh" } });
  });

  it("follows the owner's order of providers", () => {
    order = ["gpt", "claude", "deepseek"];
    machine("pc", "win32", complex);
    const ticket = working({ engine: "codex" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit());
    expect(current(ticket.id)).toMatchObject({ engine: "claude", model: "claude-opus-5-5" });
  });

  it("does not count an error or a crash as unavailable", () => {
    machine("pc", "win32", complex);
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, { kind: "failed", failure: "program", reason: "The program crashed" });
    expect(current(ticket.id).work).toMatchObject({ attempt: 1, state: "failed", failure: "program" });
    expect(defaults.unavailable()).toEqual([]);
    expect(told).toHaveLength(1);
    expect(switches(ticket.id)).toEqual([]);
  });

  it("fails, saying so, when no provider is offered with the table's model and effort", () => {
    machine("pc", "win32", { claude: ["claude-opus-5-5", "high"] });
    const ticket = working();
    tickets.change((writes) => writes.choose(ticket.id, { machine: "pc", engine: "claude", model: "an-unlisted-model", effort: "high", by: { machine: "default", engine: "default", model: "default", effort: "default" } }));
    statuses.set("pc", status("pc", "win32", {}));
    work.begin(current(ticket.id));
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit());
    expect(current(ticket.id).work).toMatchObject({ state: "failed", failure: "program" });
    expect(current(ticket.id).work?.reason).toContain("no other provider could take the work");
    expect(told).toHaveLength(1);
  });

  it("does nothing special when the hub has no start defaults to route with: the attempt fails as before", () => {
    work.close();
    work = createWorkService({ database, clock, tickets, runners, credentials: testCredentials, tell: (ticket, notice, prompt) => told.push({ ticket, notice, prompt }), branchSuffix: () => "beef" });
    machine("pc", "win32", complex);
    const ticket = working();
    work.begin(ticket);
    emit("pc", ticket.id, 1, limit());
    expect(current(ticket.id).work).toMatchObject({ state: "failed", failure: "program", reason: "You've hit your limit" });
    expect(told).toHaveLength(1);
  });
});

describe("messages and files for the earlier worker", () => {
  it("gives the new worker the messages the earlier one had not read yet, and the files it was sent, again", () => {
    machine("pc", "win32", complex);
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    const photo = { id: "a".repeat(32), name: "photo.png", size: 10, mediaType: "image/png" };
    const first = work.message(ticket.id, "See the photo", "owner", [photo]);
    emit("pc", ticket.id, 1, { kind: "message", id: first.ok ? first.id : "", from: "owner", text: "See the photo", attachments: [photo], delivery: "steered" });
    const second = work.message(ticket.id, "Also keep it short", "owner");
    emit("pc", ticket.id, 1, { kind: "message", id: second.ok ? second.id : "", from: "owner", text: "Also keep it short", delivery: "queued" });
    emit("pc", ticket.id, 1, limit(null, "overloaded", [second.ok ? second.id : ""]));
    const note = starts().at(-1)?.task.note ?? "";
    expect(note).toContain("the owner: See the photo (attached: photo.png");
    expect(note).toContain("1 message(s) it had not read yet are delivered to you right after this note.");
    expect(note).not.toContain("the owner: Also keep it short");
    const delivered = runners.of("work.message").filter((message) => message.attempt === 2);
    expect(delivered.map((message) => [message.from, message.text])).toEqual([
      ["owner", "Also keep it short"],
      ["hub", "These files were given to the earlier worker with the owner's messages. Here they are again for you."],
    ]);
    expect(delivered[1]?.attachments).toEqual([photo]);
  });
});

describe("what the hub remembers about an unavailable provider", () => {
  it("marks it until the time the program gave, and shows it with its reason", () => {
    machine("pc", "win32", complex);
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    const until = clock.now() + 600_000;
    emit("pc", ticket.id, 1, limit(until, "Usage limit"));
    expect(defaults.unavailable()).toEqual([{ program: "claude", reason: "Usage limit", since: clock.now(), until, given: true }]);
    clock.advance(600_000);
    expect(defaults.unavailable()).toEqual([]);
  });

  it("holds a mark with no time for the retry interval, so a provider with no readings is tried again", () => {
    machine("pc", "win32", complex);
    const ticket = working({ engine: "dsh" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit(null, "ACCOUNT_SIGN_IN_REQUIRED"));
    expect(defaults.unavailable()).toEqual([{ program: "dsh", reason: "ACCOUNT_SIGN_IN_REQUIRED", since: clock.now(), until: clock.now() + 600_000, given: false }]);
    clock.advance(600_000);
    expect(defaults.unavailable()).toEqual([]);
  });

  it("makes new tickets default to another provider instead of failing over one by one, and never from an unknown reading", () => {
    const unknown: AllowanceReading = { program: "claude", readAt: clock.now(), state: "unknown", remainingPercent: null, resetsAt: null, windows: [], problem: "no machine could ask" };
    machine("pc", "win32", complex, [unknown]);
    const pending = tickets.open({
      repository,
      issues: [{ repository, number: 5, url: `https://github.com/${repository}/issues/5`, title: { en: "Five", zh: "五" }, summary: { en: "s", zh: "摘要" } }],
      title: { en: "Five", zh: "五" },
      summary: { en: "s", zh: "摘要" },
      kind: "feature",
      difficulty: "complex",
      platform: "any",
      conversation: "c-1",
    });
    tickets.change((writes) => writes.state(pending.id, { kind: "feature", difficulty: "complex", difficultyReason: { en: "r", zh: "理由" }, platform: "any", brainEngine: "claude" }));
    expect(defaults.resolve(current(pending.id))).toMatchObject({ engine: "claude", model: "claude-opus-5-5" });
    defaults.markUnavailable("claude", "Usage limit", clock.now() + 600_000);
    expect(defaults.resolve(current(pending.id))).toMatchObject({ engine: "codex", model: "gpt-6.1-sol" });
    defaults.markUnavailable("codex", "Usage limit", clock.now() + 600_000);
    expect(defaults.resolve(current(pending.id))).toMatchObject({ engine: "dsh", model: "deepseek-flash", effort: "max" });
    expect(defaults.subscriptions().claude.state).toBe("unknown");
  });

  it("clears when a reading taken afterwards shows the subscription available", () => {
    machine("pc", "win32", complex);
    defaults.markUnavailable("claude", "Usage limit", clock.now() + 3_600_000);
    expect(defaults.unavailable()).toHaveLength(1);
    clock.advance(1_000);
    const reading: AllowanceReading = { program: "claude", readAt: clock.now(), state: "available", remainingPercent: 80, resetsAt: null, windows: [], problem: null };
    statuses.set("pc", status("pc", "win32", complex, [reading]));
    expect(defaults.unavailable()).toEqual([]);
  });

  it("clears when a later attempt on that program succeeds", () => {
    machine("pc", "win32", complex);
    const ticket = working({ engine: "codex" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    clock.advance(1_000);
    defaults.markUnavailable("codex", "Overloaded", null);
    clock.advance(1_000);
    emit("pc", ticket.id, 1, { kind: "phase", phase: "checking", detail: "Checking" });
    expect(defaults.unavailable()).toEqual([]);
  });

  it("keeps the mark when the event that follows is older than the mark", () => {
    machine("pc", "win32", complex);
    const ticket = working({ engine: "codex" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    const earlier = clock.now();
    clock.advance(1_000);
    defaults.markUnavailable("codex", "Overloaded", null);
    runners.link?.event("pc", { type: "work.event", ticket: ticket.id, attempt: 1, seq: 99, at: earlier, event: { kind: "phase", phase: "checking", detail: "Checking" } });
    runners.link?.event("pc", { type: "work.event", ticket: ticket.id, attempt: 1, seq: 2, at: earlier, event: { kind: "phase", phase: "checking", detail: "Checking" } });
    expect(defaults.unavailable()).toHaveLength(1);
  });
});

describe("a started ticket whose provider is already marked", () => {
  it("switches away from the owner's own choice at once, and the timeline says it was the owner's", () => {
    machine("pc", "win32", complex);
    defaults.markUnavailable("codex", "Usage limit", clock.now() + 600_000);
    const ticket = working({ engine: "codex", by: "owner" });
    work.begin(ticket);
    expect(attemptOf(ticket.id, 1)).toMatchObject({ engine: "codex", state: "unavailable", reason: "Usage limit" });
    expect(current(ticket.id)).toMatchObject({ engine: "claude", model: "claude-opus-5-5", work: { attempt: 2, engine: "claude" } });
    expect(starts()).toHaveLength(1);
    expect(starts()[0]?.task).toMatchObject({ attempt: 2, engine: "claude", takeover: false, note: null });
    expect(switches(ticket.id)).toEqual([
      { ticket: ticket.id, seq: 1, kind: "switched", at: clock.now(), from: "codex", to: "claude", machine: "pc", model: "claude-opus-5-5", effort: "high", reason: "Usage limit", until: null, owner: true, attempt: 2 },
    ]);
    expect(told).toEqual([]);
  });

  it("keeps the brain's guidance for a worker that never ran when its program is unavailable at the start of a guided round", () => {
    machine("pc", "win32", complex);
    const ticket = working({ engine: "claude" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, { kind: "failed", failure: "no-pull-request", reason: "No hand-back" });
    defaults.markUnavailable("claude", "Usage limit", clock.now() + 600_000);
    expect(work.again(ticket.id, "Round 1: hand back the pull request", { en: "Round", zh: "轮" }, undefined)).toMatchObject({ ok: true });
    const next = starts().at(-1)?.task;
    expect(next).toMatchObject({ engine: "codex", takeover: true });
    expect(next?.note).toContain("was unavailable (Usage limit)");
    expect(next?.note).toContain("Round 1: hand back the pull request");
  });
});

describe("when every provider is unavailable", () => {
  it("waits, tells the brain once, and goes on by itself when the earliest time passes", () => {
    machine("pc", "win32", complex);
    defaults.markUnavailable("codex", "Usage limit", clock.now() + 1_800_000);
    defaults.markUnavailable("dsh", "Quota", clock.now() + 7_200_000);
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit(clock.now() + 3_600_000));
    expect(current(ticket.id)).toMatchObject({ state: "working", work: { attempt: 1, state: "unavailable" } });
    expect(starts()).toHaveLength(1);
    expect(switches(ticket.id)).toHaveLength(1);
    expect(switches(ticket.id)[0]).toMatchObject({ kind: "waiting", from: "claude", to: null, until: clock.now() + 1_800_000, attempt: 1 });
    expect(told).toHaveLength(1);
    expect(told[0]?.notice).toBe(text("notice.waitingForProvider", { ticket: ticket.id }));
    expect(told[0]?.prompt).toContain("waits for a provider");
    tick?.();
    tick?.();
    expect(told).toHaveLength(1);
    expect(switches(ticket.id)).toHaveLength(1);
    clock.advance(1_800_000);
    tick?.();
    expect(current(ticket.id)).toMatchObject({ state: "working", engine: "codex", work: { attempt: 2, engine: "codex" } });
    expect(switches(ticket.id).map((entry) => [entry.kind, entry.to])).toEqual([
      ["waiting", null],
      ["switched", "codex"],
    ]);
    expect(told).toHaveLength(1);
    expect(current(ticket.id).round).toBe(0);
  });

  it("tells the brain once while the retries keep failing at once, and again only after the ticket has made progress", () => {
    machine("pc", "win32", complex);
    const ticket = working({ engine: "dsh" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit(null, "offline"));
    expect(current(ticket.id).work).toMatchObject({ attempt: 2, engine: "claude" });
    emit("pc", ticket.id, 2, limit(null, "offline"));
    emit("pc", ticket.id, 3, limit(null, "offline"));
    expect(current(ticket.id).work).toMatchObject({ attempt: 3, state: "unavailable" });
    expect(told).toHaveLength(1);
    clock.advance(600_000);
    tick?.();
    expect(current(ticket.id).work).toMatchObject({ attempt: 4, engine: "claude" });
    emit("pc", ticket.id, 4, limit(null, "offline"));
    emit("pc", ticket.id, 5, limit(null, "offline"));
    emit("pc", ticket.id, 6, limit(null, "offline"));
    expect(current(ticket.id).work).toMatchObject({ attempt: 6, state: "unavailable" });
    expect(told).toHaveLength(1);
    expect(switches(ticket.id).filter((entry) => entry.kind === "waiting")).toHaveLength(1);
    clock.advance(600_000);
    tick?.();
    started("pc", ticket.id, 7);
    emit("pc", ticket.id, 7, { kind: "text", block: "b", delta: "It works again" });
    emit("pc", ticket.id, 7, limit(null, "offline again"));
    emit("pc", ticket.id, 8, limit(null, "offline again"));
    emit("pc", ticket.id, 9, limit(null, "offline again"));
    expect(current(ticket.id).work).toMatchObject({ attempt: 9, state: "unavailable" });
    expect(told).toHaveLength(2);
  });

  it("goes on with the same program, in the same session, once its own mark has passed", () => {
    machine("pc", "win32", { claude: complex.claude as readonly [string, string] });
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, { kind: "session", session: "claude-session" });
    emit("pc", ticket.id, 1, limit(clock.now() + 600_000));
    expect(current(ticket.id).work?.state).toBe("unavailable");
    clock.advance(600_000);
    tick?.();
    const next = starts().at(-1)?.task;
    expect(next).toMatchObject({ attempt: 2, engine: "claude", session: "claude-session", takeover: false });
    expect(next?.note).toContain("available again");
    expect(switches(ticket.id).map((entry) => entry.kind)).toEqual(["waiting", "resumed"]);
  });

  it("tries a provider again after a reading shows it back, without waiting for its time", () => {
    machine("pc", "win32", { claude: complex.claude as readonly [string, string] });
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit(clock.now() + 36_000_000));
    expect(current(ticket.id).work?.state).toBe("unavailable");
    clock.advance(5_000);
    const reading: AllowanceReading = { program: "claude", readAt: clock.now(), state: "available", remainingPercent: 100, resetsAt: null, windows: [], problem: null };
    statuses.set("pc", status("pc", "win32", { claude: complex.claude as readonly [string, string] }, [reading]));
    runners.connect("pc", 2, [{ ticket: ticket.id, attempt: 1, last: 4, live: false, ended: true }]);
    expect(current(ticket.id).work).toMatchObject({ attempt: 2, engine: "claude" });
  });

  it("does not hand a ticket back and forth between two providers that both flap", () => {
    machine("pc", "win32", { claude: complex.claude as readonly [string, string], codex: complex.codex as readonly [string, string] });
    const ticket = working();
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit(clock.now() + 600_000));
    expect(current(ticket.id).work).toMatchObject({ attempt: 2, engine: "codex" });
    started("pc", ticket.id, 2);
    emit("pc", ticket.id, 2, limit(clock.now() + 600_000, "Codex usage limit"));
    expect(current(ticket.id).work).toMatchObject({ attempt: 2, state: "unavailable" });
    expect(starts()).toHaveLength(2);
    expect(switches(ticket.id).map((entry) => entry.kind)).toEqual(["switched", "waiting"]);
  });

  it("sends prose that Antigravity cannot take to the code providers in the owner's order", () => {
    machine("pc", "win32", { ...complex, antigravity: ["gemini-3.8-flash", "high"] });
    const ticket = working({ form: "task", engine: "antigravity" });
    work.begin(ticket);
    started("pc", ticket.id, 1);
    emit("pc", ticket.id, 1, limit(null, "RESOURCE_EXHAUSTED"));
    expect(current(ticket.id)).toMatchObject({ engine: "claude", model: "claude-opus-5-5", work: { attempt: 2, engine: "claude" } });
    expect(defaults.unavailable().map((mark) => mark.program)).toEqual(["antigravity"]);
  });
});

describe("DeepSeek balance routing", () => {
  it("holds an empty balance through a failed read and clears it when money returns", () => {
    const balance = (amount: number, readAt: number): AllowanceReading => ({ program: "dsh", readAt, available: true, wallets: [{ currency: "CNY", total: amount, granted: 0, toppedUp: amount }], problem: null });
    machine("pc", "win32", complex, [balance(0, clock.now())]);
    expect(defaults.out().has("dsh")).toBe(true);
    clock.advance(1000);
    machine("pc", "win32", complex, [{ program: "dsh", readAt: clock.now(), available: null, wallets: [], problem: "failed" }]);
    expect(defaults.balance().state).toBe("unknown");
    expect(defaults.out().has("dsh")).toBe(true);
    clock.advance(1000);
    machine("mini", "darwin", complex, [balance(50, clock.now())]);
    expect(defaults.balance().state).toBe("ok");
    expect(defaults.out().has("dsh")).toBe(false);
  });
});
