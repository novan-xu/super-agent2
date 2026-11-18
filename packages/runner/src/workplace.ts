import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Git } from "./git.js";
import { Locks } from "./git.js";

export interface WorkPaths {
  readonly clone: string;
  readonly worktree: string;
  readonly folder: string;
  readonly handback: string;
  readonly scratch?: string;
}

export function workPaths(home: string, repository: string, ticket: number, folderOf: number = ticket): WorkPaths {
  const [owner = "unknown", name = "unknown"] = repository.split("/");
  const folder = join(home, "work", `t${ticket}`);
  return {
    clone: join(home, "repos", owner, name),
    worktree: join(home, "worktrees", `${name}-t${folderOf}`),
    folder,
    handback: join(folder, "handback.json"),
  };
}

export type RemoteUrl = (repository: string) => string;

export const gitHubRemote: RemoteUrl = (repository) => `https://github.com/${repository}.git`;

export interface Leftover {
  readonly branch: string;
  readonly commit: string;
  readonly carried: boolean;
}

export interface Prepared {
  readonly base: string;
  readonly created: boolean;
  readonly switched: boolean;
  readonly from: string;
  readonly leftover: Leftover | null;
}

export const leftoverSuffix = "-unfinished";

const locks = new Locks();

export function withClone<T>(clone: string, body: () => Promise<T>): Promise<T> {
  return locks.with(clone, body);
}

async function exists(git: Git, ref: string, cwd: string): Promise<boolean> {
  return (await git.run(["rev-parse", "--verify", "--quiet", ref], cwd)).code === 0;
}

async function defaultBranch(git: Git, clone: string): Promise<string> {
  await git.run(["remote", "set-head", "origin", "--auto"], clone);
  const head = (await git.must(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], clone)).trim();
  return head.replace(/^origin\//, "");
}

async function currentBranch(git: Git, worktree: string): Promise<string | undefined> {
  const result = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function setAside(git: Git, worktree: string, current: string): Promise<{ readonly branch: string; readonly commit: string } | null> {
  if (current.endsWith(leftoverSuffix)) {
    if ((await git.must(["status", "--porcelain", "--untracked-files=all"], worktree)).trim() !== "") {
      await git.must(["add", "-A"], worktree);
      await git.must(["commit", "--no-verify", "-m", "Work left uncommitted in the folder before it moved to the next branch"], worktree);
    }
    return { branch: current, commit: (await git.must(["rev-parse", "HEAD"], worktree)).trim() };
  }
  if ((await git.must(["status", "--porcelain", "--untracked-files=all"], worktree)).trim() === "") {
    return null;
  }
  const branch = `${current}${leftoverSuffix}`;
  await git.must(["switch", "-C", branch], worktree);
  await git.must(["add", "-A"], worktree);
  await git.must(["commit", "--no-verify", "-m", `Work left uncommitted in the folder when it moved on from ${current}`], worktree);
  return { branch, commit: (await git.must(["rev-parse", "HEAD"], worktree)).trim() };
}

async function carryOver(git: Git, worktree: string, commit: string): Promise<boolean> {
  if ((await git.run(["cherry-pick", "--no-commit", commit], worktree)).code === 0) {
    await git.run(["cherry-pick", "--quit"], worktree);
    await git.run(["reset", "-q"], worktree);
    return true;
  }
  await git.run(["cherry-pick", "--quit"], worktree);
  await git.must(["reset", "-q", "--hard", "HEAD"], worktree);
  await git.must(["clean", "-fdq"], worktree);
  return false;
}

export async function prepareWorktree(git: Git, remote: RemoteUrl, repository: string, branch: string, paths: WorkPaths): Promise<Prepared> {
  return locks.with(paths.clone, async () => {
    if (!existsSync(join(paths.clone, ".git"))) {
      rmSync(paths.clone, { recursive: true, force: true });
      mkdirSync(dirname(paths.clone), { recursive: true });
      await git.must(["clone", "--no-checkout", remote(repository), paths.clone], dirname(paths.clone));
    } else {
      await git.must(["fetch", "--prune", "origin"], paths.clone);
    }
    const base = await defaultBranch(git, paths.clone);
    if (existsSync(paths.worktree)) {
      const current = await currentBranch(git, paths.worktree);
      if (current === branch) {
        return { base, created: false, switched: false, from: branch, leftover: null };
      }
      if (current !== undefined && current !== "HEAD") {
        const aside = await setAside(git, paths.worktree, current);
        const from = (await exists(git, `refs/heads/${branch}`, paths.clone)) ? branch : (await exists(git, `refs/remotes/origin/${branch}`, paths.clone)) ? `origin/${branch}` : `origin/${base}`;
        const switching = from === branch ? ["switch", branch] : ["switch", from === `origin/${branch}` ? "--track" : "--no-track", "-C", branch, from];
        const switched = await git.run(switching, paths.worktree);
        if (switched.code !== 0) {
          throw new Error(`git ${switching.join(" ")} failed in ${paths.worktree}${aside === null ? "" : `; the uncommitted work is kept on the local branch ${aside.branch}`}: ${`${switched.stderr}${switched.stdout}`.trim()}`);
        }
        const leftover = aside === null ? null : { ...aside, carried: await carryOver(git, paths.worktree, aside.commit) };
        if (current.startsWith("sa2/ticket-") && !current.endsWith(leftoverSuffix) && !(await exists(git, `refs/remotes/origin/${current}`, paths.clone))) {
          await git.run(["branch", "-D", current], paths.clone);
        }
        return { base, created: false, switched: true, from, leftover };
      }
      rmSync(paths.worktree, { recursive: true, force: true });
    }
    await git.run(["worktree", "prune"], paths.clone);
    mkdirSync(dirname(paths.worktree), { recursive: true });
    if (await exists(git, `refs/heads/${branch}`, paths.clone)) {
      await git.must(["worktree", "add", paths.worktree, branch], paths.clone);
      return { base, created: true, switched: false, from: branch, leftover: null };
    }
    if (await exists(git, `refs/remotes/origin/${branch}`, paths.clone)) {
      await git.must(["worktree", "add", "--track", "-b", branch, paths.worktree, `origin/${branch}`], paths.clone);
      return { base, created: true, switched: false, from: `origin/${branch}`, leftover: null };
    }
    await git.must(["worktree", "add", "--no-track", "-b", branch, paths.worktree, `origin/${base}`], paths.clone);
    return { base, created: true, switched: false, from: `origin/${base}`, leftover: null };
  });
}

export async function removeWorktree(git: Git, branch: string, paths: WorkPaths): Promise<void> {
  await locks.with(paths.clone, async () => {
    if (existsSync(join(paths.clone, ".git"))) {
      if (existsSync(paths.worktree)) {
        await git.run(["worktree", "remove", "--force", paths.worktree], paths.clone);
      }
      rmSync(paths.worktree, { recursive: true, force: true });
      await git.run(["worktree", "prune"], paths.clone);
      await git.run(["branch", "-D", branch], paths.clone);
    } else {
      rmSync(paths.worktree, { recursive: true, force: true });
    }
  });
}

export interface Saved {
  readonly saved: boolean;
  readonly detail: string;
}

export interface FolderState {
  readonly commits: string;
  readonly status: string;
  readonly unread: readonly string[];
}

async function readState(git: Git, args: readonly string[], cwd: string): Promise<{ readonly text: string; readonly problem: string | null }> {
  const result = await git.run(args, cwd);
  return result.code === 0 ? { text: result.stdout.trim(), problem: null } : { text: "", problem: `git ${args.join(" ")} failed: ${`${result.stderr}${result.stdout}`.trim()}` };
}

export async function folderState(git: Git, worktree: string, base: string | null): Promise<FolderState> {
  const unread: string[] = [];
  let commits = "";
  if (base !== null) {
    const log = await readState(git, ["log", "--oneline", `origin/${base}..HEAD`], worktree);
    commits = log.text;
    if (log.problem !== null) {
      unread.push(log.problem);
    }
  }
  const status = await readState(git, ["status", "--short", "--untracked-files=all"], worktree);
  if (status.problem !== null) {
    unread.push(status.problem);
  }
  return { commits, status: status.text, unread };
}

export async function saveWork(git: Git, ticket: number, branch: string, paths: WorkPaths): Promise<Saved> {
  if (!existsSync(paths.worktree)) {
    return { saved: false, detail: "The worktree is gone, so there was nothing to save" };
  }
  await git.must(["add", "-A"], paths.worktree);
  const staged = await git.run(["diff", "--cached", "--quiet"], paths.worktree);
  if (staged.code === 1) {
    await git.must(["commit", "--no-verify", "-m", `Save work in progress of ticket ${ticket} so that it is on the branch`], paths.worktree);
  }
  const pushed = await git.run(["push", "origin", `HEAD:refs/heads/${branch}`], paths.worktree);
  if (pushed.code !== 0) {
    return { saved: false, detail: `git push failed: ${`${pushed.stderr}${pushed.stdout}`.trim()}` };
  }
  return { saved: true, detail: staged.code === 1 ? "Committed the uncommitted changes and pushed the branch" : "Pushed the branch" };
}
