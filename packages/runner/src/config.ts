import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MachineName, type ProgramId, type ProgramModel, programIds, type StorageSettings } from "@super-agent2/protocol";

export const homeVariable = "SUPERAGENT2_RUNNER_HOME";

export function runnerHome(environment: Readonly<Record<string, string | undefined>>): string {
  const override = environment[homeVariable];
  return override !== undefined && override !== "" ? override : join(homedir(), ".superagent2");
}

export interface RunnerFiles {
  readonly home: string;
  readonly settings: string;
  readonly log: string;
  readonly supervisor: string;
  readonly running: string;
  readonly probe: string;
}

export function runnerFiles(home: string): RunnerFiles {
  return {
    home,
    settings: join(home, "runner.env"),
    log: join(home, "runner.log"),
    supervisor: join(home, "supervisor.pid"),
    running: join(home, "running.json"),
    probe: join(home, "probe"),
  };
}

export interface RunnerConfig {
  readonly hub: string;
  readonly name: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  readonly runnerToken: string;
  readonly slots: number;
  readonly models: Readonly<Partial<Record<ProgramId, readonly ProgramModel[]>>>;
  readonly storage?: StorageSettings;
}

export type ConfigResult = { readonly ok: true; readonly config: RunnerConfig } | { readonly ok: false; readonly problems: readonly string[] };

export const settingNames = {
  hub: "SUPERAGENT2_HUB",
  name: "MACHINE_NAME",
  accessClientId: "ACCESS_CLIENT_ID",
  accessClientSecret: "ACCESS_CLIENT_SECRET",
  runnerToken: "RUNNER_TOKEN",
  slots: "RUNNER_SLOTS",
} as const;

export function modelsVariable(program: ProgramId): string {
  return `RUNNER_MODELS_${program.toUpperCase()}`;
}

export const defaultSlots = 8;

export function parseSettings(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const name = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

export function formatSettings(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

export function parseModels(text: string): ProgramModel[] | undefined {
  const models: ProgramModel[] = [];
  for (const part of text.split(",")) {
    const item = part.trim();
    if (item === "") {
      continue;
    }
    const [id, efforts, ...extra] = item.split(":");
    if (id === undefined || id.trim() === "" || extra.length > 0) {
      return undefined;
    }
    models.push({
      id: id.trim(),
      efforts: (efforts ?? "")
        .split("|")
        .map((effort) => effort.trim())
        .filter((effort) => effort !== ""),
    });
  }
  return models;
}

export function loadConfig(values: Readonly<Record<string, string | undefined>>): ConfigResult {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = values[name] ?? "";
    if (value === "") {
      problems.push(`${name} is required`);
    }
    return value;
  };
  const hub = required(settingNames.hub);
  if (hub !== "") {
    try {
      const url = new URL(hub);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        problems.push(`${settingNames.hub} must be an https or http address`);
      }
    } catch {
      problems.push(`${settingNames.hub} must be an https or http address`);
    }
  }
  const name = required(settingNames.name);
  if (name !== "" && !MachineName.safeParse(name).success) {
    problems.push(`${settingNames.name} must be lower-case letters, digits and dashes`);
  }
  const accessClientId = required(settingNames.accessClientId);
  const accessClientSecret = required(settingNames.accessClientSecret);
  const runnerToken = required(settingNames.runnerToken);
  if (runnerToken !== "" && !/^[A-Za-z0-9_-]{43,}$/.test(runnerToken)) {
    problems.push(`${settingNames.runnerToken} is not a runner token`);
  }
  const slotsText = values[settingNames.slots] ?? "";
  const slots = slotsText === "" ? defaultSlots : Number(slotsText);
  if (!Number.isInteger(slots) || slots < 0) {
    problems.push(`${settingNames.slots} must be a whole number`);
  }
  const models: Partial<Record<ProgramId, readonly ProgramModel[]>> = {};
  for (const program of programIds) {
    const text = values[modelsVariable(program)];
    if (text === undefined || text === "") {
      continue;
    }
    const parsed = parseModels(text);
    if (parsed === undefined) {
      problems.push(`${modelsVariable(program)} must look like model:effort|effort,model:effort`);
    } else {
      models[program] = parsed;
    }
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const projectsDir = values.PROJECTS_DIR?.trim() || undefined;
  const artifactsDir = values.ARTIFACTS_DIR?.trim() || undefined;
  return { ok: true, config: { hub, name, accessClientId, accessClientSecret, runnerToken, slots, models, ...(projectsDir === undefined && artifactsDir === undefined ? {} : { storage: { projectsDir, artifactsDir } }) } };
}

export function readSettingsFile(path: string): Record<string, string> | undefined {
  try {
    return parseSettings(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
