import { execFile } from "node:child_process";
import { access, mkdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gt, valid } from "semver";
import type { Brain } from "./brain.js";

const exec = promisify(execFile);
const programs = [
  { name: "codex", package: "@openai/codex" },
  { name: "claude", package: "@anthropic-ai/claude-code" },
  { name: "dsh", package: "@deepseek-ai/dsh" },
] as const;
const interval = 6 * 60 * 60 * 1000;

export interface ProgramUpdateSteps {
  current(name: string, packageName: string): Promise<string>;
  latest(packageName: string): Promise<string>;
  install(name: string, packageName: string, version: string): Promise<void>;
}

export async function updatePrograms(steps: ProgramUpdateSteps, report: (line: string) => void): Promise<void> {
  for (const program of programs) {
    try {
      const current = await steps.current(program.name, program.package);
      const latest = await steps.latest(program.package);
      if (valid(current) === null || valid(latest) === null) {
        throw new Error(`invalid version: installed ${current}, latest ${latest}`);
      }
      if (gt(latest, current)) {
        await steps.install(program.name, program.package, latest);
        report(`Updated ${program.name} from ${current} to ${latest}`);
      } else if (gt(current, latest)) {
        report(`Keeping ${program.name} ${current}; npm latest is older (${latest})`);
      }
    } catch (error) {
      report(`Could not update ${program.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function systemProgramUpdateSteps(root: string): ProgramUpdateSteps {
  const bin = join(root, "bin");
  return {
    current: async (name, packageName) => {
      const versionAt = async (path: string): Promise<string> => {
        const data: unknown = JSON.parse(await readFile(path, "utf8"));
        if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string" || valid(data.version) === null) throw new Error(`Missing version in ${path}`);
        return data.version;
      };
      const floor = await versionAt(join("/usr/local/lib/node_modules", packageName, "package.json"));
      let target: string;
      try {
        target = await readlink(join(bin, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return floor;
        throw error;
      }
      const installed = await versionAt(join(resolve(bin, target), "..", "..", packageName, "package.json"));
      if (gt(floor, installed)) {
        await rm(join(bin, name));
        return floor;
      }
      return installed;
    },
    latest: async (packageName) => (await exec("npm", ["view", packageName, "version", "--json"], { timeout: 60_000 })).stdout.trim().replace(/^"|"$/g, ""),
    install: async (name, packageName, version) => {
      await mkdir(bin, { recursive: true });
      const stage = join(root, `${name}-${version}-${Date.now()}`);
      const temporary = join(bin, `.${name}-${process.pid}`);
      try {
        await exec("npm", ["install", "--prefix", stage, "--no-audit", "--no-fund", `${packageName}@${version}`], { timeout: 300_000 });
        const executable = join(stage, "node_modules", ".bin", name);
        await access(executable);
        await symlink(executable, temporary);
        await rename(temporary, join(bin, name));
      } catch (error) {
        await rm(temporary, { force: true });
        await rm(stage, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

export function startProgramUpdates(brain: Brain, root: string, report: (line: string) => void): () => void {
  const steps = systemProgramUpdateSteps(root);
  const run = () => { void brain.maintenance(() => updatePrograms(steps, report)); };
  run();
  const timer = setInterval(run, interval);
  return () => clearInterval(timer);
}
