import { type ChildProcess, spawn } from "node:child_process";
import { shellInvocation } from "@super-agent2/programs";
import type { OutputStream } from "@super-agent2/protocol";
import { accountTokenVariable } from "./credentials.js";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface Job {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface ExecutionEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly lost?: string;
}

export interface Execution {
  readonly ended: Promise<ExecutionEnd>;
  stop(): Promise<void>;
}

export type OutputSink = (stream: OutputStream, data: Buffer) => void;

export interface Target {
  readonly name: string;
  run(job: Job, sink: OutputSink): Execution;
}

export interface TargetDirectory {
  find(name: string): Target | undefined;
  names(): string[];
}

export function fixedTargets(targets: readonly Target[]): TargetDirectory {
  const byName = new Map(targets.map((target) => [target.name, target]));
  return { find: (name) => byName.get(name), names: () => [...byName.keys()] };
}

export function combinedTargets(...directories: readonly TargetDirectory[]): TargetDirectory {
  return {
    find: (name) => {
      for (const directory of directories) {
        const target = directory.find(name);
        if (target !== undefined) {
          return target;
        }
      }
      return undefined;
    },
    names: () => [...new Set(directories.flatMap((directory) => directory.names()))],
  };
}

export function isTargetDirectory(value: readonly Target[] | TargetDirectory): value is TargetDirectory {
  return !Array.isArray(value);
}

export const hubTargetName = "hub";

function watch(child: ChildProcess, sink: OutputSink): Promise<ExecutionEnd> {
  child.stdout?.on("data", (data: Buffer) => sink("stdout", data));
  child.stderr?.on("data", (data: Buffer) => sink("stderr", data));
  return new Promise((resolve, reject) => {
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
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

function stopTree(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return Promise.resolve();
  }
  if (platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return exited(killer);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      return Promise.resolve();
    }
  }
  return Promise.resolve();
}

export function commandEnvironment(base: Environment, credentials: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  const removed = new Set<string>([...Object.values(accountTokenVariable), "OPENAI_ADMIN_KEY"]);
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !removed.has(name.toUpperCase())) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(credentials)) {
    for (const existing of Object.keys(result)) {
      if (existing.toUpperCase() === name.toUpperCase()) {
        delete result[existing];
      }
    }
    result[name] = value;
  }
  return result;
}

export interface LocalTargetOptions {
  readonly name?: string;
  readonly environment: Environment;
  readonly platform?: NodeJS.Platform;
  readonly powerShell?: string;
}

export function localTarget(options: LocalTargetOptions): Target {
  const platform = options.platform ?? process.platform;
  return {
    name: options.name ?? hubTargetName,
    run: (job, sink) => {
      const { file, args, shell } = shellInvocation(job.command, options.powerShell);
      const child = spawn(file, args, {
        shell,
        cwd: job.cwd,
        env: commandEnvironment(options.environment, job.credentials),
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const ended = watch(child, sink);
      return { ended, stop: () => stopTree(child, platform) };
    },
  };
}
