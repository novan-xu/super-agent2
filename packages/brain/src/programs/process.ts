import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

export function invocationOf(program: string, args: readonly string[]): Invocation {
  if (/\.[cm]?js$/i.test(program)) {
    return { command: process.execPath, args: [program, ...args] };
  }
  return { command: program, args };
}

export interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface LineProcess {
  write(value: unknown): void;
  end(): void;
  kill(): void;
  alive(): boolean;
  stderr(): string;
  readonly exited: Promise<Exit>;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly onMessage: (message: unknown) => void;
}

const stderrLimit = 4_000;

export function spawnLines(invocation: Invocation, options: SpawnOptions): LineProcess {
  let child: ChildProcessWithoutNullStreams;
  let tail = "";
  let alive = true;
  let resolveExit: (exit: Exit) => void = () => undefined;
  const exited = new Promise<Exit>((resolve) => {
    resolveExit = resolve;
  });
  try {
    child = spawn(invocation.command, [...invocation.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    alive = false;
    tail = error instanceof Error ? error.message : String(error);
    resolveExit({ code: null, signal: null });
    return {
      write: () => undefined,
      end: () => undefined,
      kill: () => undefined,
      alive: () => false,
      stderr: () => tail,
      exited,
    };
  }
  child.on("error", (error) => {
    tail = `${tail}${error.message}\n`.slice(-stderrLimit);
    if (alive) {
      alive = false;
      resolveExit({ code: null, signal: null });
    }
  });
  child.on("exit", (code, signal) => {
    if (alive) {
      alive = false;
      resolveExit({ code, signal });
    }
  });
  child.stdin.on("error", () => undefined);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-stderrLimit);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    const text = line.trim();
    if (text === "") {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    options.onMessage(message);
  });
  return {
    write: (value) => {
      if (alive && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(value)}\n`);
      }
    },
    end: () => {
      if (child.stdin.writable) {
        child.stdin.end();
      }
    },
    kill: () => {
      if (alive) {
        child.kill("SIGKILL");
      }
    },
    alive: () => alive,
    stderr: () => tail.trim(),
    exited,
  };
}

export function exitReason(name: string, exit: Exit, stderr: string): string {
  const how = exit.signal !== null ? `signal ${exit.signal}` : exit.code === null ? "an error" : `code ${exit.code}`;
  return stderr === "" ? `${name} exited with ${how}` : `${name} exited with ${how}: ${stderr}`;
}
