import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenOptions, ProgramEvent, ProgramHandle, ProgramListener, ProgramSettings, PromptImage, SteerResult, WorkerAdapter } from "@super-agent2/programs";
import { type Attachment, type RunnerToHub, type RunnerWorkEvent, storedName, type TaskAssignment, type WorkEngine, type WorkEvent, type WorkTask } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type ProcessRunner, runProcess } from "./git.js";
import type { PullRequestState } from "./handback.js";
import { tokenVariable } from "./identity.js";
import { workPaths } from "./workplace.js";
import { createWorks, type Works, type WorksOptions } from "./works.js";
import { outputFolder, taskPaths } from "./task.js";

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
  readonly images: (readonly PromptImage[])[] = [];
  closed = false;
  running = false;

  constructor(
    readonly fake: FakePrograms,
    readonly engine: WorkEngine,
    readonly settings: ProgramSettings,
    readonly options: OpenOptions,
    readonly listener: ProgramListener,
  ) {}

  start(prompt: string, images: readonly PromptImage[] = []): void {
    this.running = true;
    this.prompts.push(prompt);
    this.images.push(images);
    this.fake.changed.push(this);
  }

  steer(text: string, images: readonly PromptImage[] = []): Promise<SteerResult> {
    if (this.fake.steer === "queued" || !this.running) {
      return Promise.resolve("queued");
    }
    this.steered.push(text);
    this.images.push(images);
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

function handBack(ticket: number, pullRequest: number, closes: readonly number[], branch = `sa2/ticket-${ticket}-abcd`, mark = "", extra: Readonly<Record<string, unknown>> = {}): void {
  const paths = workPaths(home, repository, ticket);
  mkdirSync(paths.folder, { recursive: true });
  writeFileSync(paths.handback, mark + JSON.stringify({ pullRequest, summary: { en: "Did both issues", zh: "两个问题都做完了" }, ...extra }));
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
    expect(await ended(5)).toEqual({ kind: "finished", pullRequest: 40, url: `https://github.com/${repository}/pull/40`, closes: [11, 12], report: { en: "Did both issues", zh: "两个问题都做完了" } });
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
    expect(handle.prompts[1]).toContain("You have not handed in a pull request");
    expect(handle.prompts[1]).toContain("#11, #12 are still open");
    expect(events(6).find((message) => message.event.kind === "message")?.event).toMatchObject({ kind: "message", from: "hub", delivery: "steered" });
    handBack(6, 41, [99], "sa2/ticket-6-abcd", String.fromCharCode(0xfeff));
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(3, handle);
    expect(handle.prompts[2]).toContain("closes none of the open issues of the chain (#11, #12)");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(4, handle);
    expect(handle.prompts[3]).toContain("closes none of the open issues of the chain (#11, #12)");
    handBack(6, 41, [11, 12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(6)).toMatchObject({ kind: "finished", pullRequest: 41, closes: [11, 12] });
  });

  it("hands in the decisions the worker wrote with its pull request, and asks again for one that is not complete", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(36) });
    let handle = await programs.prompted(1);
    const decision = {
      chosen: { en: "Parsed dates in the local time zone", zh: "按本地时区解析日期" },
      why: { en: "The notes are written by one person in one place", zh: "笔记由一个人在同一个地方写" },
      otherOptions: { en: "UTC everywhere, which shifts evening notes to the next day", zh: "统一用 UTC，晚上的笔记会跑到第二天" },
    };
    handBack(36, 46, [11, 12], undefined, "", { decisions: [{ chosen: decision.chosen, why: decision.why }] });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain('may list "decisions", each with "chosen", "why" and "otherOptions"');
    handBack(36, 46, [11, 12], undefined, "", { decisions: [decision] });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(36)).toMatchObject({ kind: "finished", pullRequest: 46, decisions: [decision] });
  });

  it("hands in a pull request for part of the chain, and continues the next piece in the same folder on a new branch", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(9) });
    let handle = await programs.prompted(1);
    const paths = workPaths(home, repository, 9);
    handle.emit({ type: "session", session: "thread-9" });
    writeFileSync(join(paths.worktree, "first.txt"), "first");
    await git(paths.worktree).must(["add", "first.txt"], paths.worktree);
    await git(paths.worktree).must(["commit", "-m", "First"], paths.worktree);
    writeFileSync(join(paths.clone, ".git", "info", "exclude"), "cache.txt\n");
    writeFileSync(join(paths.worktree, "cache.txt"), "kept");
    handBack(9, 50, [11], "sa2/ticket-9-abcd");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(9)).toMatchObject({ kind: "finished", pullRequest: 50, closes: [11] });
    const seed = join(scratch, "seed");
    await git(seed).must(["pull", "origin", "main"], seed);
    writeFileSync(join(seed, "first.txt"), "first");
    await git(seed).must(["add", "first.txt"], seed);
    await git(seed).must(["commit", "-m", "Squashed #50"], seed);
    await git(seed).must(["push", "origin", "main"], seed);
    works.receive({
      type: "work.start",
      task: task(9, { attempt: 2, branch: "sa2/ticket-9-beef", merged: [11], session: "thread-9", note: "Pull request #50 is merged into main. Still open: #12." }),
    });
    await programs.changed.until(() => programs.handles.length === 2);
    handle = await programs.prompted(1);
    expect(handle.options).toEqual({ session: "thread-9", tools: null, workspace: paths.worktree });
    expect(handle.prompts[0]).toContain("Pull request #50 is merged into main");
    expect(events(9, 2).find((message) => message.event.kind === "phase" && message.event.phase === "prepared")?.event).toMatchObject({
      detail: `Switched the worktree ${paths.worktree} to the new branch sa2/ticket-9-beef from origin/main`,
    });
    expect((await git(paths.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], paths.worktree)).trim()).toBe("sa2/ticket-9-beef");
    expect((await git(paths.worktree).must(["log", "-1", "--format=%s"], paths.worktree)).trim()).toBe("Squashed #50");
    expect(readFileSync(join(paths.worktree, "cache.txt"), "utf8")).toBe("kept");
    handBack(9, 51, [11], "sa2/ticket-9-beef");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain("closes none of the open issues of the chain (#12)");
    handBack(9, 51, [12], "sa2/ticket-9-beef");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(9, 2)).toMatchObject({ kind: "finished", pullRequest: 51, closes: [12] });
  });

  async function nextPiece(ticket: number, mainFirst: string, leave: (worktree: string) => void): Promise<{ readonly handle: FakeHandle; readonly worktree: string }> {
    const works = start();
    works.receive({ type: "work.start", task: task(ticket) });
    const first = await programs.prompted(1);
    const paths = workPaths(home, repository, ticket);
    first.emit({ type: "session", session: `thread-${ticket}` });
    writeFileSync(join(paths.worktree, "first.txt"), "first");
    await git(paths.worktree).must(["add", "first.txt"], paths.worktree);
    await git(paths.worktree).must(["commit", "-m", "First"], paths.worktree);
    leave(paths.worktree);
    handBack(ticket, 60, [11], `sa2/ticket-${ticket}-abcd`);
    first.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(ticket)).toMatchObject({ kind: "finished", pullRequest: 60 });
    const seed = join(scratch, "seed");
    await git(seed).must(["pull", "origin", "main"], seed);
    writeFileSync(join(seed, "first.txt"), mainFirst);
    await git(seed).must(["add", "first.txt"], seed);
    await git(seed).must(["commit", "-m", "Squashed #60"], seed);
    await git(seed).must(["push", "origin", "main"], seed);
    works.receive({ type: "work.start", task: task(ticket, { attempt: 2, branch: `sa2/ticket-${ticket}-beef`, merged: [11], session: `thread-${ticket}`, note: "Pull request #60 is merged into main." }) });
    await programs.changed.until(() => programs.handles.length === 2);
    return { handle: await programs.prompted(1), worktree: paths.worktree };
  }

  it("carries uncommitted work over to the next branch when it applies cleanly, keeps a copy, and tells the worker", async () => {
    const { handle, worktree } = await nextPiece(13, "first", (folder) => {
      writeFileSync(join(folder, "README.md"), "sandbox, next step");
      writeFileSync(join(folder, "notes.txt"), "started on #12");
    });
    expect((await git(worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim()).toBe("sa2/ticket-13-beef");
    expect((await git(worktree).must(["log", "-1", "--format=%s"], worktree)).trim()).toBe("Squashed #60");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("sandbox, next step");
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("started on #12");
    expect((await git(worktree).must(["status", "--porcelain"], worktree)).split("\n").filter((line) => line !== "").sort()).toEqual([" M README.md", "?? notes.txt"]);
    const kept = (await git(worktree).must(["show", "--stat", "--format=%s", "sa2/ticket-13-abcd-unfinished"], worktree)).trim();
    expect(kept).toContain("Work left uncommitted in the folder when it moved on from sa2/ticket-13-abcd");
    expect(kept).toContain("notes.txt");
    expect(handle.prompts[0]).toContain("Pull request #60 is merged into main.");
    expect(handle.prompts[0]).toContain("Uncommitted changes were found in your folder when it moved to the new branch sa2/ticket-13-beef. They were carried over");
    expect(handle.prompts[0]).toContain("a copy is kept on the local branch sa2/ticket-13-abcd-unfinished");
    expect(events(13, 2).find((message) => message.event.kind === "phase" && message.event.phase === "prepared")?.event).toMatchObject({
      detail: expect.stringContaining("carrying over the uncommitted changes found there") as unknown as string,
    });
  });

  it("keeps uncommitted work that does not apply on the updated default branch on a named branch, and tells the worker where", async () => {
    const { handle, worktree } = await nextPiece(14, "theirs", (folder) => {
      writeFileSync(join(folder, "first.txt"), "mine");
    });
    expect((await git(worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim()).toBe("sa2/ticket-14-beef");
    expect(readFileSync(join(worktree, "first.txt"), "utf8")).toBe("theirs");
    expect((await git(worktree).must(["status", "--porcelain"], worktree)).trim()).toBe("");
    expect((await git(worktree).must(["show", "sa2/ticket-14-abcd-unfinished:first.txt"], worktree)).trim()).toBe("mine");
    const commit = (await git(worktree).must(["rev-parse", "sa2/ticket-14-abcd-unfinished"], worktree)).trim();
    expect(handle.prompts[0]).toContain("They did not apply cleanly on the updated main, so sa2/ticket-14-beef starts clean");
    expect(handle.prompts[0]).toContain(`the local branch sa2/ticket-14-abcd-unfinished (commit ${commit})`);
    expect(handle.prompts[0]).toContain(`git cherry-pick --no-commit ${commit}`);
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

function writingTask(ticket: number, overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    ticket,
    attempt: 1,
    title: "Translate the notice",
    task: "Translate the notice in input/notice.txt into English.",
    materials: [
      { name: "notice.txt", source: "pasted by the owner in the conversation", text: "你好，世界。" },
      { name: "glossary", source: "https://example.com/glossary", text: null },
    ],
    checkout: null,
    deploys: false,
    engine: "antigravity",
    model: "gemini-3.8-flash",
    effort: "high",
    session: null,
    note: null,
    environment: {},
    ...overrides,
  };
}

function writeOutput(ticket: number, files: Readonly<Record<string, string | Buffer>>, handback: unknown, checkout: string | null = null): void {
  const paths = taskPaths(home, ticket, checkout);
  mkdirSync(outputFolder(paths), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outputFolder(paths), name), content);
  }
  writeFileSync(paths.handback, typeof handback === "string" ? handback : JSON.stringify(handback));
}

const summary = { en: "Translated the notice", zh: "翻译了通知" };

describe("a task worker on the runner", () => {
  it("makes a scratch folder with the material, briefs the program without any repository, and delivers the text and files", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(20) });
    const handle = await programs.prompted(1);
    const paths = taskPaths(home, 20);
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
    expect(prompt).toContain("# Guidance for a task worker");
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
      outcome: "done",
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
    works.receive({ type: "work.task", task: writingTask(21) });
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
    expect(await ended(21)).toEqual({ kind: "delivered", outcome: "done", text: null, files: [{ name: "table.xlsx", size: 5, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }], report: summary });
  });

  it("refuses a hand-back that names a missing file or a path outside the output folder", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(22) });
    const handle = await programs.prompted(1);
    const paths = taskPaths(home, 22);
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
    works.receive({ type: "work.task", task: writingTask(23) });
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
    first.receive({ type: "work.task", task: writingTask(24) });
    const before = await programs.prompted(1);
    before.emit({ type: "session", session: "agy-conversation-24" });
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const again = start();
    expect(again.held()).toEqual([{ ticket: 24, attempt: 1, last: 5, live: false, ended: false }]);
    again.receive({ type: "work.task", task: writingTask(24) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    const resumed = programs.last();
    expect(resumed.options.session).toBe("agy-conversation-24");
    expect(resumed.prompts[0]).toContain("runner restarted");
    expect(kinds(24)).toContain("phase:resumed");
    again.receive({ type: "work.stop", ticket: 24, save: true, remove: true });
    await again.idle();
    expect(resumed.closed).toBe(true);
    expect(existsSync(taskPaths(home, 24).folder)).toBe(false);
    expect(kinds(24).slice(-2)).toEqual(["stopped", "phase:removed"]);
    expect(ghCalls).toEqual([]);
  });

  it("reports a program that fails as a failure with its reason", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(25) });
    const handle = await programs.prompted(1);
    handle.emit({ type: "unavailable", reason: "resource exhausted", until: null });
    expect(await ended(25)).toEqual({ kind: "failed", failure: "program", reason: "resource exhausted" });
  });
});

describe("a task worker with a repository", () => {
  const recipe = (target: string) => JSON.stringify({ target, deploy: "node deploy.mjs", health: { command: "node health.mjs" }, rollback: "node rollback.mjs" });

  async function commitDeploymentFile(target: string): Promise<string> {
    const seed = join(scratch, "seed");
    const repo = git(seed);
    mkdirSync(join(seed, ".superagent2"), { recursive: true });
    writeFileSync(join(seed, ".superagent2", "deployment.json"), recipe(target));
    await repo.must(["add", "-A"], seed);
    await repo.must(["commit", "-m", "Declare the deployment"], seed);
    await repo.must(["push", "origin", "main"], seed);
    return (await repo.must(["rev-parse", "HEAD"], seed)).trim();
  }

  it("checks the repository out at its commit beside the scratch folder, works in the checkout as the account, and hands back the commit", async () => {
    const seed = join(scratch, "seed");
    const commit = (await git(seed).must(["rev-parse", "HEAD"], seed)).trim();
    const works = start({ machine: "pc" });
    works.receive({
      type: "work.task",
      task: writingTask(40, { engine: "codex", model: "gpt-6-luna", effort: "low", checkout: { repository, account: "novan-xu", commit, ref: null }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }),
    });
    const handle = await programs.prompted(1);
    const paths = taskPaths(home, 40, repository);
    expect(handle.options.workspace).toBe(paths.worktree);
    expect(readFileSync(join(paths.worktree, "README.md"), "utf8").trim()).toBe("sandbox");
    expect((await git(paths.worktree).must(["rev-parse", "HEAD"], paths.worktree)).trim()).toBe(commit);
    expect(readFileSync(join(paths.folder, "scratch", "input", "notice.txt"), "utf8")).toBe("你好，世界。");
    expect(handle.settings.environment[tokenVariable]).toBe(token);
    expect(carried(handle.settings.environment)).toEqual([]);
    const prompt = handle.prompts[0] ?? "";
    expect(prompt).toContain("# Guidance for a task worker");
    expect(prompt).toContain("This machine: pc");
    expect(prompt).toContain(`Checkout of ${repository}: ${paths.worktree}, at commit ${commit}`);
    expect(prompt).not.toContain("Deployment recipe");
    writeOutput(40, {}, { outcome: "done", report: { en: "Ran it", zh: "跑完了" } }, repository);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(40)).toEqual({ kind: "delivered", outcome: "done", commit, text: null, files: [], report: { en: "Ran it", zh: "跑完了" } });
    works.receive({ type: "work.stop", ticket: 40, save: false, remove: true });
    await works.idle();
    expect(existsSync(paths.worktree)).toBe(false);
    expect(existsSync(paths.folder)).toBe(false);
  });

  it("hands back a failed outcome with its report", async () => {
    const works = start({ machine: "pc" });
    works.receive({ type: "work.task", task: writingTask(41, { checkout: { repository, account: "novan-xu", commit: null, ref: "main" }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }) });
    const handle = await programs.prompted(1);
    writeOutput(41, { "deploy.log": "it did not come up" }, { outcome: "failed", report: { en: "It did not come up; rolled back.", zh: "没起来，已回滚。" }, files: ["deploy.log"] }, repository);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(41)).toMatchObject({ kind: "delivered", outcome: "failed", report: { zh: "没起来，已回滚。" }, files: [{ name: "deploy.log" }] });
  });

  it("deploys only on the machine its deployment file names, and refuses another before any program starts", async () => {
    await commitDeploymentFile("mini");
    const elsewhere = start({ machine: "pc" });
    elsewhere.receive({ type: "work.task", task: writingTask(42, { deploys: true, checkout: { repository, account: "novan-xu", commit: null, ref: "main" }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }) });
    const refused = await ended(42);
    expect(refused).toMatchObject({ kind: "failed", failure: "prepare" });
    expect(refused.kind === "failed" ? refused.reason : "").toContain("names the machine mini, and this machine is pc");
    expect(programs.handles).toHaveLength(0);
    const commit = await commitDeploymentFile("pc");
    const here = start({ machine: "pc" });
    here.receive({ type: "work.task", task: writingTask(43, { deploys: true, checkout: { repository, account: "novan-xu", commit: null, ref: "main" }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }) });
    const handle = await programs.prompted(1);
    expect(handle.prompts[0]).toContain(`at commit ${commit}`);
    expect(handle.prompts[0]).toContain(`Deployment recipe: ${join(taskPaths(home, 43, repository).worktree, ".superagent2", "deployment.json")}`);
  });
});

function attachmentRequests(): Extract<RunnerToHub, { readonly type: "work.attachment" }>[] {
  return sent.items.filter((message): message is Extract<RunnerToHub, { readonly type: "work.attachment" }> => message.type === "work.attachment");
}

function serveAttachments(works: Works, files: ReadonlyMap<string, Buffer>, partBytes: number, stopAfter = Number.POSITIVE_INFINITY): Promise<void> {
  let answered = 0;
  return new Promise((resolve) => {
    const next = (): void => {
      void sent.until(() => answered >= stopAfter || attachmentRequests().length > answered).then(() => {
        if (answered >= stopAfter) {
          resolve();
          return;
        }
        const asked = attachmentRequests()[answered];
        answered += 1;
        if (asked === undefined) {
          return;
        }
        const data = files.get(asked.attachment)?.subarray(asked.offset, asked.offset + Math.min(asked.length, partBytes));
        works.receive({
          type: "work.attachment.part",
          ticket: asked.ticket,
          attempt: asked.attempt,
          attachment: asked.attachment,
          offset: asked.offset,
          data: data === undefined ? null : data.toString("base64"),
          problem: data === undefined ? "not given" : null,
        });
        next();
      });
    };
    next();
  });
}

describe("attachments on the runner", () => {
  const photo: Attachment = { id: "a".repeat(32), name: "../../photo.png", size: 5, mediaType: "image/png" };
  const note: Attachment = { id: "b".repeat(32), name: "note.txt", size: 9, mediaType: "text/plain" };
  const files = new Map([
    [photo.id, Buffer.from("PNG!!")],
    [note.id, Buffer.from("code word")],
  ]);

  it("fetches a message's files from the hub in parts into the ticket's folder outside the worktree, and shows the images to the program", async () => {
    const works = start();
    void serveAttachments(works, files, 2);
    works.receive({ type: "work.start", task: task(31) });
    const handle = await programs.prompted(1);
    works.receive({ type: "work.message", ticket: 31, attempt: 1, id: "m-a", from: "owner", text: "", attachments: [photo, note] });
    await programs.changed.until(() => handle.steered.length === 1);
    const paths = workPaths(home, repository, 31);
    const photoPath = join(paths.folder, "attachments", photo.id, storedName(photo.name));
    const notePath = join(paths.folder, "attachments", note.id, "note.txt");
    expect(readFileSync(photoPath, "utf8")).toBe("PNG!!");
    expect(readFileSync(notePath, "utf8")).toBe("code word");
    expect(photoPath.startsWith(paths.worktree)).toBe(false);
    expect(storedName(photo.name)).not.toContain("/");
    expect(handle.steered[0]).toContain(notePath);
    expect(handle.steered[0]).toContain(photoPath);
    expect(handle.images.at(-1)).toEqual([{ path: photoPath, mediaType: "image/png", size: 5 }]);
    expect(attachmentRequests().map((message) => message.offset)).toEqual([0, 2, 4, 0, 2, 4, 6, 8]);
    await sent.until(() => kinds(31).includes("message"));
    expect(events(31).find((message) => message.event.kind === "message")?.event).toEqual({ kind: "message", id: "m-a", from: "owner", text: "", attachments: [photo, note], delivery: "steered" });
    works.receive({ type: "work.message", ticket: 31, attempt: 1, id: "m-a", from: "owner", text: "", attachments: [photo, note] });
    await works.idle();
    expect(handle.steered).toHaveLength(1);
  });

  it("keeps what arrived when the link drops, and finishes the file when the hub gives the message again", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(32) });
    const handle = await programs.prompted(1);
    const served = serveAttachments(works, files, 2, 2);
    works.receive({ type: "work.message", ticket: 32, attempt: 1, id: "m-b", from: "owner", text: "look", attachments: [photo] });
    await served;
    await sent.until(() => attachmentRequests().length === 3);
    works.disconnected();
    await works.idle();
    expect(kinds(32)).not.toContain("message");
    const file = join(workPaths(home, repository, 32).folder, "attachments", photo.id, storedName(photo.name));
    expect(readFileSync(file, "utf8")).toBe("PNG!");
    const before = attachmentRequests().length;
    const resumed = sent.until(() => attachmentRequests().length > before).then(() => {
      const asked = attachmentRequests().at(-1);
      if (asked !== undefined) {
        works.receive({ type: "work.attachment.part", ticket: 32, attempt: 1, attachment: photo.id, offset: asked.offset, data: Buffer.from("!").toString("base64"), problem: null });
      }
      return asked?.offset;
    });
    works.receive({ type: "work.message", ticket: 32, attempt: 1, id: "m-b", from: "owner", text: "look", attachments: [photo] });
    expect(await resumed).toBe(4);
    await programs.changed.until(() => handle.steered.length === 1);
    expect(readFileSync(file, "utf8")).toBe("PNG!!");
  });

  it("puts a task ticket's attached material in the input folder under its name", async () => {
    const works = start();
    void serveAttachments(works, files, 8);
    works.receive({
      type: "work.task",
      task: writingTask(33, { materials: [{ name: "contract.txt", source: "attached by the owner", text: null, attachment: note }] }),
    });
    const handle = await programs.prompted(1);
    expect(readFileSync(join(taskPaths(home, 33).worktree, "input", "contract.txt"), "utf8")).toBe("code word");
    expect(handle.prompts[0]).toContain("input/contract.txt");
  });
});

describe("attachments across a chain's pieces", () => {
  it("keeps a fetched file when the folder moves to the next branch, and does not fetch it again", async () => {
    const note: Attachment = { id: "c".repeat(32), name: "spec.md", size: 4, mediaType: "text/markdown" };
    const works = start();
    void serveAttachments(works, new Map([[note.id, Buffer.from("spec")]]), 8);
    works.receive({ type: "work.start", task: task(35) });
    const first = await programs.prompted(1);
    works.receive({ type: "work.message", ticket: 35, attempt: 1, id: "m-c", from: "owner", text: "read it", attachments: [note] });
    await programs.changed.until(() => first.steered.length === 1);
    const paths = workPaths(home, repository, 35);
    const file = join(paths.folder, "attachments", note.id, "spec.md");
    expect(readFileSync(file, "utf8")).toBe("spec");
    works.receive({ type: "work.start", task: task(35, { attempt: 2, branch: "sa2/ticket-35-beef", merged: [11], session: "thread-35", note: "Pull request #70 is merged into main." }) });
    await programs.changed.until(() => programs.handles.length === 2);
    const second = await programs.prompted(1);
    expect((await git(paths.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], paths.worktree)).trim()).toBe("sa2/ticket-35-beef");
    expect(readFileSync(file, "utf8")).toBe("spec");
    const asked = attachmentRequests().length;
    works.receive({ type: "work.message", ticket: 35, attempt: 2, id: "m-d", from: "owner", text: "again", attachments: [note] });
    await programs.changed.until(() => second.steered.length === 1);
    expect(second.steered[0]).toContain(file);
    expect(attachmentRequests()).toHaveLength(asked);
  });
});
