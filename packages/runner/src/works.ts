import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  antigravityAdapter,
  claudeAdapter,
  codexAdapter,
  dshAdapter,
  type ProgramEvent,
  type ProgramHandle,
  type ProgramSettings,
  type PromptImage,
  type WorkerAdapter,
} from "@super-agent2/programs";
import {
  type Attachment,
  attachmentPartBytes,
  type AttachmentPart,
  type FetchFile,
  isNativeImage,
  type MessageWork,
  storedName,
  filePartBytes,
  type GitHubAccount,
  type HubToRunner,
  type RunnerToHub,
  type TaskAssignment,
  WorkEngine,
  type WorkEvent,
  type WorkHeld,
  WorkIssue,
  type WorkSender,
  type WorkTask,
} from "@super-agent2/protocol";
import { z } from "zod";
import {
  type AttachedFile,
  brief,
  type BriefPlace,
  continueText,
  leftoverText,
  lostSessionNote,
  messageText,
  resumeText,
  taskBrief,
  taskContinueText,
  taskLostSessionNote,
  takeoverTaskText,
  takeoverText,
  taskResumeText,
} from "./brief.js";
import { createGit, type Git, type ProcessRunner, runProcess } from "./git.js";
import { type Identity, readIdentity, shimFolder, withoutCredentials, workerEnvironment, writeGhShims } from "./identity.js";
import { checkHandback, type PullRequestReader, readPullRequestWith } from "./handback.js";
import type { Ledger } from "./ledger.js";
import { findExecutable } from "./programs.js";
import { mergeEnvironment } from "./shell.js";
import { replaceFile } from "./replace-file.js";
import { folderState, gitHubRemote, prepareWorktree, type RemoteUrl, removeWorktree, saveWork, type WorkPaths, workPaths } from "./workplace.js";
import { checkTaskHandback, clearOutput, deploymentProblem, listOutput, outputFolder, prepareCheckout, prepareScratch, readDeploymentAt, scratchFolder, taskPaths, taskPlace } from "./task.js";

export type WorkMessage = Extract<
  HubToRunner,
  { readonly type: "work.start" | "work.task" | "work.sync" | "work.message" | "work.stop" | "work.file" | "work.attachment.part" }
>;

export type AdapterFactory = (engine: WorkEngine, settings: ProgramSettings) => WorkerAdapter;

export const engineExecutables: Readonly<Record<WorkEngine, string>> = { codex: "codex", claude: "claude", dsh: "dsh", antigravity: "agy" };

export const defaultAdapters: AdapterFactory = (engine, settings) => {
  switch (engine) {
    case "codex":
      return codexAdapter(settings);
    case "claude":
      return claudeAdapter(settings);
    case "dsh":
      return dshAdapter(settings);
    case "antigravity":
      return antigravityAdapter(settings);
  }
};

export const workerCodexConfig: Readonly<Record<string, unknown>> = {
  "shell_environment_policy.inherit": "all",
  "shell_environment_policy.ignore_default_excludes": true,
};

export interface WorksOptions {
  readonly home: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly send: (message: RunnerToHub) => void;
  readonly now?: () => number;
  readonly adapters?: AdapterFactory;
  readonly findProgram?: (executable: string) => string | undefined;
  readonly run?: ProcessRunner;
  readonly remote?: RemoteUrl;
  readonly readPullRequest?: PullRequestReader;
  readonly ledger?: Ledger;
  readonly log?: (line: string) => void;
  readonly changed?: () => void;
  readonly machine?: string;
}

export interface Works {
  held(): WorkHeld[];
  busy(): number;
  receive(message: WorkMessage): void;
  disconnected(): void;
  idle(): Promise<void>;
  close(): Promise<void>;
}

const WorkRecord = z.object({
  kind: z
    .enum(["code", "task", "writing"])
    .default("code")
    .transform((kind) => (kind === "writing" ? "task" : kind)),
  ticket: z.number().int().positive(),
  attempt: z.number().int().positive(),
  repository: z.string(),
  branch: z.string(),
  title: z.string(),
  issues: z.array(WorkIssue),
  engine: WorkEngine,
  model: z.string(),
  effort: z.string(),
  session: z.string().nullable(),
  base: z.string().nullable(),
  commit: z.string().nullable().default(null),
  folder: z.number().int().positive().nullable().default(null),
  ended: z.boolean(),
});
type WorkRecord = z.output<typeof WorkRecord>;

const EventLine = z.object({ seq: z.number().int().positive(), at: z.number().int(), event: z.unknown() });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Prompt {
  readonly text: string;
  readonly images: readonly PromptImage[];
  readonly id?: string;
}

function joined(prompts: readonly Prompt[], first?: string): Prompt {
  return { text: [...(first === undefined ? [] : [first]), ...prompts.map((prompt) => prompt.text)].join("\n\n"), images: prompts.flatMap((prompt) => prompt.images) };
}

export function attachmentFile(folder: string, attachment: Attachment): string {
  return join(folder, "attachments", attachment.id, storedName(attachment.name));
}

interface Asked {
  readonly resolve: (part: AttachmentPart) => void;
  readonly reject: (error: Error) => void;
}

interface Work {
  record: WorkRecord;
  readonly paths: WorkPaths;
  seq: number;
  live: boolean;
  task: WorkTask | undefined;
  assignment: TaskAssignment | undefined;
  handle: ProgramHandle | undefined;
  turn: boolean;
  queue: Prompt[];
  messages: Set<string>;
  inbox: Promise<void>;
  generation: number;
  ran: boolean;
  freshTried: boolean;
  stopping: boolean;
  pid: number | undefined;
}

export function createWorks(options: WorksOptions): Works {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const adapters = options.adapters ?? defaultAdapters;
  const find = options.findProgram ?? ((executable: string) => findExecutable(executable, options.environment, process.platform));
  const run = options.run ?? runProcess;
  const remote = options.remote ?? gitHubRemote;
  const gh = find("gh") ?? "gh";
  const shims = shimFolder(options.home);
  const clean = withoutCredentials(options.environment);
  const identities = new Map<string, Identity | undefined>();
  try {
    writeGhShims(shims, gh);
  } catch (error) {
    log(`Could not write the gh shim in ${shims}: ${messageOf(error)}`);
  }
  const readPullRequest = options.readPullRequest ?? readPullRequestWith(run, gh);
  const works = new Map<number, Work>();
  const asked = new Map<string, Asked>();
  const tasks = new Set<Promise<void>>();
  let closing = false;

  const track = (task: Promise<void>) => {
    const tracked = task.catch((error: unknown) => log(`Work task failed: ${messageOf(error)}`)).finally(() => tasks.delete(tracked));
    tasks.add(tracked);
  };

  const recordFile = (work: Work) => join(work.paths.folder, "work.json");
  const eventsFile = (paths: WorkPaths, attempt: number) => join(paths.folder, `events-${attempt}.jsonl`);

  const save = (work: Work) => {
    mkdirSync(work.paths.folder, { recursive: true });
    const file = recordFile(work);
    const content = JSON.stringify(work.record);
    writeFileSync(`${file}.new`, content);
    replaceFile(`${file}.new`, file, content);
  };

  const lastSeq = (paths: WorkPaths, attempt: number): number => {
    const file = eventsFile(paths, attempt);
    if (!existsSync(file)) {
      return 0;
    }
    let last = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      try {
        last = Math.max(last, EventLine.parse(JSON.parse(line)).seq);
      } catch {
        continue;
      }
    }
    return last;
  };

  const messageIds = (paths: WorkPaths, attempt: number): Set<string> => {
    const ids = new Set<string>();
    const file = eventsFile(paths, attempt);
    if (!existsSync(file)) {
      return ids;
    }
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const event: unknown = EventLine.parse(JSON.parse(line)).event;
        if (typeof event === "object" && event !== null && Reflect.get(event, "kind") === "message") {
          ids.add(String(Reflect.get(event, "id")));
        }
      } catch {
        continue;
      }
    }
    return ids;
  };

  const load = () => {
    const folder = join(options.home, "work");
    if (!existsSync(folder)) {
      return;
    }
    for (const name of readdirSync(folder)) {
      try {
        const record = WorkRecord.parse(JSON.parse(readFileSync(join(folder, name, "work.json"), "utf8")));
        const folderOf = record.folder ?? record.ticket;
        const paths = record.kind === "task" ? taskPaths(options.home, record.ticket, record.repository === "" ? null : record.repository, folderOf) : workPaths(options.home, record.repository, record.ticket, folderOf);
        works.set(record.ticket, blank(record, paths));
      } catch {
        continue;
      }
    }
  };

  const blank = (record: WorkRecord, paths: WorkPaths): Work => ({
    record,
    paths,
    seq: lastSeq(paths, record.attempt),
    live: false,
    task: undefined,
    assignment: undefined,
    handle: undefined,
    turn: false,
    queue: [],
    messages: messageIds(paths, record.attempt),
    inbox: Promise.resolve(),
    generation: 0,
    ran: false,
    freshTried: false,
    stopping: false,
    pid: undefined,
  });

  const emit = (work: Work, event: WorkEvent) => {
    work.seq += 1;
    const at = now();
    mkdirSync(work.paths.folder, { recursive: true });
    appendFileSync(eventsFile(work.paths, work.record.attempt), `${JSON.stringify({ seq: work.seq, at, event })}\n`);
    options.send({ type: "work.event", ticket: work.record.ticket, attempt: work.record.attempt, seq: work.seq, at, event });
  };

  const changed = () => {
    try {
      options.changed?.();
    } catch {
      return;
    }
  };

  interface Credentialed {
    readonly environment: Readonly<Record<string, string>>;
    readonly account: GitHubAccount;
  }

  const tokenOf = (task: Credentialed): string => task.environment["GH_TOKEN"] ?? task.environment["GITHUB_TOKEN"] ?? "";

  const environmentOf = (task: Credentialed): Record<string, string> =>
    mergeEnvironment(clean, { ...task.environment, ...workerEnvironment(options.environment, tokenOf(task), shims, identities.get(task.account)) });

  const credentialedOf = (assignment: TaskAssignment): Credentialed | undefined =>
    assignment.checkout === null ? undefined : { environment: assignment.environment, account: assignment.checkout.account };

  const learnIdentity = async (task: Credentialed) => {
    if (identities.get(task.account) !== undefined) {
      return;
    }
    identities.set(task.account, await readIdentity(run, gh, environmentOf(task), options.home));
  };

  const gitFor = (task: Credentialed): Git => createGit(run, environmentOf(task), find("git") ?? "git");

  const placeOf = (work: Work, assignment: TaskAssignment) => taskPlace(work.paths, assignment.checkout, work.record.commit, options.machine);

  const place = (work: Work): BriefPlace => ({ worktree: work.paths.worktree, base: work.record.base ?? "the default branch", handback: work.paths.handback });

  const closeHandle = async (work: Work) => {
    const handle = work.handle;
    work.handle = undefined;
    work.turn = false;
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (work.pid !== undefined) {
      options.ledger?.remove(work.pid);
      work.pid = undefined;
    }
  };

  const end = async (work: Work, event: WorkEvent) => {
    if (work.record.ended) {
      return;
    }
    work.generation += 1;
    work.stopping = true;
    await closeHandle(work);
    work.live = false;
    work.record = { ...work.record, ended: true };
    save(work);
    emit(work, event);
    changed();
  };

  const startTurn = (work: Work, prompt: string, images: readonly PromptImage[] = []) => {
    const handle = work.handle;
    if (handle === undefined || work.record.ended) {
      return;
    }
    work.generation += 1;
    work.turn = true;
    emit(work, { kind: "phase", phase: "turn", detail: "The worker is working" });
    try {
      handle.start(prompt, images);
    } catch (error) {
      track(end(work, { kind: "failed", failure: "program", reason: messageOf(error) }));
    }
  };

  const reportRan = (work: Work, model: string | undefined, effort: string | null | undefined) => {
    if (work.ran && model === undefined) {
      return;
    }
    work.ran = true;
    emit(work, { kind: "ran", model: model ?? work.record.model, effort: effort ?? work.record.effort });
  };

  type Checked = { readonly ok: true; readonly event: WorkEvent } | { readonly ok: false; readonly problem: string };

  const checked = async (work: Work): Promise<Checked | undefined> => {
    if (work.assignment !== undefined) {
      const outcome = checkTaskHandback({ paths: work.paths });
      if (!outcome.ok) {
        return outcome;
      }
      return {
        ok: true,
        event: {
          kind: "delivered",
          outcome: outcome.outcome,
          ...(work.record.commit === null ? {} : { commit: work.record.commit }),
          text: outcome.text,
          files: [...outcome.files],
          report: outcome.report,
          ...(outcome.decisions.length === 0 ? {} : { decisions: [...outcome.decisions] }),
        },
      };
    }
    const task = work.task;
    if (task === undefined) {
      return undefined;
    }
    const outcome = await checkHandback({
      path: work.paths.handback,
      repository: work.record.repository,
      branch: work.record.branch,
      issues: work.record.issues.map((issue) => issue.number),
      merged: task.merged ?? [],
      environment: environmentOf(task),
      cwd: work.paths.worktree,
      read: readPullRequest,
    });
    return outcome.ok
      ? {
          ok: true,
          event: {
            kind: "finished",
            pullRequest: outcome.pullRequest,
            url: outcome.url,
            closes: [...outcome.closes],
            report: outcome.report,
            ...(outcome.decisions.length === 0 ? {} : { decisions: [...outcome.decisions] }),
          },
        }
      : outcome;
  };

  const check = async (work: Work) => {
    if (work.task === undefined && work.assignment === undefined) {
      return;
    }
    const generation = work.generation;
    emit(work, {
      kind: "phase",
      phase: "checking",
      detail: work.assignment === undefined ? "Checking the hand-back and the pull request" : "Checking the hand-back and the files to deliver",
    });
    const outcome = await checked(work);
    if (outcome === undefined || generation !== work.generation || work.record.ended || work.stopping) {
      return;
    }
    if (outcome.ok) {
      await end(work, outcome.event);
      return;
    }
    emit(work, { kind: "message", id: randomUUID(), from: "hub", text: outcome.problem, delivery: "steered" });
    startTurn(work, `[hub] ${outcome.problem}`);
  };

  const openProgram = (work: Work, task: WorkTask | TaskAssignment, session: string | null): void => {
    const credentialed = "repository" in task ? task : credentialedOf(task);
    const environment = credentialed === undefined ? mergeEnvironment(clean, {}) : environmentOf(credentialed);
    const program = find(engineExecutables[task.engine]);
    if (program === undefined) {
      throw new Error(`${engineExecutables[task.engine]} is not installed on this machine`);
    }
    const adapter = adapters(task.engine, {
      program,
      model: task.model,
      effort: task.effort,
      environment,
      clock: { now },
      client: "super-agent2-worker",
      codexConfig: workerCodexConfig,
      processTree: true,
    });
    const handle = adapter.open({ session, tools: null, workspace: work.paths.worktree }, (event) => onProgram(work, handle, event));
    work.handle = handle;
    const pid = handle.processId?.();
    if (pid !== undefined) {
      work.pid = pid;
      options.ledger?.add(pid);
    }
  };

  const onProgram = (work: Work, handle: ProgramHandle, event: ProgramEvent) => {
    if (work.handle !== handle || work.record.ended || work.stopping) {
      return;
    }
    switch (event.type) {
      case "session":
        work.record = { ...work.record, session: event.session };
        save(work);
        emit(work, { kind: "session", session: event.session });
        return;
      case "model":
        reportRan(work, event.model, event.effort);
        return;
      case "text":
        if (!work.ran) {
          reportRan(work, undefined, undefined);
        }
        emit(work, { kind: "text", block: event.block, delta: event.delta });
        return;
      case "tool.started":
        if (!work.ran) {
          reportRan(work, undefined, undefined);
        }
        emit(work, { kind: "tool.started", call: event.call, name: event.name, input: event.input });
        return;
      case "tool.output":
        emit(work, { kind: "tool.output", call: event.call, delta: event.delta });
        return;
      case "tool.finished":
        emit(work, { kind: "tool.finished", call: event.call, output: event.output, ok: event.ok });
        return;
      case "turn.finished": {
        work.turn = false;
        if (!work.ran) {
          reportRan(work, undefined, undefined);
        }
        const queued = work.queue.splice(0);
        if (queued.length > 0) {
          const next = joined(queued);
          startTurn(work, next.text, next.images);
          return;
        }
        track(check(work));
        return;
      }
      case "failed":
        if (event.lostSession && !work.freshTried && (work.task !== undefined || work.assignment !== undefined)) {
          work.freshTried = true;
          const task = work.task;
          const assignment = work.assignment;
          track(
            (async () => {
              await closeHandle(work);
              work.record = { ...work.record, session: null };
              save(work);
              if (assignment !== undefined) {
                openProgram(work, assignment, null);
                startTurn(work, taskBrief({ ...assignment, note: taskLostSessionNote() }, placeOf(work, assignment)));
              } else if (task !== undefined) {
                openProgram(work, task, null);
                startTurn(work, brief({ ...task, note: lostSessionNote() }, place(work)));
              }
            })().catch((error: unknown) => end(work, { kind: "failed", failure: "program", reason: messageOf(error) })),
          );
          return;
        }
        track(end(work, { kind: "failed", failure: "program", reason: event.reason }));
        return;
      case "unavailable": {
        const unsent = work.queue.splice(0).flatMap((prompt) => (prompt.id === undefined ? [] : [prompt.id]));
        track(end(work, { kind: "unavailable", reason: event.reason, until: event.until, unsent }));
        return;
      }
    }
  };

  const begin = async (work: Work, task: WorkTask) => {
    emit(work, { kind: "phase", phase: "preparing", detail: `Preparing ${task.repository} on branch ${task.branch}` });
    await learnIdentity(task).catch(() => undefined);
    const git = gitFor(task);
    let prepared;
    try {
      prepared = await prepareWorktree(git, remote, task.repository, task.branch, work.paths);
    } catch (error) {
      await end(work, { kind: "failed", failure: "prepare", reason: messageOf(error) });
      return;
    }
    if (work.task !== task || work.stopping) {
      return;
    }
    work.record = { ...work.record, base: prepared.base };
    save(work);
    emit(work, {
      kind: "phase",
      phase: "prepared",
      detail: prepared.created
        ? `Created the worktree ${work.paths.worktree} on ${task.branch} from ${prepared.from}`
        : prepared.switched
          ? `Switched the worktree ${work.paths.worktree} to the new branch ${task.branch} from ${prepared.from}${
              prepared.leftover === null
                ? ""
                : prepared.leftover.carried
                  ? `, carrying over the uncommitted changes found there (a copy is on ${prepared.leftover.branch})`
                  : `; the uncommitted changes found there did not apply cleanly and are kept on ${prepared.leftover.branch}`
            }`
          : `Reusing the worktree ${work.paths.worktree} on ${task.branch}`,
    });
    const session = task.session ?? work.record.session;
    try {
      openProgram(work, task, session);
    } catch (error) {
      await end(work, { kind: "failed", failure: "program", reason: messageOf(error) });
      return;
    }
    const where = place(work);
    const waiting = work.queue.splice(0);
    const leftover = prepared.leftover === null ? [] : [leftoverText({ ...prepared.leftover, into: task.branch, base: prepared.base })];
    const state = task.takeover ? [takeoverText(await folderState(git, work.paths.worktree, prepared.base), task.branch, prepared.base)] : [];
    if (work.task !== task || work.stopping) {
      return;
    }
    const withWaiting = (prompt: string) => {
      const next = joined(waiting, [prompt, ...leftover, ...state].join("\n\n"));
      startTurn(work, next.text, next.images);
    };
    if (session === null) {
      emit(work, { kind: "phase", phase: "started", detail: `Started ${task.engine} with ${task.model} at ${task.effort}` });
      withWaiting(brief(task, where));
      return;
    }
    emit(work, { kind: "phase", phase: "resumed", detail: `Resumed the ${task.engine} session ${session} with ${task.model} at ${task.effort}` });
    withWaiting(task.note === null ? resumeText(task, where) : continueText(task, where, task.note));
  };

  const beginTask = async (work: Work, task: TaskAssignment) => {
    emit(work, { kind: "phase", phase: "preparing", detail: `Preparing the scratch folder ${scratchFolder(work.paths)}${task.checkout === null ? "" : ` and a checkout of ${task.checkout.repository}`}` });
    const details: string[] = [];
    try {
      const files = new Map<string, string>();
      for (const material of task.materials) {
        if (material.attachment !== null && material.attachment !== undefined) {
          files.set(material.name, await fetchAttachment(work, task.attempt, material.attachment));
        }
      }
      if (work.assignment !== task || work.stopping) {
        return;
      }
      prepareScratch(work.paths, task.materials, files);
      details.push(`Prepared the scratch folder ${scratchFolder(work.paths)} with ${task.materials.length} material(s)`);
      const credentialed = credentialedOf(task);
      if (task.checkout !== null && credentialed !== undefined) {
        await learnIdentity(credentialed).catch(() => undefined);
        const checkout = await prepareCheckout(gitFor(credentialed), remote, task.checkout, work.paths);
        if (work.assignment !== task || work.stopping) {
          return;
        }
        work.record = { ...work.record, commit: checkout.commit, base: checkout.base };
        save(work);
        details.push(`${checkout.created ? "Checked out" : "Kept the checkout of"} ${task.checkout.repository} at ${checkout.commit} in ${work.paths.worktree}`);
        if (task.deploys) {
          const problem = deploymentProblem(readDeploymentAt(work.paths.worktree), options.machine, checkout.commit);
          if (problem !== undefined) {
            await end(work, { kind: "failed", failure: "prepare", reason: problem });
            return;
          }
        }
      }
    } catch (error) {
      await end(work, { kind: "failed", failure: "prepare", reason: messageOf(error) });
      return;
    }
    if (work.assignment !== task || work.stopping) {
      return;
    }
    emit(work, { kind: "phase", phase: "prepared", detail: details.join("; ") });
    const session = task.session ?? work.record.session;
    try {
      openProgram(work, task, session);
    } catch (error) {
      await end(work, { kind: "failed", failure: "program", reason: messageOf(error) });
      return;
    }
    const where = placeOf(work, task);
    const waiting = work.queue.splice(0);
    const credentialedNow = credentialedOf(task);
    const checkoutState = task.takeover && task.checkout !== null && credentialedNow !== undefined ? await folderState(gitFor(credentialedNow), work.paths.worktree, null) : null;
    const state = task.takeover ? [takeoverTaskText(listOutput(work.paths), checkoutState, where)] : [];
    if (work.assignment !== task || work.stopping) {
      return;
    }
    const withWaiting = (prompt: string) => {
      const next = joined(waiting, [prompt, ...state].join("\n\n"));
      startTurn(work, next.text, next.images);
    };
    if (session === null) {
      emit(work, { kind: "phase", phase: "started", detail: `Started ${task.engine} with ${task.model} at ${task.effort}` });
      withWaiting(taskBrief(task, where));
      return;
    }
    emit(work, { kind: "phase", phase: "resumed", detail: `Resumed the ${task.engine} session ${session} with ${task.model} at ${task.effort}` });
    withWaiting(task.note === null ? taskResumeText(task, where) : taskContinueText(where, task.note));
  };

  const start = async (given: { readonly code: WorkTask } | { readonly assignment: TaskAssignment }) => {
    const task = "code" in given ? given.code : given.assignment;
    const existing = works.get(task.ticket);
    if (existing !== undefined && existing.record.attempt === task.attempt && (existing.live || existing.record.ended)) {
      return;
    }
    if (existing?.live === true) {
      existing.stopping = true;
      existing.generation += 1;
      await closeHandle(existing);
      existing.live = false;
    }
    const folderOf = task.folder ?? task.ticket;
    const paths = "code" in given ? workPaths(options.home, given.code.repository, task.ticket, folderOf) : taskPaths(options.home, task.ticket, given.assignment.checkout?.repository ?? null, folderOf);
    const sameAttempt = existing !== undefined && existing.record.attempt === task.attempt;
    if (existing !== undefined && !sameAttempt) {
      for (const name of existsSync(paths.folder) ? readdirSync(paths.folder) : []) {
        if (name.startsWith("events-")) {
          rmSync(join(paths.folder, name), { force: true });
        }
      }
      rmSync(paths.handback, { force: true });
      if ("assignment" in given && !given.assignment.takeover) {
        clearOutput(paths);
      }
    }
    const record: WorkRecord = {
      kind: "code" in given ? "code" : "task",
      ticket: task.ticket,
      attempt: task.attempt,
      repository: "code" in given ? given.code.repository : (given.assignment.checkout?.repository ?? ""),
      branch: "code" in given ? given.code.branch : "",
      title: task.title,
      issues: "code" in given ? given.code.issues : [],
      engine: task.engine,
      model: task.model,
      effort: task.effort,
      session: sameAttempt ? existing.record.session : null,
      base: sameAttempt ? existing.record.base : null,
      commit: existing === undefined ? null : existing.record.commit,
      folder: task.folder ?? null,
      ended: false,
    };
    const work = blank(record, paths);
    work.live = true;
    if ("code" in given) {
      work.task = given.code;
    } else {
      work.assignment = given.assignment;
    }
    works.set(task.ticket, work);
    save(work);
    changed();
    if ("code" in given) {
      await begin(work, given.code);
    } else {
      await beginTask(work, given.assignment);
    }
  };

  const sync = (ticket: number, attempt: number, after: number) => {
    const work = works.get(ticket);
    if (work === undefined || work.record.attempt !== attempt) {
      return;
    }
    const file = eventsFile(work.paths, attempt);
    if (!existsSync(file)) {
      return;
    }
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      let parsed;
      try {
        parsed = EventLine.parse(JSON.parse(line));
      } catch {
        continue;
      }
      if (parsed.seq > after) {
        options.send({ type: "work.event", ticket, attempt, seq: parsed.seq, at: parsed.at, event: parsed.event as WorkEvent });
      }
    }
  };

  const serveFile = async (asked: FetchFile) => {
    const reply = (data: string | null, problem: string | null) =>
      options.send({ type: "work.file.part", ticket: asked.ticket, attempt: asked.attempt, name: asked.name, offset: asked.offset, data, problem });
    const work = works.get(asked.ticket);
    if (work === undefined || work.record.attempt !== asked.attempt || work.record.kind !== "task") {
      reply(null, `This machine has no task work for ticket ${asked.ticket}, attempt ${asked.attempt}`);
      return;
    }
    const length = Math.min(asked.length, filePartBytes);
    try {
      const handle = await open(join(outputFolder(work.paths), asked.name), "r");
      try {
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, asked.offset + read);
          if (bytesRead === 0) {
            break;
          }
          read += bytesRead;
        }
        reply(buffer.subarray(0, read).toString("base64"), null);
      } finally {
        await handle.close();
      }
    } catch (error) {
      reply(null, messageOf(error));
    }
  };

  const requestPart = (ticket: number, attempt: number, attachment: string, offset: number, length: number): Promise<AttachmentPart> =>
    new Promise((resolve, reject) => {
      const key = `${ticket}:${attachment}:${offset}`;
      asked.get(key)?.reject(new Error("asked again"));
      asked.set(key, { resolve, reject });
      try {
        options.send({ type: "work.attachment", ticket, attempt, attachment, offset, length });
      } catch (error) {
        asked.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const fetchAttachment = async (work: Work, attempt: number, attachment: Attachment): Promise<string> => {
    const file = attachmentFile(work.paths.folder, attachment);
    mkdirSync(join(file, ".."), { recursive: true });
    if (!existsSync(file)) {
      writeFileSync(file, "");
    }
    let have = statSync(file).size;
    if (have > attachment.size) {
      truncateSync(file, 0);
      have = 0;
    }
    while (have < attachment.size) {
      const part = await requestPart(work.record.ticket, attempt, attachment.id, have, Math.min(attachmentPartBytes, attachment.size - have));
      const data = part.data === null ? undefined : Buffer.from(part.data, "base64");
      if (data === undefined || data.length === 0 || have + data.length > attachment.size) {
        throw new Error(`The hub could not send the attachment ${attachment.name} from byte ${have}: ${part.problem ?? "the part was empty or too long"}`);
      }
      appendFileSync(file, data);
      have += data.length;
    }
    return file;
  };

  const receivePart = (part: AttachmentPart) => {
    const key = `${part.ticket}:${part.attachment}:${part.offset}`;
    const waiting = asked.get(key);
    if (waiting !== undefined) {
      asked.delete(key);
      waiting.resolve(part);
    }
  };

  const deliverMessage = async (work: Work, incoming: MessageWork) => {
    const { id, from, text } = incoming;
    const attachments = incoming.attachments ?? [];
    let files: AttachedFile[];
    try {
      files = [];
      for (const attachment of attachments) {
        files.push({ attachment, path: await fetchAttachment(work, incoming.attempt, attachment) });
      }
    } catch (error) {
      work.messages.delete(id);
      log(`Could not fetch the attachments of message ${id} for ticket ${incoming.ticket}: ${messageOf(error)}`);
      return;
    }
    if (!work.live || work.record.ended || work.record.attempt !== incoming.attempt) {
      return;
    }
    const prompt: Prompt = {
      text: messageText(from, text, files),
      images: files
        .filter((file) => isNativeImage(file.attachment.mediaType))
        .map((file) => ({ path: file.path, mediaType: file.attachment.mediaType, size: file.attachment.size })),
    };
    const shown = attachments.length === 0 ? {} : { attachments };
    if (work.turn && work.handle !== undefined) {
      const delivery = await work.handle.steer(prompt.text, prompt.images);
      if (delivery === "queued") {
        work.queue.push({ ...prompt, id });
      }
      emit(work, { kind: "message", id, from, text, ...shown, delivery });
      return;
    }
    if (work.handle === undefined) {
      work.queue.push({ ...prompt, id });
      emit(work, { kind: "message", id, from, text, ...shown, delivery: "queued" });
      return;
    }
    emit(work, { kind: "message", id, from, text, ...shown, delivery: "steered" });
    startTurn(work, prompt.text, prompt.images);
  };

  const message = (incoming: MessageWork) => {
    const work = works.get(incoming.ticket);
    if (work === undefined || work.record.attempt !== incoming.attempt || !work.live || work.record.ended || work.messages.has(incoming.id)) {
      return Promise.resolve();
    }
    work.messages.add(incoming.id);
    const next = work.inbox.then(() => deliverMessage(work, incoming));
    work.inbox = next.catch(() => undefined);
    return next;
  };

  const stop = async (ticket: number, keep: boolean, remove: boolean) => {
    const work = works.get(ticket);
    if (work === undefined) {
      return;
    }
    const task = work.task;
    const open = !work.record.ended;
    work.stopping = true;
    work.generation += 1;
    await closeHandle(work);
    work.live = false;
    changed();
    let saved = { saved: false, detail: "Stopped" };
    if (keep && task !== undefined) {
      emit(work, { kind: "phase", phase: "saving", detail: "Saving the work on the branch" });
      saved = await saveWork(gitFor(task), ticket, work.record.branch, work.paths).catch((error: unknown) => ({ saved: false, detail: messageOf(error) }));
    }
    if (open || (keep && task !== undefined)) {
      if (open) {
        work.record = { ...work.record, ended: true };
        save(work);
      }
      emit(work, { kind: "stopped", saved: saved.saved, detail: saved.detail });
    }
    if (remove) {
      const git = task === undefined ? createGit(run, mergeEnvironment(clean, {}), find("git") ?? "git") : gitFor(task);
      await removeWorktree(git, work.record.branch, work.paths).catch((error: unknown) => log(`Could not remove the worktree of ticket ${ticket}: ${messageOf(error)}`));
      emit(work, {
        kind: "phase",
        phase: "removed",
        detail: work.record.kind === "task" ? `Removed the scratch folder${work.record.repository === "" ? "" : ` and the checkout ${work.paths.worktree}`}` : `Removed the worktree ${work.paths.worktree}`,
      });
      rmSync(work.paths.folder, { recursive: true, force: true });
      if (works.get(ticket) === work) {
        works.delete(ticket);
      }
    }
    changed();
  };

  load();

  return {
    held: () =>
      [...works.values()].map((work) => ({
        ticket: work.record.ticket,
        attempt: work.record.attempt,
        last: work.seq,
        live: work.live,
        ended: work.record.ended,
      })),
    busy: () => [...works.values()].filter((work) => work.live).length,
    receive: (incoming) => {
      if (closing) {
        return;
      }
      switch (incoming.type) {
        case "work.start":
          track(start({ code: incoming.task }));
          return;
        case "work.task":
          track(start({ assignment: incoming.task }));
          return;
        case "work.sync":
          sync(incoming.ticket, incoming.attempt, incoming.after);
          return;
        case "work.message":
          track(message(incoming));
          return;
        case "work.attachment.part":
          receivePart(incoming);
          return;
        case "work.stop":
          track(stop(incoming.ticket, incoming.save, incoming.remove));
          return;
        case "work.file":
          track(serveFile(incoming));
          return;
      }
    },
    disconnected: () => {
      const waiting = [...asked.values()];
      asked.clear();
      for (const entry of waiting) {
        entry.reject(new Error("The link to the hub closed"));
      }
    },
    idle: async () => {
      while (tasks.size > 0) {
        await Promise.all([...tasks]);
      }
    },
    close: async () => {
      closing = true;
      for (const work of works.values()) {
        work.stopping = true;
        work.generation += 1;
      }
      await Promise.all([...works.values()].map((work) => closeHandle(work)));
      await Promise.all([...tasks]);
    },
  };
}
