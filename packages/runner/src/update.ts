import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { releaseVersionHeader, runnerReleasePath } from "@super-agent2/protocol";
import { entryFiles, readState, refreshEntry, writeState } from "./entry.js";
import { revisionFile } from "./version.js";

export interface UpdateSteps {
  download(version: string, file: string): Promise<void>;
  extract(file: string, folder: string): Promise<void>;
  install(folder: string): Promise<void>;
  check(main: string): Promise<string | undefined>;
}

export interface UpdaterOptions {
  readonly home: string;
  readonly mainPath: string;
  readonly version: string | undefined;
  readonly supervised: boolean;
  readonly steps: UpdateSteps;
  readonly busy: () => number;
  readonly restart: () => void;
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly retryMilliseconds?: number;
}

export interface Updater {
  announced(version: string | undefined): void;
  changed(): void;
  confirmed(): void;
  settled(): Promise<void>;
}

export const defaultRetryMilliseconds = 60 * 60 * 1000;

export const readyFile = ".ready";

export function versionFolder(versions: string, version: string): string {
  return join(versions, version.slice(0, 12));
}

export function mainIn(folder: string): string {
  return join(folder, "packages", "runner", "dist", "main.js");
}

function short(version: string | undefined): string {
  return version === undefined ? "an unknown version" : version.slice(0, 7);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inside(folder: string, path: string): boolean {
  const way = relative(folder, path);
  return way !== "" && !way.startsWith("..") && !isAbsolute(way);
}

export function createUpdater(options: UpdaterOptions): Updater {
  const files = entryFiles(options.home);
  const retry = options.retryMilliseconds ?? defaultRetryMilliseconds;
  let preparing: Promise<void> | undefined;
  let ready: { readonly version: string; readonly main: string } | undefined;
  let wanted: string | undefined;
  let switched = false;
  let told = "";

  const once = (line: string) => {
    if (told !== line) {
      told = line;
      options.log(line);
    }
  };

  const trySwitch = () => {
    if (ready === undefined || switched || ready.version !== wanted) {
      return;
    }
    const busy = options.busy();
    if (busy > 0) {
      once(`Version ${short(ready.version)} is ready; the runner switches to it once its ${busy} running piece(s) of work end`);
      return;
    }
    switched = true;
    const state = readState(files) ?? { current: options.mainPath, ...(options.version === undefined ? {} : { currentVersion: options.version }) };
    writeState(files, {
      current: ready.main,
      currentVersion: ready.version,
      previous: state.current,
      ...(state.currentVersion === undefined ? {} : { previousVersion: state.currentVersion }),
      trial: 0,
    });
    options.log(`Switching from ${short(options.version)} to ${short(ready.version)}: the runner restarts now`);
    options.restart();
  };

  const remember = (version: string, reason: string) => {
    const state = readState(files);
    if (state !== undefined) {
      writeState(files, { ...state, failed: { version, reason, at: options.now(), permanent: false } });
    }
  };

  const prepare = async (version: string) => {
    mkdirSync(files.versions, { recursive: true });
    const final = versionFolder(files.versions, version);
    const archive = `${final}.tar.gz`;
    try {
      if (!existsSync(join(final, readyFile))) {
        rmSync(final, { recursive: true, force: true });
        rmSync(archive, { force: true });
        mkdirSync(final, { recursive: true });
        options.log(`The hub runs ${short(version)}; fetching it from the hub while this runner keeps working`);
        await options.steps.download(version, archive);
        await options.steps.extract(archive, final);
        rmSync(archive, { force: true });
        writeFileSync(join(final, revisionFile), `${version}\n`);
        options.log(`Installing and building ${short(version)} in ${final}`);
        await options.steps.install(final);
        const reported = await options.steps.check(mainIn(final));
        if (reported !== version) {
          throw new Error(`the new runner says it is ${reported === undefined ? "of no known version" : short(reported)}`);
        }
        writeFileSync(join(final, readyFile), `${version}\n`);
      }
      ready = { version, main: mainIn(final) };
      trySwitch();
    } catch (error) {
      rmSync(archive, { force: true });
      rmSync(final, { recursive: true, force: true });
      const reason = reasonOf(error);
      remember(version, reason);
      options.log(`The update to ${short(version)} failed, and this runner goes on at ${short(options.version)}: ${reason}`);
    }
  };

  const prune = () => {
    const state = readState(files);
    if (state === undefined || preparing !== undefined || !existsSync(files.versions)) {
      return;
    }
    const kept = new Set([state.current, state.previous].filter((path): path is string => path !== undefined).map((path) => resolve(dirname(path), "..", "..", "..")));
    for (const name of readdirSync(files.versions)) {
      const path = resolve(files.versions, name);
      if (!kept.has(path) && inside(files.versions, path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  };

  return {
    announced: (version) => {
      wanted = version;
      if (version === options.version && ready !== undefined && !switched) {
        once(`The hub runs ${short(version)} again, the version of this runner, so it does not switch to ${short(ready.version)}`);
      }
      if (version === undefined || version === options.version || switched) {
        return;
      }
      if (!options.supervised) {
        once(`The hub runs ${short(version)} and this runner is at ${short(options.version)}; it updates itself only when it was started by its supervisor or launch agent`);
        return;
      }
      const failed = readState(files)?.failed;
      if (failed !== undefined && failed.version === version && (failed.permanent || options.now() - failed.at < retry)) {
        once(`The hub runs ${short(version)}; the update to it failed (${failed.reason}), so this runner stays at ${short(options.version)}${failed.permanent ? "" : " and tries again later"}`);
        return;
      }
      if (ready?.version === version) {
        trySwitch();
        return;
      }
      if (preparing !== undefined) {
        return;
      }
      preparing = prepare(version).finally(() => {
        preparing = undefined;
      });
    },
    changed: trySwitch,
    confirmed: () => {
      const state = readState(files);
      if (state === undefined) {
        return;
      }
      if (state.trial !== undefined) {
        const { trial: _trial, ...rest } = state;
        writeState(files, rest);
        options.log(`Version ${short(state.currentVersion)} reached the hub; it stays`);
      }
      refreshEntry(options.home, state.current);
      prune();
    },
    settled: async () => {
      while (preparing !== undefined) {
        await preparing;
      }
    },
  };
}

export interface ProcessResult {
  readonly code: number | null;
  readonly output: string;
}

export function runProcess(command: string, args: readonly string[], options: { readonly cwd: string; readonly environment: Readonly<Record<string, string | undefined>>; readonly shell?: boolean }): Promise<ProcessResult> {
  return new Promise((done) => {
    const child = options.shell === true
      ? spawn([command, ...args].join(" "), { cwd: options.cwd, env: { ...options.environment }, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, [...args], { cwd: options.cwd, env: { ...options.environment }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (data: Buffer) => {
      output = `${output}${data.toString("utf8")}`.slice(-8_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.once("error", (error) => done({ code: null, output: `${output}${error.message}` }));
    child.once("close", (code) => done({ code, output }));
  });
}

function lastLines(output: string): string {
  return output.trim().split(/\r?\n/).slice(-5).join(" | ");
}

export interface SystemStepsOptions {
  readonly hub: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly nodePath: string;
  readonly fetch?: typeof fetch;
}

export function tarProgram(platform: NodeJS.Platform, environment: Readonly<Record<string, string | undefined>>): string {
  return platform === "win32" ? join(environment["SystemRoot"] ?? environment["SYSTEMROOT"] ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
}

export function systemSteps(options: SystemStepsOptions): UpdateSteps {
  const doFetch = options.fetch ?? fetch;
  const environment = { ...options.environment, CI: "true" };
  const must = async (what: string, result: Promise<ProcessResult>) => {
    const ended = await result;
    if (ended.code !== 0) {
      throw new Error(`${what} ended with ${ended.code ?? "no code"}: ${lastLines(ended.output)}`);
    }
    return ended;
  };
  return {
    download: async (version, file) => {
      const response = await doFetch(new URL(runnerReleasePath, options.hub), { headers: { ...options.headers } });
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel();
        throw new Error(`the hub answered ${response.status} when asked for its release`);
      }
      const given = response.headers.get(releaseVersionHeader);
      if (given !== version) {
        await response.body.cancel();
        throw new Error(`the hub handed ${given === null ? "a release of no stated version" : short(given)} instead of ${short(version)}`);
      }
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
    },
    extract: async (file, folder) => {
      await must("Unpacking the release", runProcess(tarProgram(options.platform, options.environment), ["-xzf", file, "-C", folder, "--strip-components=1"], { cwd: folder, environment }));
    },
    install: async (folder) => {
      const shell = options.platform === "win32";
      await must("pnpm install", runProcess("pnpm", ["install", "--frozen-lockfile"], { cwd: folder, environment, shell }));
      await must("pnpm build", runProcess("pnpm", ["--filter-prod", "@super-agent2/runner...", "run", "build"], { cwd: folder, environment, shell }));
    },
    check: async (main) => {
      const ended = await must("The new runner", runProcess(options.nodePath, [main, "version"], { cwd: dirname(main), environment }));
      try {
        const parsed: unknown = JSON.parse(ended.output.trim().split(/\r?\n/).at(-1) ?? "");
        return typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string" ? parsed.version : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
