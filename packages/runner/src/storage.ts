import { constants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, storageFolders, type StorageProblem, type StorageReport, StorageSettings } from "@super-agent2/protocol";
import { replaceFile } from "./replace-file.js";

export const artifactsVariable = "SUPERAGENT2_ARTIFACTS_DIR";

export interface StorageSelection {
  readonly projectsDir?: string | undefined;
  readonly artifactsDir?: string | undefined;
}

export interface ArtifactFolder {
  readonly path: string;
  readonly unavailable: string | null;
}

export function absoluteOn(platform: NodeJS.Platform, path: string): boolean {
  return platform === "win32" ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/i.test(path) : path.startsWith("/");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function sharedPath<T>(operation: () => Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation(), new Promise<undefined>((resolve) => { timer = setTimeout(resolve, 3000); })]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function checkArtifacts(root: string): Promise<void> {
  if (!(await stat(root)).isDirectory()) throw new Error("The artifacts path is not a folder");
  await access(root, constants.W_OK | constants.X_OK);
}

export async function ticketArtifacts(home: string, root: string | undefined, repository: string | null, ticket: number): Promise<ArtifactFolder> {
  const repositoryName = repository?.split("/").at(-1)?.toLowerCase() ?? "_tasks";
  const parts = [repositoryName, "tickets", `t${ticket}`];
  if (root !== undefined) {
    const path = await sharedPath(async () => {
      await checkArtifacts(root);
      let next = root;
      for (const part of parts) {
        next = join(next, part);
        try {
          await mkdir(next);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(next)).isDirectory()) throw error;
        }
      }
      await access(next, constants.W_OK | constants.X_OK);
      return next;
    });
    if (path !== undefined) return { path, unavailable: null };
  }
  const path = join(home, "artifacts", ...parts);
  await mkdir(path, { recursive: true });
  return { path, unavailable: root ?? null };
}

export class MachineStorage {
  private readonly file: string;
  private requested: StorageSettings = {};
  private accepted: StorageSettings = {};

  constructor(
    private readonly home: string,
    private readonly env: StorageSettings,
    private readonly platform = process.platform,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.file = join(home, "storage.json");
    try {
      this.accepted = this.requested = StorageSettings.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`Could not read storage settings from ${this.file}`);
    }
  }

  apply(settings: StorageSettings): void {
    this.requested = settings;
    this.select();
  }

  private problem(folder: keyof StorageSettings, path: string): StorageProblem | undefined {
    if (!FolderPath.safeParse(path).success || !absoluteOn(this.platform, path)) return "not-absolute";
    if (folder === "projectsDir" && !isDirectory(path)) return "not-found";
    return undefined;
  }

  private select(): { selection: StorageSettings; problems: Partial<Record<keyof StorageSettings, StorageProblem>> } {
    const selection: StorageSettings = {};
    const problems: Partial<Record<keyof StorageSettings, StorageProblem>> = {};
    const accepted: StorageSettings = {};
    for (const folder of storageFolders) {
      const asked = this.requested[folder];
      const local = this.env[folder];
      const before = this.accepted[folder];
      const problem = asked === undefined ? undefined : this.problem(folder, asked);
      const chosen = problem === undefined ? asked : before;
      if (chosen !== undefined) accepted[folder] = chosen;
      const fallbackProblem = local === undefined ? undefined : this.problem(folder, local);
      if (chosen !== undefined && this.problem(folder, chosen) === undefined) {
        selection[folder] = chosen;
      } else if (local !== undefined && fallbackProblem === undefined) {
        selection[folder] = local;
      }
      const reported = problem ?? (asked === undefined ? fallbackProblem : undefined);
      if (reported !== undefined) problems[folder] = reported;
    }
    if (this.accepted.projectsDir !== accepted.projectsDir || this.accepted.artifactsDir !== accepted.artifactsDir) {
      this.accepted = accepted;
      try {
        mkdirSync(this.home, { recursive: true });
        const content = JSON.stringify(accepted);
        writeFileSync(`${this.file}.new`, content);
        replaceFile(`${this.file}.new`, this.file, content);
      } catch {
        this.log(`Could not save storage settings to ${this.file}`);
      }
    }
    return { selection, problems };
  }

  selection(): StorageSelection {
    return this.select().selection;
  }

  initialReport(): StorageReport {
    const { selection, problems } = this.select();
    return {
      projectsDir: { path: selection.projectsDir ?? join(this.home, "repos"), problem: problems.projectsDir },
      artifactsDir: { path: join(this.home, "artifacts"), problem: problems.artifactsDir },
    };
  }

  async report(): Promise<StorageReport> {
    const { selection, problems } = this.select();
    const shared = selection.artifactsDir;
    const reachable = shared === undefined ? undefined : (await sharedPath(async () => { await checkArtifacts(shared); return true; })) === true;
    return {
      projectsDir: { path: selection.projectsDir ?? join(this.home, "repos"), problem: problems.projectsDir },
      artifactsDir: { path: reachable && shared !== undefined ? shared : join(this.home, "artifacts"), reachable, problem: problems.artifactsDir ?? (reachable === false ? "unreachable" : undefined) },
    };
  }
}
