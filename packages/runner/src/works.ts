import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter, codexAdapter, dshAdapter, type ProgramAdapter, type ProgramEvent, type ProgramHandle, type ProgramSettings } from "@super-agent2/programs";
import {
  type HubToRunner,
  type RunnerToHub,
  WorkEngine,
  type WorkEvent,
  type WorkHeld,
  WorkIssue,
  type WorkSender,
  type WorkTask,
} from "@super-agent2/protocol";
import { z } from "zod";
import { brief, type BriefPlace, continueText, lostSessionNote, messageText, resumeText } from "./brief.js";
import { createGit, type Git, type ProcessRunner, runProcess } from "./git.js";
import { type Identity, readIdentity, shimFolder, workerEnvironment, writeGhShims } from "./identity.js";
import { checkHandback, type PullRequestReader, readPullRequestWith } from "./handback.js";
import type { Ledger } from "./ledger.js";
import { findExecutable } from "./programs.js";
import { mergeEnvironment } from "./shell.js";
import { gitHubRemote, prepareWorktree, type RemoteUrl, removeWorktree, saveWork, type WorkPaths, workPaths } from "./workplace.js";

export type WorkMessage = Extract<HubToRunner, { readonly type: "work.start" | "work.sync" | "work.message" | "work.stop" }>;

export type AdapterFactory = (engine: WorkEngine, settings: ProgramSettings) => ProgramAdapter;

export const engineExecutables: Readonly<Record<WorkEngine, string>> = { codex: "codex", claude: "claude", dsh: "dsh" };

export const defaultAdapters: AdapterFactory = (engine, settings) => {
  switch (engine) {
    case "codex":
      return codexAdapter(settings);
    case "claude":
      return claudeAdapter(settings);
    case "dsh":
      return dshAdapter(settings);
  }
};

export const workerCodexConfig: Readonly<Record<string, unknown>> = {
  "shell_environment_policy.inherit": "all",
  "shell_environment_policy.ignore_default_excludes": true,
};

export const maximumCorrections = 2;

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
}

export interface Works {
  held(): WorkHeld[];
  busy(): number;
  receive(message: WorkMessage): void;
  idle(): Promise<void>;
  close(): Promise<void>;
}

const WorkRecord = z.object({
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
  ended: z.boolean(),
});
type WorkRecord = z.infer<typeof WorkRecord>;

const EventLine = z.object({ seq: z.number().int().positive(), at: z.number().int(), event: z.unknown() });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Work {
  record: WorkRecord;
  readonly paths: WorkPaths;
  seq: number;
  live: boolean;
  task: WorkTask | undefined;
  handle: ProgramHandle | undefined;
  turn: boolean;
  queue: string[];
  corrections: number;
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
  const identities = new Map<string, Identity | undefined>();
  try {
    writeGhShims(shims, gh);
  } catch (error) {
    log(`Could not write the gh shim in ${shims}: ${messageOf(error)}`);
  }
  const readPullRequest = options.readPullRequest ?? readPullRequestWith(run, gh);
  const works = new Map<number, Work>();
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
    writeFileSync(`${file}.new`, JSON.stringify(work.record));
    renameSync(`${file}.new`, file);
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

  const load = () => {
    const folder = join(options.home, "work");
    if (!existsSync(folder)) {
      return;
    }
    for (const name of readdirSync(folder)) {
      try {
        const record = WorkRecord.parse(JSON.parse(readFileSync(join(folder, name, "work.json"), "utf8")));
        const paths = workPaths(options.home, record.repository, record.ticket);
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
    handle: undefined,
    turn: false,
    queue: [],
    corrections: 0,
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

  const tokenOf = (task: WorkTask): string => task.environment["GH_TOKEN"] ?? task.environment["GITHUB_TOKEN"] ?? "";

  const environmentOf = (task: WorkTask): Record<string, string> =>
    mergeEnvironment(options.environment, { ...task.environment, ...workerEnvironment(options.environment, tokenOf(task), shims, identities.get(task.account)) });

  const learnIdentity = async (task: WorkTask) => {
    if (identities.get(task.account) !== undefined) {
      return;
    }
    identities.set(task.account, await readIdentity(run, gh, environmentOf(task), options.home));
  };

  const gitFor = (task: WorkTask): Git => createGit(run, environmentOf(task), find("git") ?? "git");

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

  const startTurn = (work: Work, prompt: string) => {
    const handle = work.handle;
    if (handle === undefined || work.record.ended) {
      return;
    }
    work.generation += 1;
    work.turn = true;
    emit(work, { kind: "phase", phase: "turn", detail: "The worker is working" });
    try {
      handle.start(prompt);
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

  const check = async (work: Work) => {
    const task = work.task;
    if (task === undefined) {
      return;
    }
    const generation = work.generation;
    emit(work, { kind: "phase", phase: "checking", detail: "Checking the hand-back and the pull request" });
    const outcome = await checkHandback({
      path: work.paths.handback,
      repository: work.record.repository,
      branch: work.record.branch,
      issues: work.record.issues.map((issue) => issue.number),
      environment: environmentOf(task),
      cwd: work.paths.worktree,
      read: readPullRequest,
    });
    if (generation !== work.generation || work.record.ended || work.stopping) {
      return;
    }
    if (outcome.ok) {
      await end(work, { kind: "finished", pullRequest: outcome.pullRequest, url: outcome.url, report: outcome.report });
      return;
    }
    if (work.corrections >= maximumCorrections) {
      await end(work, { kind: "failed", failure: "no-pull-request", reason: outcome.problem });
      return;
    }
    work.corrections += 1;
    emit(work, { kind: "message", id: randomUUID(), from: "hub", text: outcome.problem, delivery: "steered" });
    startTurn(work, `[hub] ${outcome.problem}`);
  };

  const openProgram = (work: Work, task: WorkTask, session: string | null): void => {
    const environment = environmentOf(task);
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
          startTurn(work, queued.join("\n\n"));
          return;
        }
        track(check(work));
        return;
      }
      case "failed":
        if (event.lostSession && !work.freshTried && work.task !== undefined) {
          work.freshTried = true;
          const task = work.task;
          track(
            (async () => {
              await closeHandle(work);
              work.record = { ...work.record, session: null };
              save(work);
              openProgram(work, task, null);
              startTurn(work, brief({ ...task, note: lostSessionNote() }, place(work)));
            })().catch((error: unknown) => end(work, { kind: "failed", failure: "program", reason: messageOf(error) })),
          );
          return;
        }
        track(end(work, { kind: "failed", failure: "program", reason: event.reason }));
        return;
      case "unavailable":
        track(end(work, { kind: "failed", failure: "program", reason: event.reason }));
        return;
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
      detail: prepared.created ? `Created the worktree ${work.paths.worktree} on ${task.branch} from ${prepared.from}` : `Reusing the worktree ${work.paths.worktree} on ${task.branch}`,
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
    const withWaiting = (prompt: string) => [prompt, ...waiting].join("\n\n");
    if (session === null) {
      emit(work, { kind: "phase", phase: "started", detail: `Started ${task.engine} with ${task.model} at ${task.effort}` });
      startTurn(work, withWaiting(brief(task, where)));
      return;
    }
    emit(work, { kind: "phase", phase: "resumed", detail: `Resumed the ${task.engine} session ${session} with ${task.model} at ${task.effort}` });
    startTurn(work, withWaiting(task.note === null ? resumeText(task, where) : continueText(task, where, task.note)));
  };

  const start = async (task: WorkTask) => {
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
    const paths = workPaths(options.home, task.repository, task.ticket);
    const sameAttempt = existing !== undefined && existing.record.attempt === task.attempt;
    if (existing !== undefined && !sameAttempt) {
      for (const name of existsSync(paths.folder) ? readdirSync(paths.folder) : []) {
        if (name.startsWith("events-")) {
          rmSync(join(paths.folder, name), { force: true });
        }
      }
      rmSync(paths.handback, { force: true });
    }
    const record: WorkRecord = {
      ticket: task.ticket,
      attempt: task.attempt,
      repository: task.repository,
      branch: task.branch,
      title: task.title,
      issues: task.issues,
      engine: task.engine,
      model: task.model,
      effort: task.effort,
      session: sameAttempt ? existing.record.session : null,
      base: sameAttempt ? existing.record.base : null,
      ended: false,
    };
    const work = blank(record, paths);
    work.live = true;
    work.task = task;
    works.set(task.ticket, work);
    save(work);
    changed();
    await begin(work, task);
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

  const message = async (ticket: number, attempt: number, id: string, from: WorkSender, text: string) => {
    const work = works.get(ticket);
    if (work === undefined || work.record.attempt !== attempt || !work.live || work.record.ended) {
      return;
    }
    const prompt = messageText(from, text);
    if (work.turn && work.handle !== undefined) {
      const delivery = await work.handle.steer(prompt);
      if (delivery === "queued") {
        work.queue.push(prompt);
      }
      emit(work, { kind: "message", id, from, text, delivery });
      return;
    }
    if (work.handle === undefined) {
      work.queue.push(prompt);
      emit(work, { kind: "message", id, from, text, delivery: "queued" });
      return;
    }
    emit(work, { kind: "message", id, from, text, delivery: "steered" });
    startTurn(work, prompt);
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
      emit(work, { kind: "phase", phase: "saving", detail: "Saving the work on the branch before it moves" });
      saved = await saveWork(gitFor(task), ticket, work.record.branch, work.paths).catch((error: unknown) => ({ saved: false, detail: messageOf(error) }));
    }
    if (open) {
      work.record = { ...work.record, ended: true };
      save(work);
      emit(work, { kind: "stopped", saved: saved.saved, detail: saved.detail });
    }
    if (remove) {
      const git = task === undefined ? createGit(run, mergeEnvironment(options.environment, {}), find("git") ?? "git") : gitFor(task);
      await removeWorktree(git, work.record.branch, work.paths).catch((error: unknown) => log(`Could not remove the worktree of ticket ${ticket}: ${messageOf(error)}`));
      emit(work, { kind: "phase", phase: "removed", detail: `Removed the worktree ${work.paths.worktree}` });
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
          track(start(incoming.task));
          return;
        case "work.sync":
          sync(incoming.ticket, incoming.attempt, incoming.after);
          return;
        case "work.message":
          track(message(incoming.ticket, incoming.attempt, incoming.id, incoming.from, incoming.text));
          return;
        case "work.stop":
          track(stop(incoming.ticket, incoming.save, incoming.remove));
          return;
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
