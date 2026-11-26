import { cp, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { selfUpdateFor } from "./program-update-self.js";
import { type ProgramId, programIsConfigured, type ProgramReport } from "@super-agent2/protocol";
import type { Prober } from "./programs.js";

const packages: Partial<Record<ProgramId, string>> = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code", dsh: "@deepseek-ai/dsh" };

export function newer(installed: string, latest: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(value.trim());
  const a = parse(installed);
  const b = parse(latest);
  if (a === null || b === null || latest.includes("-")) return false;
  for (let i = 1; i <= 3; i += 1) {
    const difference = Number(b[i]) - Number(a[i]);
    if (difference !== 0) return difference > 0;
  }
  return installed.includes("-");
}

export async function npmPackageFor(path: string, root: string, name: string): Promise<string | undefined> {
  const folder = resolve(root, name);
  try {
    const target = await realpath(path);
    const realFolder = await realpath(folder);
    if (target === realFolder || target.startsWith(`${realFolder}${sep}`)) return folder;
    if (/\.cmd$/i.test(path)) {
      const text = await readFile(path, "utf8");
      const relative = name.replaceAll("/", "[\\\\/]");
      if (new RegExp(`node_modules[\\\\/]${relative}[\\\\/]`, "i").test(text) && resolve(dirname(path), "node_modules") === resolve(root)) return folder;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface ProgramUpdateSteps {
  check(program: ProgramReport): Promise<{ latest: string | null; channel?: string; install(): Promise<void> } | undefined>;
}

export function systemProgramUpdateSteps(prober: Prober): ProgramUpdateSteps {
  return {
    check: async (program) => {
      const name = packages[program.id];
      const npm = prober.find("npm");
      if (program.path === null) return undefined;
      if (name === undefined || npm === undefined) return selfUpdateFor(program, prober);
      const defaultRoot = (await prober.capture(npm, ["root", "--global"]).catch(() => "")).trim();
      let root = defaultRoot;
      let folder = await npmPackageFor(program.path, root, name);
      if (folder === undefined) {
        const target = await realpath(program.path).catch(() => "");
        const marker = `${sep}node_modules${sep}${name.replaceAll("/", sep)}${sep}`;
        const index = target.lastIndexOf(marker);
        if (index >= 0) {
          root = target.slice(0, index + `${sep}node_modules`.length);
          folder = await npmPackageFor(program.path, root, name);
        }
      }
      if (folder === undefined) return selfUpdateFor(program, prober);
      const latest = (await prober.capture(npm, ["view", `${name}@latest`, "version"])).trim();
      const packageFolder = folder;
      const prefix = process.platform === "win32" ? dirname(root) : dirname(dirname(root));
      return {
        latest,
        install: async () => {
          const backup = await mkdtemp(join(tmpdir(), "sa2-program-"));
          try {
            await cp(packageFolder, join(backup, "package"), { recursive: true, dereference: false });
            const executable = program.path;
            if (executable === null) throw new Error("program path is missing");
            const shims = /\.cmd$/i.test(executable)
              ? [executable, executable.slice(0, -4), `${executable.slice(0, -4)}.ps1`]
              : [executable];
            const present: boolean[] = [];
            for (const [index, shim] of shims.entries()) {
              let exists = true;
              try {
                await lstat(shim);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                exists = false;
              }
              present.push(exists);
              if (exists) await cp(shim, join(backup, `executable-${index}`), { dereference: false, verbatimSymlinks: true });
            }
            try {
              await prober.capture(npm, ["install", "--global", "--prefix", prefix, `${name}@${latest}`]);
            } catch (error) {
              await rm(packageFolder, { recursive: true, force: true });
              await cp(join(backup, "package"), packageFolder, { recursive: true, dereference: false });
              for (const [index, shim] of shims.entries()) {
                await rm(shim, { force: true });
                if (present[index]) await cp(join(backup, `executable-${index}`), shim, { dereference: false, verbatimSymlinks: true });
              }
              throw error;
            }
          } finally {
            await rm(backup, { recursive: true, force: true });
          }
        },
      };
    },
  };
}

export function createProgramUpdater(options: {
  steps: ProgramUpdateSteps;
  busy(): number;
  report(): readonly ProgramReport[];
  publish(programs: ProgramReport[]): void;
  reprobe(): Promise<void>;
  lock(active: boolean): void;
  log(line: string): void;
}) {
  let pending = false;
  let running: Promise<void> | undefined;
  let closed = false;
  const run = () => {
    if (closed || !pending || running !== undefined || options.busy() > 0) return;
    pending = false;
    options.lock(true);
    running = (async () => {
      const updates = new Map<ProgramId, { path: string | null; update: NonNullable<ProgramReport["update"]> }>();
      for (const program of options.report()) {
        if (closed || !programIsConfigured(program)) continue;
        try {
          const update = await options.steps.check(program);
          if (update === undefined) {
            updates.set(program.id, { path: program.path, update: { channel: null, note: program.id === "dsh" ? "Unrecognised installation channel; if bundled with DeepSeek Harness Desktop, update through the desktop application" : "Unrecognised installation channel; no verified safe updater" } });
            continue;
          }
          updates.set(program.id, { path: program.path, update: { channel: update.channel ?? "npm", note: null } });
          options.log(`${program.id} auto-update channel: ${update.channel ?? "npm"}`);
          if (program.version === null || (update.latest !== null && !newer(program.version, update.latest))) continue;
          options.log(`Updating ${program.id} from ${program.version} to ${update.latest ?? "vendor stable"}`);
          try {
            await update.install();
            await options.reprobe();
            options.log(`Updated ${program.id} from ${program.version} to ${options.report().find((entry) => entry.id === program.id)?.version ?? "unknown"}`);
          } catch (error) {
            options.log(`Updating ${program.id} from ${program.version} to ${update.latest ?? "vendor stable"} failed: ${String(error)}`);
            await options.reprobe();
          }
        } catch (error) {
          options.log(`Checking ${program.id} for updates failed: ${String(error)}`);
        }
      }
      options.publish(options.report().map((entry) => {
        const result = updates.get(entry.id);
        return entry.installed && result !== undefined && result.path === entry.path ? { ...entry, update: result.update } : entry;
      }));
    })().finally(() => {
      running = undefined;
      options.lock(false);
      run();
    });
  };
  return {
    check: () => { pending = true; run(); },
    changed: run,
    close: async () => { closed = true; await running; },
    settled: async () => { await running; },
  };
}
