import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Git } from "./git.js";
import { Locks } from "./git.js";
import type { ArtifactFolder } from "./storage.js";

export interface WorkPaths {
  readonly clone: string;
  readonly worktree: string;
  readonly folder: string;
  readonly handback: string;
  readonly scratch?: string;
  readonly shared?: true;
  readonly matchedByName?: { readonly origin: string | null };
  readonly artifacts?: ArtifactFolder;
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
  return locks.with(`checkout:${existsSync(clone) ? realpathSync(clone) : clone}`, body);
}

export function withRepository<T>(repository: string, body: () => Promise<T>): Promise<T> {
  return locks.with(`repository:${repository.toLowerCase()}`, body);
}

export function githubRepository(url: string): string | undefined {
  const scp = /^(?:[^@/]+@)?(?:ssh\.)?github\.com:(?!\/\/)(.+)$/i.exec(url);
  let path = scp?.[1];
  if (path === undefined) {
    try {
      const parsed = new URL(url);
      if (!["github.com", "ssh.github.com"].includes(parsed.hostname) || !["http:", "https:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) return undefined;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const repository = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
  return /^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(repository) ? repository : undefined;
}

function ownedDirectory(path: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(path).isDirectory()) {
      throw new Error(`The runner needs a directory at ${path}`, { cause: error });
    }
  }
  if (existsAt(join(path, ".git"))) throw new Error(`The runner's directory is occupied by a checkout at ${path}`);
}

export function taskFolderInProjects(projects: string, ticket: number): string {
  const agent = join(realpathSync(projects), "_agent");
  const tasks = join(agent, "_tasks");
  ownedDirectory(agent);
  ownedDirectory(tasks);
  const folder = join(tasks, `t${ticket}`);
  if (existsAt(folder)) throw new Error(`The runner's task folder is already occupied at ${folder}`);
  return folder;
}

export async function pathsInProjects(
  git: Git,
  remote: RemoteUrl,
  projects: string,
  repository: string,
  ticket: number,
  paths: WorkPaths,
): Promise<WorkPaths> {
  const name = repository.split("/").at(-1)!;
  const url = remote(repository);
  const root = realpathSync(projects);
  return locks.with(`projects:${join(root, name.toLowerCase())}`, async () => {
    const agent = join(root, "_agent");
    ownedDirectory(agent);
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() !== "_agent")
      .map((entry) => entry.name)
      .sort((a, b) => a === name ? -1 : b === name ? 1 : a.localeCompare(b, "en"));
    let clone: string | undefined;
    for (const folder of names) {
      const candidate = join(root, folder);
      if (!existsSync(join(candidate, ".git"))) continue;
      if (await matchesOrigin(git, candidate, url, repository.toLowerCase())) {
        clone = candidate;
        break;
      }
    }
    let matchedByName: WorkPaths["matchedByName"];
    if (clone === undefined) {
      const folder = names.find((entry) => entry.toLowerCase() === name.toLowerCase());
      if (folder !== undefined) {
        const candidate = join(root, folder);
        const check = existsSync(join(candidate, ".git")) ? await git.run(["rev-parse", "--show-toplevel"], candidate) : undefined;
        if (check?.code !== 0 || !samePath(check.stdout.trim(), candidate)) throw new Error(`The projects folder contains ${candidate}, but it is not a Git checkout`);
        const origin = await git.run(["config", "--local", "--get", "remote.origin.url"], candidate);
        matchedByName = { origin: origin.code === 0 ? origin.stdout.trim() : null };
        clone = candidate;
      }
    }
    if (clone === undefined) {
      if (name.toLowerCase() === "_agent") throw new Error("The repository needs a first-level checkout with a folder name other than _agent");
      clone = join(root, name);
      try {
        lstatSync(clone);
        throw new Error(`The projects folder already contains ${clone} but it is not a Git checkout`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await git.must(["clone", "--origin", "origin", "--", url, clone], root);
    }
    const worktrees = join(agent, basename(clone));
    ownedDirectory(worktrees);
    return { ...paths, clone, worktree: join(worktrees, `t${ticket}`), shared: true, ...(matchedByName === undefined ? {} : { matchedByName }) };
  });
}

async function matchesOrigin(git: Git, checkout: string, url: string, repository: string | undefined): Promise<boolean> {
  for (const args of [["config", "--local", "--get", "remote.origin.url"], ["remote", "get-url", "origin"]]) {
    const result = await git.run(args, checkout);
    const origin = result.stdout.trim();
    if (result.code === 0 && (origin === url || (repository !== undefined && githubRepository(origin) === repository))) {
      return true;
    }
  }
  return false;
}

async function exists(git: Git, ref: string, cwd: string): Promise<boolean> {
  return (await git.run(["rev-parse", "--verify", "--quiet", ref], cwd)).code === 0;
}

async function defaultBranch(git: Git, clone: string): Promise<string> {
  await git.run(["remote", "set-head", "origin", "--auto"], clone);
  const head = (await git.must(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], clone)).trim();
  return head.replace(/^origin\//, "");
}

export function trackingRemote(paths: WorkPaths): string {
  return paths.matchedByName === undefined ? "origin" : "superagent2";
}

export async function prepareRepository(git: Git, url: string, repository: string, paths: WorkPaths): Promise<string> {
  const { clone, shared } = paths;
  if (shared) {
    if (!existsSync(join(clone, ".git")) || (await git.run(["rev-parse", "--show-toplevel"], clone)).code !== 0 || (paths.matchedByName === undefined && !await matchesOrigin(git, clone, url, repository.toLowerCase()))) {
      throw new Error(`There is no checkout of ${repository} at ${clone}`);
    }
    const head = await git.must(["ls-remote", "--symref", url, "HEAD"], clone);
    const base = /^ref: refs\/heads\/([^\t\r\n]+)\tHEAD\r?$/m.exec(head)?.[1];
    if (base === undefined) throw new Error("The repository has no default branch");
    const tracking = trackingRemote(paths);
    await git.must(["fetch", "--prune", "--no-auto-maintenance", "--no-recurse-submodules", "--no-write-fetch-head", "--", url, `+refs/heads/*:refs/remotes/${tracking}/*`], clone);
    await git.must(["symbolic-ref", `refs/remotes/${tracking}/HEAD`, `refs/remotes/${tracking}/${base}`], clone);
    return base;
  }
  if (!existsSync(join(clone, ".git"))) {
    rmSync(clone, { recursive: true, force: true });
    mkdirSync(dirname(clone), { recursive: true });
    await git.must(["clone", "--no-checkout", url, clone], dirname(clone));
  } else {
    await git.must(["fetch", "--prune", "origin"], clone);
  }
  return defaultBranch(git, clone);
}

async function worktrees(git: Git, clone: string): Promise<string[][]> {
  return (await git.must(["worktree", "list", "--porcelain", "-z"], clone)).split("\0\0").map((record) => record.split("\0"));
}

function samePath(a: string, b: string): boolean {
  if (process.platform !== "win32") return resolve(a) === resolve(b);
  return resolve(a).toLowerCase() === resolve(b).toLowerCase() || windowsPath(a) === windowsPath(b);
}

function windowsPath(path: string): string {
  let folder = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(realpathSync.native(folder), ...missing).toLowerCase();
    } catch (error) {
      const parent = dirname(folder);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === folder) return resolve(path).toLowerCase();
      missing.unshift(basename(folder));
      folder = parent;
    }
  }
}

async function registeredWorktree(git: Git, paths: WorkPaths): Promise<string | undefined> {
  const registrations = await worktrees(git, paths.clone);
  for (const [entry] of registrations.slice(1)) {
    if (!entry?.startsWith("worktree ")) continue;
    const path = entry.slice("worktree ".length);
    if (samePath(path, paths.worktree)) return path;
  }
  return undefined;
}

function existsAt(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

async function checkSharedWorktree(git: Git, paths: WorkPaths, registered: boolean): Promise<void> {
  if (!existsAt(paths.worktree)) return;
  if (registered && lstatSync(paths.worktree).isDirectory() && lstatSync(join(paths.worktree, ".git"), { throwIfNoEntry: false })?.isFile()) {
    const common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const worktree = await git.run(common, paths.worktree);
    const clone = await git.run(common, paths.clone);
    if (worktree.code === 0 && clone.code === 0 && samePath(worktree.stdout.trim(), clone.stdout.trim())) return;
  }
  throw new Error(`The runner's worktree path is already occupied at ${paths.worktree}`);
}

export async function discardWorktree(git: Git, paths: WorkPaths): Promise<void> {
  if (paths.shared) {
    const registered = await registeredWorktree(git, paths);
    if (registered !== undefined) {
      await checkSharedWorktree(git, paths, true);
      await git.must(["worktree", "remove", "--force", registered], paths.clone);
    }
    return;
  }
  await git.run(["worktree", "remove", "--force", paths.worktree], paths.clone);
  rmSync(paths.worktree, { recursive: true, force: true });
}

async function deleteBranch(git: Git, paths: WorkPaths, branch: string): Promise<void> {
  if (branch === "") return;
  if (!paths.shared) {
    await git.run(["branch", "-D", branch], paths.clone);
    return;
  }
  const ref = `refs/heads/${branch}`;
  if (!(await worktrees(git, paths.clone)).some((fields) => fields.includes(`branch ${ref}`))) {
    await git.must(["update-ref", "-d", ref], paths.clone);
  }
}

export async function checkWorktreePath(git: Git, paths: WorkPaths): Promise<void> {
  if (!paths.shared) {
    await git.run(["worktree", "prune"], paths.clone);
  } else {
    const registered = await registeredWorktree(git, paths);
    await checkSharedWorktree(git, paths, registered !== undefined);
    if (registered !== undefined && !existsAt(paths.worktree)) await git.must(["worktree", "remove", "--force", registered], paths.clone);
  }
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
  await git.must(["switch", "--no-track", "-C", branch], worktree);
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
  return withClone(paths.clone, async () => {
    const base = await prepareRepository(git, remote(repository), repository, paths);
    const tracking = trackingRemote(paths);
    await checkWorktreePath(git, paths);
    if (existsSync(paths.worktree)) {
      const current = await currentBranch(git, paths.worktree);
      if (current === branch) {
        return { base, created: false, switched: false, from: branch, leftover: null };
      }
      if (current !== undefined && current !== "HEAD") {
        const aside = await setAside(git, paths.worktree, current);
        const from = (await exists(git, `refs/heads/${branch}`, paths.clone)) ? branch : (await exists(git, `refs/remotes/${tracking}/${branch}`, paths.clone)) ? `${tracking}/${branch}` : `${tracking}/${base}`;
        const switching = from === branch ? ["switch", branch] : ["switch", !paths.shared && from === `${tracking}/${branch}` ? "--track" : "--no-track", "-C", branch, from];
        const switched = await git.run(switching, paths.worktree);
        if (switched.code !== 0) {
          throw new Error(`git ${switching.join(" ")} failed in ${paths.worktree}${aside === null ? "" : `; the uncommitted work is kept on the local branch ${aside.branch}`}: ${`${switched.stderr}${switched.stdout}`.trim()}`);
        }
        const leftover = aside === null ? null : { ...aside, carried: await carryOver(git, paths.worktree, aside.commit) };
        if (/^sa2\/(?:ticket-|[a-z]{2}-\d{4}-\d{2}-\d{2}-)/.test(current) && !current.endsWith(leftoverSuffix) && !(await exists(git, `refs/remotes/${tracking}/${current}`, paths.clone))) {
          await deleteBranch(git, paths, current);
        }
        return { base, created: false, switched: true, from, leftover };
      }
      await discardWorktree(git, paths);
    }
    mkdirSync(dirname(paths.worktree), { recursive: true });
    if (await exists(git, `refs/heads/${branch}`, paths.clone)) {
      await git.must(["worktree", "add", paths.worktree, branch], paths.clone);
      return { base, created: true, switched: false, from: branch, leftover: null };
    }
    if (await exists(git, `refs/remotes/${tracking}/${branch}`, paths.clone)) {
      await git.must(["worktree", "add", paths.shared ? "--no-track" : "--track", "-b", branch, paths.worktree, `${tracking}/${branch}`], paths.clone);
      return { base, created: true, switched: false, from: `${tracking}/${branch}`, leftover: null };
    }
    await git.must(["worktree", "add", "--no-track", "-b", branch, paths.worktree, `${tracking}/${base}`], paths.clone);
    return { base, created: true, switched: false, from: `${tracking}/${base}`, leftover: null };
  });
}

export async function removeWorktree(git: Git, branch: string, paths: WorkPaths): Promise<void> {
  await withClone(paths.clone, async () => {
    if (existsSync(join(paths.clone, ".git"))) {
      const current = branch === "" || !existsSync(paths.worktree) ? undefined : await currentBranch(git, paths.worktree);
      if (current === undefined || current === branch || current === "HEAD") await discardWorktree(git, paths);
      if (!paths.shared) await git.run(["worktree", "prune"], paths.clone);
      await deleteBranch(git, paths, branch);
    } else if (!paths.shared) {
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

export async function folderState(git: Git, worktree: string, base: string | null, tracking = "origin"): Promise<FolderState> {
  const unread: string[] = [];
  let commits = "";
  if (base !== null) {
    const log = await readState(git, ["log", "--oneline", `${tracking}/${base}..HEAD`], worktree);
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

export async function saveWork(git: Git, branch: string, paths: WorkPaths, pushTo = "origin"): Promise<Saved> {
  if (!existsSync(paths.worktree)) {
    return { saved: false, detail: "The worktree is gone, so there was nothing to save" };
  }
  await git.must(["add", "-A"], paths.worktree);
  const staged = await git.run(["diff", "--cached", "--quiet"], paths.worktree);
  if (staged.code === 1) {
    await git.must(["commit", "--no-verify", "-m", "Save work in progress on the worker branch"], paths.worktree);
  }
  const pushed = await git.run(["push", pushTo, `HEAD:refs/heads/${branch}`], paths.worktree);
  if (pushed.code !== 0) {
    return { saved: false, detail: `git push failed: ${`${pushed.stderr}${pushed.stdout}`.trim()}` };
  }
  return { saved: true, detail: staged.code === 1 ? "Committed the uncommitted changes and pushed the branch" : "Pushed the branch" };
}
