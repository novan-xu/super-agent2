import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProgramId, ProgramModel, ProgramReport } from "@super-agent2/protocol";
import { z } from "zod";
import { killTree } from "./shell.js";

export interface CaptureOptions {
  readonly input?: string;
  readonly until?: (line: string) => boolean;
  readonly stderr?: boolean;
}

export interface Prober {
  find(executable: string): string | undefined;
  capture(path: string, args: readonly string[], options?: CaptureOptions): Promise<string>;
}

export interface ProgramDefinition {
  readonly id: ProgramId;
  readonly executable: string;
  readonly versionArgs: readonly string[];
  readonly version: (output: string) => string | null;
  readonly models?: (prober: Prober, path: string) => Promise<ProgramModel[]>;
  readonly configured?: readonly ProgramModel[];
}

const effortLevels = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function firstLine(output: string): string | null {
  const line = output.split(/\r?\n/).find((item) => item.trim() !== "");
  return line === undefined ? null : line.trim();
}

const CodexCatalog = z.object({
  models: z.array(
    z.looseObject({
      slug: z.string().min(1),
      visibility: z.string().optional(),
      supported_reasoning_levels: z.array(z.looseObject({ effort: z.string().min(1) })).optional(),
    }),
  ),
});

export function codexModels(output: string): ProgramModel[] {
  const start = output.indexOf("{");
  const catalog = CodexCatalog.parse(JSON.parse(output.slice(start)));
  return catalog.models
    .filter((model) => model.visibility === undefined || model.visibility === "list")
    .map((model) => ({ id: model.slug, efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort) }));
}

const ClaudeInitialize = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: z.literal("success"),
    request_id: z.string(),
    response: z.looseObject({
      models: z.array(
        z.looseObject({
          value: z.string().min(1),
          resolvedModel: z.string().min(1).optional(),
          supportsEffort: z.boolean().optional(),
          supportedEffortLevels: z.array(z.string().min(1)).optional(),
        }),
      ),
    }),
  }),
});

export const claudeInitializeRequest = { type: "control_request", request_id: "superagent2-models", request: { subtype: "initialize" } };

export function claudeModels(output: string): ProgramModel[] {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("control_response")) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = ClaudeInitialize.safeParse(value);
    if (!parsed.success || parsed.data.response.request_id !== claudeInitializeRequest.request_id) {
      continue;
    }
    const models = new Map<string, ProgramModel>();
    for (const model of parsed.data.response.response.models) {
      const id = model.resolvedModel ?? model.value;
      if (!models.has(id)) {
        models.set(id, { id, efforts: model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []) });
      }
    }
    return [...models.values()];
  }
  throw new Error("Claude Code did not answer the initialize request with its models");
}

export function antigravityEfforts(help: string): string[] {
  const line = help.split(/\r?\n/).find((item) => /^\s*--effort\b/.test(item));
  const match = line === undefined ? null : /\(([a-z|]+)\)/.exec(line);
  return match?.[1] === undefined ? [] : match[1].split("|").filter((effort) => effort !== "");
}

export function antigravityModels(listing: string, efforts: readonly string[]): ProgramModel[] {
  const models = new Map<string, string[]>();
  for (const raw of listing.split(/\r?\n/)) {
    const id = raw.split("\t")[0]?.trim() ?? "";
    if (id === "" || /\s/.test(id) || !raw.includes("\t")) {
      continue;
    }
    const suffix = /^(.+)-([a-z]+)$/.exec(id);
    const level = suffix?.[2];
    if (suffix?.[1] !== undefined && level !== undefined && effortLevels.includes(level)) {
      const levels = models.get(suffix[1]) ?? [];
      levels.push(level);
      models.set(suffix[1], levels);
      continue;
    }
    models.set(id, [...efforts]);
  }
  return [...models.entries()].map(([id, levels]) => ({
    id,
    efforts: [...levels].sort((a, b) => effortLevels.indexOf(a) - effortLevels.indexOf(b)),
  }));
}

export const defaultDshModels: readonly ProgramModel[] = [{ id: "deepseek-flash", efforts: ["off", "low", "high", "max"] }];

export function programDefinitions(configured: Readonly<Partial<Record<ProgramId, readonly ProgramModel[]>>>): ProgramDefinition[] {
  const withConfiguration = (definition: ProgramDefinition): ProgramDefinition => {
    const models = configured[definition.id];
    if (models === undefined) {
      return definition;
    }
    const { models: _ignored, ...rest } = definition;
    return { ...rest, configured: models };
  };
  return [
    withConfiguration({
      id: "codex",
      executable: "codex",
      versionArgs: ["--version"],
      version: (output) => firstLine(output)?.replace(/^codex-cli\s+/, "") ?? null,
      models: async (prober, path) => codexModels(await prober.capture(path, ["debug", "models"])),
    }),
    withConfiguration({
      id: "claude",
      executable: "claude",
      versionArgs: ["--version"],
      version: (output) => firstLine(output)?.split(/\s+/)[0] ?? null,
      models: async (prober, path) =>
        claudeModels(
          await prober.capture(path, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
            input: `${JSON.stringify(claudeInitializeRequest)}\n`,
            until: (line) => line.includes(claudeInitializeRequest.request_id),
          }),
        ),
    }),
    withConfiguration({
      id: "dsh",
      executable: "dsh",
      versionArgs: ["--version"],
      version: firstLine,
      configured: defaultDshModels,
    }),
    withConfiguration({
      id: "antigravity",
      executable: "agy",
      versionArgs: ["--version"],
      version: firstLine,
      models: async (prober, path) => {
        const efforts = antigravityEfforts(await prober.capture(path, ["--help"], { stderr: true }));
        return antigravityModels(await prober.capture(path, ["models"]), efforts);
      },
    }),
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeProgram(definition: ProgramDefinition, prober: Prober): Promise<ProgramReport> {
  const path = prober.find(definition.executable);
  if (path === undefined) {
    return { id: definition.id, installed: false, path: null, version: null, models: [], source: "none", problem: null };
  }
  let version: string | null = null;
  const problems: string[] = [];
  try {
    version = definition.version(await prober.capture(path, definition.versionArgs));
  } catch (error) {
    problems.push(`version: ${messageOf(error)}`);
  }
  if (definition.models === undefined) {
    return {
      id: definition.id,
      installed: true,
      path,
      version,
      models: [...(definition.configured ?? [])],
      source: "configuration",
      problem: problems.length > 0 ? problems.join("; ") : null,
    };
  }
  try {
    const models = await definition.models(prober, path);
    return { id: definition.id, installed: true, path, version, models, source: "program", problem: problems.length > 0 ? problems.join("; ") : null };
  } catch (error) {
    problems.push(`models: ${messageOf(error)}`);
    return { id: definition.id, installed: true, path, version, models: [], source: "none", problem: problems.join("; ") };
  }
}

export function probePrograms(definitions: readonly ProgramDefinition[], prober: Prober): Promise<ProgramReport[]> {
  return Promise.all(definitions.map((definition) => probeProgram(definition, prober)));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface SystemProberOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly cwd: string;
  readonly limitMilliseconds?: number;
}

function quoted(value: string): string {
  return `"${value}"`;
}

export function findExecutable(executable: string, environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | undefined {
  const pathText = Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const extensions =
    platform === "win32"
      ? (Object.entries(environment).find(([name]) => name.toUpperCase() === "PATHEXT")?.[1] ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter((extension) => extension !== "")
      : [""];
  for (const folder of pathText.split(platform === "win32" ? ";" : delimiter)) {
    if (folder.trim() === "") {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(folder.trim().replace(/^"|"$/g, ""), `${executable}${extension.toLowerCase()}`);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function systemProber(options: SystemProberOptions): Prober {
  const platform = options.platform ?? process.platform;
  const limit = options.limitMilliseconds ?? 120000;
  return {
    find: (executable) => findExecutable(executable, options.environment, platform),
    capture: (path, args, captureOptions = {}) =>
      new Promise((resolve, reject) => {
        mkdirSync(options.cwd, { recursive: true });
        const child = spawn([quoted(path), ...args.map((arg) => platform === "win32" ? `"${arg.replaceAll('"', '""')}"` : `'${arg.replaceAll("'", "'\\''")}'`)].join(" "), {
          shell: true,
          cwd: options.cwd,
          env: { ...options.environment },
          detached: platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let settled = false;
        let pending = "";
        const finish = (error: Error | undefined) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          const output = Buffer.concat(chunks).toString("utf8");
          if (child.exitCode === null && child.pid !== undefined) {
            void killTree(child.pid, platform);
          }
          if (error === undefined) {
            resolve(output);
          } else {
            reject(error);
          }
        };
        const timer = setTimeout(() => finish(new Error(`${path} ${args.join(" ")} did not finish`)), limit);
        child.stdout?.on("data", (data: Buffer) => {
          chunks.push(data);
          if (captureOptions.until !== undefined) {
            pending += data.toString("utf8");
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            if (lines.some(captureOptions.until)) {
              finish(undefined);
            }
          }
        });
        if (captureOptions.stderr === true) {
          child.stderr?.on("data", (data: Buffer) => chunks.push(data));
        } else {
          child.stderr?.resume();
        }
        child.stdin?.on("error", () => undefined);
        if (captureOptions.input === undefined) {
          child.stdin?.end();
        } else {
          child.stdin?.write(captureOptions.input);
        }
        child.once("error", (error) => finish(error));
        child.once("close", (code) => {
          if (code === 0 || captureOptions.until === undefined) {
            finish(code === 0 ? undefined : new Error(`${path} ${args.join(" ")} exited with ${String(code)}`));
          } else {
            finish(new Error(`${path} ${args.join(" ")} exited with ${String(code)} before answering`));
          }
        });
      }),
  };
}
