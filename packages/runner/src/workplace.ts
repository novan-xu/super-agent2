import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Git } from "./git.js";
import { Locks } from "./git.js";

export interface WorkPaths {
  readonly clone: string;
  readonly worktree: string;
  readonly folder: string;
  readonly handback: string;
}

export function workPaths(home: string, repository: string, ticket: number): WorkPaths {
  const [owner = "unknown", name = "unknown"] = repository.split("/");
  const folder = join(home, "work", `t${ticket}`);
  return {
    clone: join(home, "repos", owner, name),
    worktree: join(home, "worktrees", `${name}-t${ticket}`),
    folder,
    handback: join(folder, "handback.json"),
  };
}

export type RemoteUrl = (repository: string) => string;

export const gitHubRemote: RemoteUrl = (repository) => `https://github.com/${repository}.git`;

export interface Prepared {
  readonly base: string;
  readonly created: boolean;
  readonly switched: boolean;
  readonly from: string;
}

const locks = new Locks();

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
        return { base, created: false, switched: false, from: branch };
      }
      if (current !== undefined && current !== "HEAD") {
        const from = (await exists(git, `refs/heads/${branch}`, paths.clone)) ? branch : (await exists(git, `refs/remotes/origin/${branch}`, paths.clone)) ? `origin/${branch}` : `origin/${base}`;
        const switching = from === branch ? ["switch", "--discard-changes", branch] : ["switch", "--discard-changes", from === `origin/${branch}` ? "--track" : "--no-track", "-C", branch, from];
        if ((await git.run(switching, paths.worktree)).code === 0) {
          if (current.startsWith("sa2/ticket-") && !(await exists(git, `refs/remotes/origin/${current}`, paths.clone))) {
            await git.run(["branch", "-D", current], paths.clone);
          }
          return { base, created: false, switched: true, from };
        }
      }
      rmSync(paths.worktree, { recursive: true, force: true });
    }
    await git.run(["worktree", "prune"], paths.clone);
    mkdirSync(dirname(paths.worktree), { recursive: true });
    if (await exists(git, `refs/heads/${branch}`, paths.clone)) {
      await git.must(["worktree", "add", paths.worktree, branch], paths.clone);
      return { base, created: true, switched: false, from: branch };
    }
    if (await exists(git, `refs/remotes/origin/${branch}`, paths.clone)) {
      await git.must(["worktree", "add", "--track", "-b", branch, paths.worktree, `origin/${branch}`], paths.clone);
      return { base, created: true, switched: false, from: `origin/${branch}` };
    }
    await git.must(["worktree", "add", "--no-track", "-b", branch, paths.worktree, `origin/${base}`], paths.clone);
    return { base, created: true, switched: false, from: `origin/${base}` };
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

export async function saveWork(git: Git, ticket: number, branch: string, paths: WorkPaths): Promise<Saved> {
  if (!existsSync(paths.worktree)) {
    return { saved: false, detail: "The worktree is gone, so there was nothing to save" };
  }
  await git.must(["add", "-A"], paths.worktree);
  const staged = await git.run(["diff", "--cached", "--quiet"], paths.worktree);
  if (staged.code === 1) {
    await git.must(["commit", "--no-verify", "-m", `Save work in progress of ticket ${ticket} before it moves to another machine`], paths.worktree);
  }
  const pushed = await git.run(["push", "origin", `HEAD:refs/heads/${branch}`], paths.worktree);
  if (pushed.code !== 0) {
    return { saved: false, detail: `git push failed: ${`${pushed.stderr}${pushed.stdout}`.trim()}` };
  }
  return { saved: true, detail: staged.code === 1 ? "Committed the uncommitted changes and pushed the branch" : "Pushed the branch" };
}
