import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenOptions, ProgramEvent, ProgramHandle, ProgramListener, ProgramSettings, SteerResult, WorkerAdapter } from "@super-agent2/programs";
import type { RunnerToHub, RunnerWorkEvent, WorkEngine, WorkEvent, WorkTask, WritingTask } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type ProcessRunner, runProcess } from "./git.js";
import type { PullRequestState } from "./handback.js";
import { tokenVariable } from "./identity.js";
import { workPaths } from "./workplace.js";
import { createWorks, type Works, type WorksOptions } from "./works.js";
import { writingPaths } from "./writing.js";

class Recorder<T> {
  readonly items: T[] = [];
  private waiters: { readonly check: () => boolean; readonly resolve: () => void }[] = [];

  push(item: T): void {
    this.items.push(item);
    this.settle();
  }

  settle(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.check()) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }

  until(check: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (check()) {
        resolve();
        return;
      }
      this.waiters.push({ check, resolve });
    });
  }
}

class FakeHandle implements ProgramHandle {
  readonly prompts: string[] = [];
  readonly steered: string[] = [];
  closed = false;
  running = false;

  constructor(
    readonly fake: FakePrograms,
    readonly engine: WorkEngine,
    readonly settings: ProgramSettings,
    readonly options: OpenOptions,
    readonly listener: ProgramListener,
  ) {}

  start(prompt: string): void {
    this.running = true;
    this.prompts.push(prompt);
    this.fake.changed.push(this);
  }

  steer(text: string): Promise<SteerResult> {
    if (this.fake.steer === "queued" || !this.running) {
      return Promise.resolve("queued");
    }
    this.steered.push(text);
    this.fake.changed.push(this);
    return Promise.resolve("steered");
  }

  interrupt(): void {
    return;
  }

  close(): Promise<void> {
    this.closed = true;
    this.running = false;
    this.fake.changed.push(this);
    return Promise.resolve();
  }

  processId(): number | undefined {
    return undefined;
  }

  emit(event: ProgramEvent): void {
    if (event.type === "turn.finished" || event.type === "failed" || event.type === "unavailable") {
      this.running = false;
    }
    this.listener(event);
  }
}

class FakePrograms {
  readonly handles: FakeHandle[] = [];
  readonly changed = new Recorder<FakeHandle>();
  steer: SteerResult = "steered";

  readonly factory = (engine: WorkEngine, settings: ProgramSettings): WorkerAdapter => ({
    provider: engine === "codex" ? "gpt" : engine === "claude" ? "claude" : engine === "dsh" ? "deepseek" : "antigravity",
    model: settings.model,
    effort: settings.effort,
    open: (options, listener) => {
      const handle = new FakeHandle(this, engine, settings, options, listener);
      this.handles.push(handle);
      this.changed.push(handle);
      return handle;
    },
  });

  last(): FakeHandle {
    const handle = this.handles.at(-1);
    if (handle === undefined) {
      throw new Error("no program was opened");
    }
    return handle;
  }

  prompted(count: number, handle?: FakeHandle): Promise<FakeHandle> {
    return this.changed.until(() => (handle ?? this.handles.at(-1))?.prompts.length === count).then(() => handle ?? this.last());
  }
}

const repository = "novan-xu/super-agent-sandbox";
const token = "test-worker-token";
const identity = {
  GIT_AUTHOR_NAME: "Test Owner",
  GIT_AUTHOR_EMAIL: "owner@example.com",
  GIT_COMMITTER_NAME: "Test Owner",
  GIT_COMMITTER_EMAIL: "owner@example.com",
};

let scratch: string;
let home: string;
let remote: string;
let programs: FakePrograms;
let sent: Recorder<RunnerToHub>;
let pulls: Map<number, PullRequestState>;
let ghCalls: string[][];
let opened: Works[];

const inheritedCredentials: Record<string, string> = {
  GH_TOKEN: "inherited-gh-token",
  GITHUB_TOKEN: "inherited-github-token",
  GH_ENTERPRISE_TOKEN: "inherited-gh-enterprise-token",
  GITHUB_ENTERPRISE_TOKEN: "inherited-github-enterprise-token",
  SUPERAGENT2_GITHUB_AUTH: "inherited-auth",
  RUNNER_TOKEN: "inherited-runner-token",
  ACCESS_CLIENT_ID: "inherited-client-id",
  ACCESS_CLIENT_SECRET: "inherited-client-secret",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "inherited-helper",
};

function carried(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => inheritedCredentials[name] === value)
    .map(([name]) => name);
}

const git = (cwd: string) => createGit(runProcess, { ...(process.env as Record<string, string>), ...identity });

const run: ProcessRunner = (command, args, options) => {
  if (command === "gh-for-tests") {
    ghCalls.push([...args]);
    return Promise.resolve({ code: 1, stdout: "", stderr: "no network in tests" });
  }
  return runProcess(command, args, options);
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "runner-works-"));
  home = join(scratch, "home");
  remote = join(scratch, "remote.git");
  const seed = join(scratch, "seed");
  programs = new FakePrograms();
  sent = new Recorder();
  pulls = new Map();
  ghCalls = [];
  opened = [];
  mkdirSync(seed, { recursive: true });
  const repo = git(seed);
  await repo.must(["init", "--bare", "--initial-branch=main", remote], scratch);
  await repo.must(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), "sandbox\n");
  await repo.must(["add", "README.md"], seed);
  await repo.must(["commit", "-m", "Start"], seed);
  await repo.must(["remote", "add", "origin", remote], seed);
  await repo.must(["push", "origin", "main"], seed);
});

afterEach(async () => {
  for (const works of opened.splice(0)) {
    await works.close();
  }
  rmSync(scratch, { recursive: true, force: true });
});

function start(overrides: Partial<WorksOptions> = {}): Works {
  const works = createWorks({
    home,
    environment: { ...process.env, ...inheritedCredentials, ...identity },
    send: (message) => sent.push(message),
    now: () => 1_000,
    adapters: programs.factory,
    findProgram: (executable) => (executable === "gh" ? "gh-for-tests" : executable === "git" ? undefined : `/programs/${executable}`),
    run,
    remote: () => remote,
    readPullRequest: (_repository, number) => Promise.resolve(pulls.get(number) ?? `no pull request ${number}`),
    ...overrides,
  });
  opened.push(works);
  return works;
}

function task(ticket: number, overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    ticket,
    attempt: 1,
    repository,
    account: "novan-xu",
    branch: `sa2/ticket-${ticket}-abcd`,
    title: `Chain ${ticket}`,
    issues: [
      { number: 11, title: "First issue", url: "https://github.com/novan-xu/super-agent-sandbox/issues/11" },
      { number: 12, title: "Second issue", url: "https://github.com/novan-xu/super-agent-sandbox/issues/12" },
    ],
    engine: "codex",
    model: "gpt-6-luna",
    effort: "low",
    session: null,
    note: null,
    environment: { GH_TOKEN: token, GITHUB_TOKEN: token },
    ...overrides,
  };
}

function events(ticket: number, attempt = 1): RunnerWorkEvent[] {
  return sent.items.filter((message): message is RunnerWorkEvent => message.type === "work.event" && message.ticket === ticket && message.attempt === attempt);
}

function kinds(ticket: number, attempt = 1): string[] {
  return events(ticket, attempt).map((message) => (message.event.kind === "phase" ? `phase:${message.event.phase}` : message.event.kind));
}

function ended(ticket: number, attempt = 1): Promise<WorkEvent> {
  return sent
    .until(() => events(ticket, attempt).some((message) => ["finished", "delivered", "failed", "stopped"].includes(message.event.kind)))
    .then(() => {
      const last = events(ticket, attempt).find((message) => ["finished", "delivered", "failed", "stopped"].includes(message.event.kind));
      if (last === undefined) {
        throw new Error("no ending");
      }
      return last.event;
    });
}

function handBack(ticket: number, pullRequest: number, closes: readonly number[], branch = `sa2/ticket-${ticket}-abcd`, mark = ""): void {
  const paths = workPaths(home, repository, ticket);
  mkdirSync(paths.folder, { recursive: true });
  writeFileSync(paths.handback, mark + JSON.stringify({ pullRequest, summary: { en: "Did both issues", zh: "两个问题都做完了" } }));
  pulls.set(pullRequest, { number: pullRequest, url: `https://github.com/${repository}/pull/${pullRequest}`, state: "OPEN", head: branch, closes });
}

describe("a worker on the runner", () => {
  it("prepares a worktree on a new branch, briefs the program, and hands back the pull request", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(5) });
    const handle = await programs.prompted(1);
    const paths = workPaths(home, repository, 5);
    expect(handle.options).toEqual({ session: null, tools: null, workspace: paths.worktree });
    expect(handle.settings).toMatchObject({ program: "/programs/codex", model: "gpt-6-luna", effort: "low", client: "super-agent2-worker", processTree: true });
    expect(handle.settings.environment["GH_TOKEN"]).toBe(token);
    expect(handle.settings.environment["GITHUB_TOKEN"]).toBe(token);
    expect(handle.settings.environment[tokenVariable]).toBe(token);
    expect(carried(handle.settings.environment)).toEqual([]);
    for (const name of ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "RUNNER_TOKEN", "ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
      expect(handle.settings.environment[name], name).toBeUndefined();
    }
    expect(handle.settings.environment["GIT_CONFIG_PARAMETERS"]).toContain("credential.https://github.com.helper=");
    const prompt = handle.prompts[0] ?? "";
    expect(prompt).toContain("# Guidance for a worker");
    expect(prompt.indexOf("#11 First issue")).toBeLessThan(prompt.indexOf("#12 Second issue"));
    expect(prompt).toContain(paths.handback);
    expect(prompt).not.toContain(token);
    expect((await git(paths.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], paths.worktree)).trim()).toBe("sa2/ticket-5-abcd");
    expect(works.busy()).toBe(1);
    handle.emit({ type: "session", session: "thread-5" });
    handle.emit({ type: "model", model: "gpt-6-luna", effort: "low" });
    handle.emit({ type: "text", block: "b", delta: "working" });
    handBack(5, 40, [11, 12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(5)).toEqual({ kind: "finished", pullRequest: 40, url: `https://github.com/${repository}/pull/40`, report: { en: "Did both issues", zh: "两个问题都做完了" } });
    expect(kinds(5)).toEqual(["phase:preparing", "phase:prepared", "phase:started", "phase:turn", "session", "ran", "text", "phase:checking", "finished"]);
    expect(events(5).map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(handle.closed).toBe(true);
    expect(works.busy()).toBe(0);
    expect(works.held()).toEqual([{ ticket: 5, attempt: 1, last: 9, live: false, ended: true }]);
    expect(JSON.stringify(sent.items)).not.toContain(token);
    expect(readFileSync(join(paths.folder, "work.json"), "utf8")).not.toContain(token);
  });

  it("asks the worker to fix a missing or wrong hand-back for as long as it is wrong, and hands back once it is right", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(6) });
    let handle = await programs.prompted(1);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain("You have not handed back");
    expect(events(6).find((message) => message.event.kind === "message")?.event).toMatchObject({ kind: "message", from: "hub", delivery: "steered" });
    handBack(6, 41, [11], "sa2/ticket-6-abcd", String.fromCharCode(0xfeff));
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(3, handle);
    expect(handle.prompts[2]).toContain("does not close #12");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(4, handle);
    expect(handle.prompts[3]).toContain("does not close #12");
    handBack(6, 41, [11, 12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(6)).toMatchObject({ kind: "finished", pullRequest: 41 });
  });

  it("takes a message into the running turn, or queues it for the next turn when the program cannot", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(7) });
    const handle = await programs.prompted(1);
    works.receive({ type: "work.message", ticket: 7, attempt: 1, id: "m-1", from: "owner", text: "Also update the README" });
    await programs.changed.until(() => handle.steered.length === 1);
    expect(handle.steered[0]).toBe("[Message from the owner] Also update the README");
    programs.steer = "queued";
    works.receive({ type: "work.message", ticket: 7, attempt: 1, id: "m-2", from: "brain", text: "Keep it short" });
    await sent.until(() => kinds(7).filter((kind) => kind === "message").length === 2);
    expect(events(7).filter((message) => message.event.kind === "message").map((message) => message.event)).toEqual([
      { kind: "message", id: "m-1", from: "owner", text: "Also update the README", delivery: "steered" },
      { kind: "message", id: "m-2", from: "brain", text: "Keep it short", delivery: "queued" },
    ]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toBe("[Message from the brain] Keep it short");
    handBack(7, 42, [11, 12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect((await ended(7)).kind).toBe("finished");
  });

  it("records a program failure with its reason", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(8) });
    const handle = await programs.prompted(1);
    handle.emit({ type: "failed", reason: "codex exited with code 1", lostSession: false });
    expect(await ended(8)).toEqual({ kind: "failed", failure: "program", reason: "codex exited with code 1" });
    expect(works.busy()).toBe(0);
  });

  it("stops a worker, removes its worktree and branch, and forgets it", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(9) });
    const handle = await programs.prompted(1);
    const paths = workPaths(home, repository, 9);
    expect(existsSync(paths.worktree)).toBe(true);
    works.receive({ type: "work.stop", ticket: 9, save: false, remove: true });
    await works.idle();
    expect(handle.closed).toBe(true);
    expect(kinds(9).slice(-2)).toEqual(["stopped", "phase:removed"]);
    expect(existsSync(paths.worktree)).toBe(false);
    expect(existsSync(paths.folder)).toBe(false);
    const branches = await git(paths.clone).must(["branch", "--list", "sa2/ticket-9-abcd"], paths.clone);
    expect(branches.trim()).toBe("");
    expect(works.held()).toEqual([]);
    expect(works.busy()).toBe(0);
  });

  it("runs two tickets of one repository at once in separate worktrees on separate branches", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(10) });
    works.receive({ type: "work.start", task: task(11) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.handles.every((handle) => handle.prompts.length === 1));
    expect(works.busy()).toBe(2);
    const [first, second] = [workPaths(home, repository, 10), workPaths(home, repository, 11)];
    expect(first.worktree).not.toBe(second.worktree);
    expect(first.clone).toBe(second.clone);
    writeFileSync(join(first.worktree, "ten.txt"), "ten\n");
    expect(existsSync(join(second.worktree, "ten.txt"))).toBe(false);
    expect((await git(second.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], second.worktree)).trim()).toBe("sa2/ticket-11-abcd");
  });

  it("after a restart, lists its work and resumes the same session in the same worktree when told to", async () => {
    const first = start();
    first.receive({ type: "work.start", task: task(12) });
    const before = await programs.prompted(1);
    before.emit({ type: "session", session: "thread-12" });
    before.emit({ type: "text", block: "b", delta: "half done" });
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const again = start();
    expect(again.held()).toEqual([{ ticket: 12, attempt: 1, last: 7, live: false, ended: false }]);
    again.receive({ type: "work.sync", ticket: 12, attempt: 1, after: 5 });
    expect(sent.items.slice(-2).map((message) => (message.type === "work.event" ? message.seq : 0))).toEqual([6, 7]);
    again.receive({ type: "work.start", task: task(12) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    const after = programs.last();
    expect(after).not.toBe(before);
    expect(after.options.session).toBe("thread-12");
    expect(after.prompts[0]).toContain("runner restarted");
    expect(kinds(12)).toContain("phase:resumed");
    expect(events(12).at(-1)?.seq).toBeGreaterThan(7);
  });

  it("does not start a second worker when it is told to start the same attempt again", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(13) });
    await programs.prompted(1);
    works.receive({ type: "work.start", task: task(13) });
    await works.idle();
    expect(programs.handles).toHaveLength(1);
    expect(works.busy()).toBe(1);
  });

  it("replaces a running attempt with a newer one in the same worktree", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(14) });
    const old = await programs.prompted(1);
    works.receive({ type: "work.start", task: task(14, { attempt: 2, engine: "claude", model: "claude-haiku-5-5", note: "The owner reassigned this ticket" }) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    expect(old.closed).toBe(true);
    const fresh = programs.last();
    expect(fresh.engine).toBe("claude");
    expect(fresh.prompts[0]).toContain("The owner reassigned this ticket");
    expect(fresh.options.workspace).toBe(old.options.workspace);
    expect(works.held()).toEqual([expect.objectContaining({ ticket: 14, attempt: 2, live: true })]);
  });

  it("fails cleanly when the repository cannot be prepared", async () => {
    const works = start({ remote: () => join(scratch, "missing.git") });
    works.receive({ type: "work.start", task: task(15) });
    const last = await ended(15);
    expect(last).toMatchObject({ kind: "failed", failure: "prepare" });
    expect(programs.handles).toHaveLength(0);
    expect(ghCalls).toEqual([["api", "user"]]);
  });
});

function writingTask(ticket: number, overrides: Partial<WritingTask> = {}): WritingTask {
  return {
    ticket,
    attempt: 1,
    title: "Translate the notice",
    task: "Translate the notice in input/notice.txt into English.",
    materials: [
      { name: "notice.txt", source: "pasted by the owner in the conversation", text: "你好，世界。" },
      { name: "glossary", source: "https://example.com/glossary", text: null },
    ],
    engine: "antigravity",
    model: "gemini-3.8-flash",
    effort: "high",
    session: null,
    note: null,
    ...overrides,
  };
}

function writeOutput(ticket: number, files: Readonly<Record<string, string | Buffer>>, handback: unknown): void {
  const paths = writingPaths(home, ticket);
  mkdirSync(join(paths.worktree, "output"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(paths.worktree, "output", name), content);
  }
  writeFileSync(paths.handback, typeof handback === "string" ? handback : JSON.stringify(handback));
}

const summary = { en: "Translated the notice", zh: "翻译了通知" };

describe("a writing worker on the runner", () => {
  it("makes a scratch folder with the material, briefs the program without any repository, and delivers the text and files", async () => {
    const works = start();
    works.receive({ type: "work.write", task: writingTask(20) });
    const handle = await programs.prompted(1);
    const paths = writingPaths(home, 20);
    expect(handle.engine).toBe("antigravity");
    expect(handle.options).toEqual({ session: null, tools: null, workspace: paths.worktree });
    expect(handle.settings).toMatchObject({ program: "/programs/agy", model: "gemini-3.8-flash", effort: "high", processTree: true });
    expect(carried(handle.settings.environment)).toEqual([]);
    for (const name of Object.keys(inheritedCredentials)) {
      expect(handle.settings.environment[name], name).toBeUndefined();
    }
    expect(handle.settings.environment[tokenVariable]).toBeUndefined();
    expect(readFileSync(join(paths.worktree, "input", "notice.txt"), "utf8")).toBe("你好，世界。");
    expect(existsSync(join(paths.worktree, "input", "glossary"))).toBe(false);
    expect(existsSync(join(paths.worktree, "output"))).toBe(true);
    const prompt = handle.prompts[0] ?? "";
    expect(prompt).toContain("# Guidance for a writing worker");
    expect(prompt).toContain("Translate the notice in input/notice.txt into English.");
    expect(prompt).toContain("- input/notice.txt, from pasted by the owner in the conversation");
    expect(prompt).toContain("- Not a file: get it yourself from https://example.com/glossary (named glossary)");
    expect(prompt).toContain(paths.handback);
    expect(prompt).toContain(join(paths.worktree, "output"));
    expect(works.busy()).toBe(1);
    handle.emit({ type: "session", session: "agy-conversation-20" });
    handle.emit({ type: "model", model: "gemini-3.8-flash", effort: null });
    writeOutput(20, { "result.md": "Hello, world.\n", "notes.pdf": Buffer.from([1, 2, 3, 4]) }, { text: "result.md", files: ["notes.pdf"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    const last = await ended(20);
    expect(last).toEqual({
      kind: "delivered",
      text: "Hello, world.\n",
      files: [{ name: "notes.pdf", size: 4, mediaType: "application/pdf" }],
      report: summary,
    });
    expect(kinds(20)).toEqual(["phase:preparing", "phase:prepared", "phase:started", "phase:turn", "session", "ran", "phase:checking", "delivered"]);
    expect(handle.closed).toBe(true);
    expect(works.busy()).toBe(0);
    expect(ghCalls).toEqual([]);
    expect(existsSync(workPaths(home, repository, 20).worktree)).toBe(false);
  });

  it("delivers only files when there is no text, and tells the worker what is wrong with a hand-back until it is right", async () => {
    const works = start();
    works.receive({ type: "work.write", task: writingTask(21) });
    let handle = await programs.prompted(1);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain("You have not handed back");
    writeOutput(21, {}, "not json");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(3, handle);
    expect(handle.prompts[2]).toContain("is not valid JSON");
    writeOutput(21, { "table.xlsx": "cells" }, { files: ["table.xlsx"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(21)).toEqual({ kind: "delivered", text: null, files: [{ name: "table.xlsx", size: 5, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }], report: summary });
  });

  it("refuses a hand-back that names a missing file or a path outside the output folder", async () => {
    const works = start();
    works.receive({ type: "work.write", task: writingTask(22) });
    const handle = await programs.prompted(1);
    const paths = writingPaths(home, 22);
    writeOutput(22, {}, { files: ["missing.docx"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain('names "missing.docx", but there is no such file');
    writeOutput(22, {}, { files: ["../handback.json"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(3, handle);
    expect(handle.prompts[2]).toContain("is not a file name");
    expect(existsSync(paths.handback)).toBe(true);
  });

  it("refuses an empty text, and delivers files of any size and number, sending each part the hub asks for", async () => {
    const works = start();
    works.receive({ type: "work.write", task: writingTask(23) });
    const handle = await programs.prompted(1);
    const big = Buffer.alloc(9 * 1024 * 1024, 3);
    big[big.length - 1] = 9;
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`part-${index}.txt`, `piece ${index}`]));
    writeOutput(23, { "empty.txt": "  \n", "big.bin": big, ...many }, { text: "empty.txt", summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain('"empty.txt" is empty');
    writeOutput(23, {}, { files: ["big.bin", ...Object.keys(many)], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    const last = await ended(23);
    expect(last.kind === "delivered" ? last.files.length : 0).toBe(31);
    expect(last.kind === "delivered" ? last.files[0] : undefined).toEqual({ name: "big.bin", size: big.length, mediaType: "application/octet-stream" });
    const asked = { type: "work.file" as const, ticket: 23, attempt: 1, name: "big.bin", offset: 8 * 1024 * 1024, length: 1024 * 1024 };
    works.receive(asked);
    works.receive({ ...asked, name: "missing.bin", offset: 0 });
    const parts = await sent.until(() => sent.items.filter((message) => message.type === "work.file.part").length === 2).then(() =>
      sent.items.flatMap((message) => (message.type === "work.file.part" ? [message] : [])),
    );
    const served = parts.find((message) => message.name === "big.bin");
    expect(Buffer.from(served?.data ?? "", "base64").equals(big.subarray(8 * 1024 * 1024))).toBe(true);
    expect(served).toMatchObject({ offset: 8 * 1024 * 1024, problem: null });
    expect(parts.find((message) => message.name === "missing.bin")).toMatchObject({ data: null, problem: expect.stringContaining("missing.bin") as unknown as string });
  });

  it("stops and removes the scratch folder without touching Git, and lists the work after a restart", async () => {
    const first = start();
    first.receive({ type: "work.write", task: writingTask(24) });
    const before = await programs.prompted(1);
    before.emit({ type: "session", session: "agy-conversation-24" });
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const again = start();
    expect(again.held()).toEqual([{ ticket: 24, attempt: 1, last: 5, live: false, ended: false }]);
    again.receive({ type: "work.write", task: writingTask(24) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    const resumed = programs.last();
    expect(resumed.options.session).toBe("agy-conversation-24");
    expect(resumed.prompts[0]).toContain("runner restarted");
    expect(kinds(24)).toContain("phase:resumed");
    again.receive({ type: "work.stop", ticket: 24, save: true, remove: true });
    await again.idle();
    expect(resumed.closed).toBe(true);
    expect(existsSync(writingPaths(home, 24).folder)).toBe(false);
    expect(kinds(24).slice(-2)).toEqual(["stopped", "phase:removed"]);
    expect(ghCalls).toEqual([]);
  });

  it("reports a program that fails as a failure with its reason", async () => {
    const works = start();
    works.receive({ type: "work.write", task: writingTask(25) });
    const handle = await programs.prompted(1);
    handle.emit({ type: "unavailable", reason: "resource exhausted", until: null });
    expect(await ended(25)).toEqual({ kind: "failed", failure: "program", reason: "resource exhausted" });
  });
});
