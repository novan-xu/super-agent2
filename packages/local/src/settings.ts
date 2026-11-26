import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mergeEnvironment, parseSettings } from "@super-agent2/runner";

export type Environment = Readonly<Record<string, string | undefined>>;

export function stateFolder(environment: Environment): string {
  const base = process.platform === "win32" ? join(environment.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "super-agent2") : join(homedir(), ".super-agent2");
  return realLocation(resolve(environment.SUPERAGENT2_HOME || base));
}

function realLocation(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return resolve(realLocation(dirname(path)), relative(dirname(path), path));
  }
}

function includesPath(base: string, path: string): boolean {
  const rest = relative(base, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function projectsFolder(value: string | undefined, home: string): string {
  if (value === undefined || !isAbsolute(value)) throw new Error("PROJECTS_DIR must be an absolute folder in local.env");
  const projects = realpathSync.native(value);
  if (!statSync(projects).isDirectory()) throw new Error("PROJECTS_DIR must be a folder");
  if (includesPath(projects, home)) throw new Error("SUPERAGENT2_HOME must be outside PROJECTS_DIR");
  return projects;
}

export function readLocalSettings(home: string, inherited: Environment): { readonly env: Environment; readonly projects: string } | undefined {
  const file = join(home, "local.env");
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (inherited.PROJECTS_DIR) projectsFolder(inherited.PROJECTS_DIR, home);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(file, "PROJECTS_DIR=\nPORT=18180\nTIME_ZONE=\n", { mode: 0o600, flag: "wx" });
    return undefined;
  }
  const env = mergeEnvironment(inherited, parseSettings(contents));
  return { env, projects: projectsFolder(env.PROJECTS_DIR, home) };
}

export function hubEnvironment(home: string, env: Environment): Environment {
  return mergeEnvironment(env, {
    HUB_DATA_DIR: join(home, "hub"),
    HUB_BRAIN_TOKEN_FILE: join(home, "hub", "brain.token"),
    HUB_ATTACHMENTS_DIR: join(home, "hub", "attachments"),
    HUB_HOST: env.HUB_HOST ?? "127.0.0.1",
    HUB_PORT: env.HUB_PORT ?? (env.PORT || "18180"),
    HUB_TICKET_TIME_ZONE: env.HUB_TICKET_TIME_ZONE || env.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}
