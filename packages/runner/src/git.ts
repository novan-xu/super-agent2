import { spawn } from "node:child_process";
import { killTree } from "./shell.js";

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly signal?: AbortSignal },
) => Promise<RunResult>;

export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolve) => {
    let child;
    try {
      if (options.signal?.aborted) { resolve({ code: null, stdout: "", stderr: "Cancelled" }); return; }
      child = spawn(command, [...args], { cwd: options.cwd, env: { ...options.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: options.signal !== undefined && process.platform !== "win32" });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const abort = () => { if (child.pid !== undefined) void killTree(child.pid); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    let settled = false;
    const finish = (code: number | null, extra = "") => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: `${Buffer.concat(err).toString("utf8")}${extra}` });
    };
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));
  });

export class GitError extends Error {}

export interface Git {
  run(args: readonly string[], cwd: string): Promise<RunResult>;
  must(args: readonly string[], cwd: string): Promise<string>;
}

export function createGit(run: ProcessRunner, environment: Readonly<Record<string, string>>, program = "git"): Git {
  const git: Git = {
    run: (args, cwd) => run(program, args, { cwd, env: environment }),
    must: async (args, cwd) => {
      const result = await git.run(args, cwd);
      if (result.code !== 0) {
        const output = `${result.stderr}${result.stdout}`.trim();
        throw new GitError(`git ${args.join(" ")} failed${output === "" ? "" : `: ${output}`}`);
      }
      return result.stdout;
    },
  };
  return git;
}

export class Locks {
  private readonly tails = new Map<string, Promise<void>>();

  async with<T>(key: string, body: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    this.tails.set(key, tail);
    await before;
    try {
      return await body();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
