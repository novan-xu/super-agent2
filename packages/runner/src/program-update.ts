import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ProgramId, ProgramReport } from "@super-agent2/protocol";
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
  check(program: ProgramReport): Promise<{ latest: string; install(): Promise<void> } | undefined>;
}

export function systemProgramUpdateSteps(prober: Prober): ProgramUpdateSteps {
  return {
    check: async (program) => {
      const name = packages[program.id];
      const npm = prober.find("npm");
      if (name === undefined || npm === undefined || program.path === null) return undefined;
      const root = (await prober.capture(npm, ["root", "--global"])).trim();
      const folder = await npmPackageFor(program.path, root, name);
      if (folder === undefined) return undefined;
      const latest = (await prober.capture(npm, ["view", `${name}@latest`, "version"])).trim();
      return {
        latest,
        install: async () => {
          const backup = await mkdtemp(join(tmpdir(), "sa2-program-"));
          try {
            await cp(folder, join(backup, "package"), { recursive: true, dereference: false });
            const executable = program.path;
            if (executable === null) throw new Error("program path is missing");
            await cp(executable, join(backup, "executable"), { dereference: false, verbatimSymlinks: true });
            try {
              await prober.capture(npm, ["install", "--global", `${name}@${latest}`]);
            } catch (error) {
              await rm(folder, { recursive: true, force: true });
              await cp(join(backup, "package"), folder, { recursive: true, dereference: false });
              await rm(executable, { force: true });
              await cp(join(backup, "executable"), executable, { dereference: false, verbatimSymlinks: true });
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
      const unrecognised = new Set<ProgramId>();
      for (const program of options.report()) {
        if (closed || !program.installed) continue;
        try {
          const update = await options.steps.check(program);
          if (update === undefined) {
            unrecognised.add(program.id);
            continue;
          }
          if (program.version === null || !newer(program.version, update.latest)) continue;
          options.log(`Updating ${program.id} from ${program.version} to ${update.latest}`);
          try {
            await update.install();
            await options.reprobe();
            options.log(`Updated ${program.id} from ${program.version} to ${options.report().find((entry) => entry.id === program.id)?.version ?? "unknown"}`);
          } catch (error) {
            options.log(`Updating ${program.id} from ${program.version} to ${update.latest} failed: ${String(error)}`);
            await options.reprobe();
          }
        } catch (error) {
          options.log(`Checking ${program.id} for updates failed: ${String(error)}`);
        }
      }
      options.publish(options.report().map((entry) => unrecognised.has(entry.id) ? { ...entry, problem: [entry.problem, "auto-update: unrecognised installation channel"].filter(Boolean).join("; ") } : entry));
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
