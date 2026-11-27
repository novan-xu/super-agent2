import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shellInvocation, windowsPowerShell } from "@super-agent2/programs";
import type { TaskAssignment } from "@super-agent2/protocol";
import { createGit, findExecutable, githubRepository, gitConfigParameters, mergeEnvironment, tokenVariable, withoutCredentials, type Git, type ProcessRunner, runProcess } from "@super-agent2/runner";
import type { Environment } from "./settings.js";

export interface LocalSource {
  readonly repository: string;
  readonly checkout: string;
  readonly commit: string;
}

const sha = /^[0-9a-f]{40}$/;
const builds = (home: string) => join(home, "local-builds");
const runtime = (home: string, commit: string) => join(builds(home), commit);
const stamp = (home: string, commit: string) => join(builds(home), `${commit}.ready`);

function gitFor(environment: Environment, run: ProcessRunner, signal?: AbortSignal): Git {
  const env = mergeEnvironment(environment, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" });
  return createGit((file, args, options) => run(file, args, { ...options, ...(signal === undefined ? {} : { signal }) }),
    env, findExecutable("git", env, process.platform) ?? "git");
}

async function head(git: Git, checkout: string): Promise<string> {
  const commit = (await git.must(["rev-parse", "HEAD"], checkout)).trim();
  if (!sha.test(commit)) throw new Error("Git did not report a full commit SHA");
  return commit;
}

export async function readLocalSource(checkout: string, running: string, environment: Environment): Promise<LocalSource | undefined> {
  const git = gitFor(environment, runProcess);
  const origin = await git.run(["config", "--get", "remote.origin.url"], checkout);
  const repository = origin.code === 0 ? githubRepository(origin.stdout.trim()) : undefined;
  if (repository === undefined) return undefined;
  const commit = await head(git, running);
  return { repository, checkout, commit };
}

async function cleanCheckout(git: Git, checkout: string): Promise<void> {
  if ((await git.must(["status", "--porcelain", "--untracked-files=normal"], checkout)).trim() !== "") {
    throw new Error("The local installation checkout has uncommitted changes");
  }
  for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = (await git.must(["rev-parse", "--git-path", state], checkout)).trim();
    if (existsSync(resolve(checkout, path))) throw new Error("A Git operation is in progress in the local installation checkout");
  }
}

async function descendant(git: Git, checkout: string, commit: string): Promise<void> {
  if ((await git.run(["merge-base", "--is-ancestor", "HEAD", commit], checkout)).code !== 0) {
    throw new Error(`The local installation checkout cannot fast-forward to ${commit}`);
  }
}

async function verifyRuntime(git: Git, home: string, checkout: string, commit: string): Promise<void> {
  if (!sha.test(commit) || !existsSync(stamp(home, commit)) || readFileSync(stamp(home, commit), "utf8") !== checkout
    || !existsSync(join(runtime(home, commit), "packages", "local", "dist", "main.js"))
    || await head(git, runtime(home, commit)) !== commit) {
    throw new Error(`No complete local build is available for ${commit}`);
  }
}

export function localBuilder(home: string, checkout: string, environment: Environment, run: ProcessRunner = runProcess) {
  return async (task: TaskAssignment, signal: AbortSignal, log: (output: string) => void): Promise<string> => {
    if (task.checkout === null) throw new Error("The local build names no repository");
    const git = gitFor(environment, run, signal);
    const origin = (await git.must(["config", "--get", "remote.origin.url"], checkout)).trim();
    if (githubRepository(origin) !== task.checkout.repository.toLowerCase()) throw new Error("This repository is not the local installation checkout");
    await cleanCheckout(git, checkout);
    const token = task.environment["GH_TOKEN"];
    const fetchGit = token === undefined || !/^https:\/\/github\.com\//i.test(origin) ? git
      : gitFor(mergeEnvironment(environment, { GIT_CONFIG_PARAMETERS: gitConfigParameters(), [tokenVariable]: token }), run, signal);
    await fetchGit.must(["fetch", "--no-tags", "--no-recurse-submodules", "--", "origin", task.checkout.commit ?? task.checkout.ref ?? "HEAD"], checkout);
    const commit = (await git.must(["rev-parse", "FETCH_HEAD^{commit}"], checkout)).trim();
    if (!sha.test(commit) || (task.checkout.commit !== null && task.checkout.commit !== commit)) {
      throw new Error("Git fetched a different commit from the requested local build");
    }
    await descendant(git, checkout, commit);
    const stage = runtime(home, commit);
    if (existsSync(stamp(home, commit))) {
      await verifyRuntime(git, home, checkout, commit);
      return commit;
    }
    mkdirSync(builds(home), { recursive: true });
    const cleanupGit = gitFor(environment, run);
    if (existsSync(stage)) await cleanupGit.must(["worktree", "remove", "--force", "--", stage], checkout);
    await git.must(["worktree", "add", "--detach", "--quiet", "--", stage, commit], checkout);
    try {
      const env = mergeEnvironment(withoutCredentials(environment), {});
      for (const args of [["pnpm", "install", "--frozen-lockfile"], ["pnpm", "build"]]) {
        const invocation = process.platform === "win32" ? shellInvocation(`corepack ${args.join(" ")}`, windowsPowerShell(env)) : { file: "corepack", args };
        const result = await run(invocation.file, invocation.args, { cwd: stage, env, signal });
        const output = `> corepack ${args.join(" ")}\n${result.stdout}${result.stderr}\n`;
        log(output);
        if (result.code !== 0) throw new Error(output);
      }
      if (signal.aborted) throw new Error("The local build was interrupted");
      if (!existsSync(join(stage, "packages", "local", "dist", "main.js")) || await head(git, stage) !== commit) {
        throw new Error("The build did not produce the local entry point at the requested commit");
      }
      writeFileSync(stamp(home, commit), checkout, { flag: "wx", mode: 0o600 });
      return commit;
    } catch (error) {
      try {
        await cleanupGit.must(["worktree", "remove", "--force", "--", stage], checkout);
      } catch (cleanup) {
        throw new Error(`${String(error)}\nCould not remove the failed build: ${String(cleanup)}`);
      }
      throw error;
    }
  };
}

export function stageRestart(home: string, checkout: string, commit: string): void {
  if (!sha.test(commit) || !existsSync(stamp(home, commit)) || readFileSync(stamp(home, commit), "utf8") !== checkout) {
    throw new Error(`No complete local build is available for ${commit}`);
  }
  const pending = join(home, "local-build-pending.json");
  const temporary = `${pending}.${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify({ checkout, commit }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, pending);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function fastForwardCheckout(source: LocalSource, home: string, expected: string, environment: Environment): Promise<void> {
  if (source.commit !== expected) throw new Error(`The local edition started ${source.commit} instead of ${expected}`);
  const git = gitFor(environment, runProcess);
  await verifyRuntime(git, home, source.checkout, expected);
  await cleanCheckout(git, source.checkout);
  await git.must(["merge", "--ff-only", "--", expected], source.checkout);
}


export async function discardBuild(home: string, checkout: string, commit: string, environment: Environment): Promise<void> {
  if (!sha.test(commit) || !existsSync(stamp(home, commit)) || readFileSync(stamp(home, commit), "utf8") !== checkout) return;
  await gitFor(environment, runProcess).must(["worktree", "remove", "--force", "--", runtime(home, commit)], checkout);
  rmSync(stamp(home, commit));
}
