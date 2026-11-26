import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellInvocation, windowsPowerShell } from "@super-agent2/programs";
import type { CancelCheck, CheckReply, CheckResult, RunCheck } from "@super-agent2/protocol";
import { createGit, runProcess } from "./git.js";
import type { Ledger } from "./ledger.js";
import { findExecutable } from "./programs.js";
import { killTree } from "./shell.js";
import { ticketArtifacts, type StorageSelection } from "./storage.js";
import { existingProjectCheckout, gitHubRemote, type RemoteUrl, workPaths } from "./workplace.js";

type Environment = Readonly<Record<string, string | undefined>>;
type TerminalCheck = Exclude<CheckResult, { state: "busy" }>;

export interface ChecksOptions {
  readonly home: string;
  readonly environment: Environment;
  readonly storage: () => StorageSelection;
  readonly available: () => boolean;
  readonly send: (reply: CheckReply) => void;
  readonly changed: () => void;
  readonly log?: (line: string) => void;
  readonly ledger?: Ledger;
  readonly remote?: RemoteUrl;
}

const runtimeNames = /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|SYSTEMDRIVE|LANG|LC_[A-Z_]+|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432)$/i;
const profileNames = /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR)$/i;

function selectEnvironment(env: Environment, names: RegExp): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value !== undefined && names.test(name) ? [[name.toUpperCase(), value]] : []));
}

function excerpt(path: string): string {
  const file = openSync(path, "r");
  try {
    const size = fstatSync(file).size;
    const text = Buffer.alloc(Math.min(size, 24_000));
    const read = readSync(file, text, 0, text.length, size - text.length);
    return text.subarray(0, read).toString("utf8");
  } finally {
    closeSync(file);
  }
}

async function runCommand(command: string, cwd: string, env: Record<string, string>, artifact: string, signal: AbortSignal, ledger?: Ledger): Promise<number | null> {
  const { file, args, shell } = shellInvocation(command, process.platform === "win32" ? windowsPowerShell(env) : undefined);
  const output = openSync(artifact, "w", 0o600);
  try {
    if (signal.aborted) return null;
    const child = spawn(file, args, { cwd, env, shell, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", output, output] });
    const pid = child.pid;
    const abort = () => { if (pid !== undefined) void killTree(pid); };
    signal.addEventListener("abort", abort, { once: true });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      if (pid !== undefined) ledger?.add(pid);
      return await done;
    } catch (error) {
      abort();
      await done.catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (pid !== undefined) ledger?.remove(pid);
    }
  } finally {
    closeSync(output);
  }
}

async function execute(request: RunCheck, options: ChecksOptions, signal: AbortSignal): Promise<TerminalCheck> {
  const gitProgram = findExecutable("git", options.environment, process.platform);
  if (gitProgram === undefined) return { state: "unavailable", reason: "Git is not installed" };
  const storage = options.storage();
  const scratch = mkdtempSync(join(tmpdir(), "super-agent2-check-"));
  try {
    const profile = join(scratch, "profile");
    const checkout = join(scratch, "checkout");
    const hooks = join(scratch, "hooks");
    const temporary = join(profile, "tmp");
    for (const directory of [checkout, hooks, temporary]) mkdirSync(directory, { recursive: true });
    const runtime = selectEnvironment(options.environment, runtimeNames);
    const env = {
      ...runtime, CI: "true", HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
      TMP: temporary, TEMP: temporary, TMPDIR: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    };
    const git = createGit((file, args, context) => runProcess(file, args, { ...context, signal }), env, gitProgram);
    const cached = workPaths(options.home, request.repository, request.ticket).clone;
    const source = existsSync(join(cached, ".git")) ? cached : storage.projectsDir === undefined ? undefined
      : await existingProjectCheckout(git, storage.projectsDir, request.repository);
    if (source === undefined) return { state: "unavailable", reason: "The repository has no checkout on this runner" };

    await git.must(["init", "--quiet", "--template="], checkout);
    await git.must(["config", "--local", "core.hooksPath", hooks], checkout);
    const found = await git.run(["cat-file", "-t", request.head], source);
    const fetchArgs = ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--"];
    if (found.code === 0 && found.stdout.trim() === "commit") {
      await git.must([...fetchArgs, source, request.head], checkout);
    } else {
      const fetchEnv = { ...runtime, ...selectEnvironment(options.environment, profileNames), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
      const networkGit = createGit((file, args, context) => runProcess(file, args, { ...context, signal }), fetchEnv, gitProgram);
      await networkGit.must([...fetchArgs, (options.remote ?? gitHubRemote)(request.repository), `refs/pull/${request.pullRequest}/head`], checkout);
    }
    await git.must(["checkout", "--detach", "--quiet", request.head], checkout);
    if ((await git.must(["rev-parse", "HEAD"], checkout)).trim() !== request.head) throw new Error("Git did not check out the requested head");

    const folder = await ticketArtifacts(options.home, storage.artifactsDir, request.repository, request.ticket);
    const artifact = join(folder.path, `check-${request.head.slice(0, 12)}-${request.id}.log`);
    const exitCode = await runCommand(request.command, checkout, env, artifact, signal, options.ledger);
    if (signal.aborted || exitCode === null) return { state: "unavailable", reason: "The check process was interrupted" };
    return { state: "finished", exitCode, artifact, output: excerpt(artifact) };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      options.log?.(`Could not remove the repository check checkout at ${scratch}`);
    }
  }
}

export function createChecks(options: ChecksOptions) {
  const active = new Map<string, { id: string; controller: AbortController; done: Promise<void> }>();
  const completed = new Map<string, TerminalCheck>();
  let closed = false;
  const reply = (id: string, result: CheckResult) => options.send({ type: "check.reply", id, result });
  const remember = (id: string, result: TerminalCheck) => {
    completed.set(id, result);
    if (completed.size > 64) completed.delete(completed.keys().next().value!);
  };

  return {
    busy: () => active.size,
    receive: (request: RunCheck | CancelCheck) => {
      if (closed) return;
      if (request.type === "check.cancel") {
        const job = [...active.values()].find(({ id }) => id === request.id);
        if (job === undefined) {
          const result = { state: "unavailable", reason: "The check is no longer active" } as const;
          remember(request.id, result);
          reply(request.id, result);
        } else job.controller.abort();
        return;
      }
      const saved = completed.get(request.id);
      if (saved !== undefined) { reply(request.id, saved); return; }
      const repository = request.repository.toLowerCase();
      const running = active.get(repository);
      if (running?.id === request.id) return;
      if (running !== undefined || !options.available()) { reply(request.id, { state: "busy" }); return; }

      const controller = new AbortController();
      const done = (async () => {
        let result: TerminalCheck;
        try {
          result = await execute(request, options, controller.signal);
        } catch (error) {
          const reason = String(error instanceof Error ? error.message : error);
          result = { state: "unavailable", reason: reason.slice(0, 1000) };
        }
        active.delete(repository);
        remember(request.id, result);
        options.changed();
        if (!closed) reply(request.id, result);
      })();
      active.set(repository, { id: request.id, controller, done });
      options.changed();
    },
    close: async () => {
      closed = true;
      for (const job of active.values()) job.controller.abort();
      await Promise.all([...active.values()].map(({ done }) => done));
    },
  };
}
