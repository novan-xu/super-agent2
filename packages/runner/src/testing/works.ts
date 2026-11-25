import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenOptions, ProgramEvent, ProgramHandle, ProgramListener, ProgramSettings, PromptImage, SteerResult, WorkerAdapter } from "@super-agent2/programs";
import { endsWork, type RunnerToHub, type RunnerWorkEvent, type TaskAssignment, type WorkEngine, type WorkEvent, type WorkTask } from "@super-agent2/protocol";
import { afterEach, beforeEach } from "vitest";
import { createGit, type ProcessRunner, runProcess } from "../git.js";
import type { PullRequestState } from "../handback.js";
import { workPaths } from "../workplace.js";
import { createWorks, type Works, type WorksOptions } from "../works.js";
import { outputFolder, taskPaths } from "../task.js";

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

export class FakeHandle implements ProgramHandle {
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

export const repository = "novan-xu/super-agent-sandbox";
export const token = "test-worker-token";
const identity = {
  GIT_AUTHOR_NAME: "Test Owner",
  GIT_AUTHOR_EMAIL: "owner@example.com",
  GIT_COMMITTER_NAME: "Test Owner",
  GIT_COMMITTER_EMAIL: "owner@example.com",
};

export let scratch: string;
export let home: string;
export let remote: string;
export let programs: FakePrograms;
export let sent: Recorder<RunnerToHub>;
let pulls: Map<number, PullRequestState>;
export let ghCalls: string[][];
export let opened: Works[];

export const inheritedCredentials: Record<string, string> = {
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

export function carried(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => inheritedCredentials[name] === value)
    .map(([name]) => name);
}

export const git = (cwd: string) => createGit(runProcess, { ...(process.env as Record<string, string>), ...identity });

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

export function start(overrides: Partial<WorksOptions> = {}): Works {
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
    readClosedIssues: async () => [],
    readBranchPull: async () => null,
    ...overrides,
  });
  opened.push(works);
  return works;
}

export function task(ticket: number, overrides: Partial<WorkTask> = {}): WorkTask {
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
    takeover: false,
    environment: { GH_TOKEN: token, GITHUB_TOKEN: token },
    ...overrides,
  };
}

export function events(ticket: number, attempt = 1): RunnerWorkEvent[] {
  return sent.items.filter((message): message is RunnerWorkEvent => message.type === "work.event" && message.ticket === ticket && message.attempt === attempt);
}

export function kinds(ticket: number, attempt = 1): string[] {
  return events(ticket, attempt).map((message) => (message.event.kind === "phase" ? `phase:${message.event.phase}` : message.event.kind));
}

export function ended(ticket: number, attempt = 1): Promise<WorkEvent> {
  return sent
    .until(() => events(ticket, attempt).some((message) => endsWork(message.event)))
    .then(() => {
      const last = events(ticket, attempt).find((message) => endsWork(message.event));
      if (last === undefined) {
        throw new Error("no ending");
      }
      return last.event;
    });
}

export function handBack(ticket: number, pullRequest: number, closes: readonly number[], branch = `sa2/ticket-${ticket}-abcd`, mark = "", extra: Readonly<Record<string, unknown>> = {}): void {
  const paths = workPaths(home, repository, ticket);
  mkdirSync(paths.folder, { recursive: true });
  writeFileSync(paths.handback, mark + JSON.stringify({ pullRequest, summary: { en: "Did both issues", zh: "两个问题都做完了" }, ...extra }));
  pulls.set(pullRequest, { number: pullRequest, url: `https://github.com/${repository}/pull/${pullRequest}`, state: "OPEN", head: branch, closes });
}

export async function finishTurn(works: Works, handle: FakeHandle): Promise<void> {
  handle.emit({ type: "turn.finished", outcome: "completed" });
  await works.idle();
}

export function writingTask(ticket: number, overrides: Partial<TaskAssignment> = {}): TaskAssignment {
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
    takeover: false,
    environment: {},
    ...overrides,
  };
}

export function writeOutput(ticket: number, files: Readonly<Record<string, string | Buffer>>, handback: unknown, checkout: string | null = null): void {
  const paths = taskPaths(home, ticket, checkout);
  mkdirSync(outputFolder(paths), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outputFolder(paths), name), content);
  }
  const content = typeof handback === "string" ? handback : JSON.stringify(handback);
  writeFileSync(paths.handback, content);
  const antigravityHandback = join(paths.worktree, `.superagent2-t${ticket}`, "handback.json");
  mkdirSync(join(paths.worktree, `.superagent2-t${ticket}`), { recursive: true });
  writeFileSync(antigravityHandback, content);
}

export const summary = { en: "Translated the notice", zh: "翻译了通知" };

export function attachmentRequests(): Extract<RunnerToHub, { readonly type: "work.attachment" }>[] {
  return sent.items.filter((message): message is Extract<RunnerToHub, { readonly type: "work.attachment" }> => message.type === "work.attachment");
}

export function serveAttachments(works: Works, files: ReadonlyMap<string, Buffer>, partBytes: number, stopAfter = Number.POSITIVE_INFINITY): Promise<void> {
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
