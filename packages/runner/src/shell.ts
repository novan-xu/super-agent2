import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { OutputStream } from "@super-agent2/protocol";

export interface ShellJob {
  readonly command: string;
  readonly cwd: string | null;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ShellEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface ShellRun {
  readonly pid: number | undefined;
  readonly ended: Promise<ShellEnd>;
  stop(): Promise<void>;
}

export type ShellSink = (stream: OutputStream, data: Buffer) => void;

export function mergeEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  added: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(added)) {
    for (const existing of Object.keys(result)) {
      if (existing.toUpperCase() === name.toUpperCase()) {
        delete result[existing];
      }
    }
    result[name] = value;
  }
  return result;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return exited(killer);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return Promise.resolve();
    }
  }
  return Promise.resolve();
}

export interface ShellOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export function runShell(job: ShellJob, sink: ShellSink, options: ShellOptions): ShellRun {
  const platform = options.platform ?? process.platform;
  if (job.cwd !== null && !isFolder(job.cwd)) {
    const ended = Promise.reject(new Error(`The folder ${job.cwd} does not exist on this machine`));
    ended.catch(() => undefined);
    return { pid: undefined, ended, stop: () => Promise.resolve() };
  }
  const child = spawn(job.command, {
    shell: true,
    cwd: job.cwd ?? undefined,
    env: mergeEnvironment(options.environment, job.environment),
    detached: platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data: Buffer) => sink("stdout", data));
  child.stderr?.on("data", (data: Buffer) => sink("stderr", data));
  const ended = new Promise<ShellEnd>((resolve, reject) => {
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      if (!spawned) {
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (spawned) {
        resolve({ exitCode: code, signal });
      }
    });
  });
  return {
    pid: child.pid,
    ended,
    stop: () => (child.pid === undefined ? Promise.resolve() : killTree(child.pid, platform)),
  };
}
