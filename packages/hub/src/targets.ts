import { type ChildProcess, spawn } from "node:child_process";
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

export const hubTargetName = "hub";
export const nasTargetName = "nas";

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
  const removed = new Set<string>(Object.values(accountTokenVariable));
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
}

export function localTarget(options: LocalTargetOptions): Target {
  const platform = options.platform ?? process.platform;
  return {
    name: options.name ?? hubTargetName,
    run: (job, sink) => {
      const child = spawn(job.command, {
        shell: true,
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

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function remoteScript(job: Job): string {
  const lines = ["run() {"];
  for (const [name, value] of Object.entries(job.credentials)) {
    if (!variableName.test(name)) {
      throw new Error(`${name} is not a valid variable name`);
    }
    lines.push(`  export ${name}=${shellQuote(value)}`);
  }
  if (job.cwd !== undefined) {
    lines.push(`  cd -- ${shellQuote(job.cwd)} || exit 1`);
  }
  lines.push(
    "  exec 3<&0",
    "  set -m",
    `  sh -c ${shellQuote(job.command)} </dev/null 3<&- &`,
    "  pid=$!",
    '  { read -r _ <&3; kill -s KILL -- -"$pid" 2>/dev/null || kill -s KILL "$pid" 2>/dev/null; } &',
    "  watcher=$!",
    '  wait "$pid" 2>/dev/null',
    "  code=$?",
    '  kill "$watcher" 2>/dev/null',
    '  exit "$code"',
    "}",
    "run",
    "",
  );
  return lines.join("\n");
}

export interface ScriptTargetOptions {
  readonly name: string;
  readonly argv: readonly [string, ...string[]];
  readonly environment: Environment;
}

export function scriptTarget(options: ScriptTargetOptions): Target {
  const [program, ...args] = options.argv;
  return {
    name: options.name,
    run: (job, sink) => {
      const script = remoteScript(job);
      const child = spawn(program, args, {
        env: commandEnvironment(options.environment, {}),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.write(script);
      const ended = watch(child, sink);
      return {
        ended,
        stop: async () => {
          child.stdin?.end();
        },
      };
    },
  };
}

export interface SshDestination {
  readonly destination: string;
  readonly port?: number;
  readonly identityFile?: string;
}

export function sshArgv(nas: SshDestination): [string, ...string[]] {
  return [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    ...(nas.port === undefined ? [] : ["-p", String(nas.port)]),
    ...(nas.identityFile === undefined ? [] : ["-i", nas.identityFile]),
    "--",
    nas.destination,
    "bash -s",
  ];
}

export function sshTarget(nas: SshDestination, environment: Environment): Target {
  return scriptTarget({ name: nasTargetName, argv: sshArgv(nas), environment });
}
