import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  type Decision,
  type DeliveredFile,
  DeliveryFileName,
  type DeploymentFileReading,
  deploymentFile,
  type GeneratedText,
  largestMessageBytes,
  readDeploymentFile,
  type TaskAssignment,
  TaskHandback,
  type TaskMaterial,
  type TaskOutcome,
} from "@super-agent2/protocol";
import type { Git } from "./git.js";
import { type RemoteUrl, withClone, type WorkPaths } from "./workplace.js";

export function taskPaths(home: string, ticket: number, repository: string | null = null, folderOf: number = ticket): WorkPaths {
  const folder = join(home, "work", `t${ticket}`);
  const scratch = join(home, "work", `t${folderOf}`, "scratch");
  if (repository === null || repository === "") {
    return { clone: join(home, "repos", "none"), worktree: scratch, folder, handback: join(folder, "handback.json"), scratch };
  }
  const [owner = "unknown", name = "unknown"] = repository.split("/");
  return { clone: join(home, "repos", owner, name), worktree: join(home, "worktrees", `${name}-t${folderOf}`), folder, handback: join(folder, "handback.json"), scratch };
}

export function scratchFolder(paths: WorkPaths): string {
  return paths.scratch ?? join(paths.folder, "scratch");
}

export function inputFolder(paths: WorkPaths): string {
  return join(scratchFolder(paths), "input");
}

export function outputFolder(paths: WorkPaths): string {
  return join(scratchFolder(paths), "output");
}

export interface Checkout {
  readonly commit: string;
  readonly base: string;
  readonly created: boolean;
}

async function verified(git: Git, ref: string, cwd: string): Promise<string | undefined> {
  const found = await git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return found.code === 0 ? found.stdout.trim() : undefined;
}

export async function prepareCheckout(git: Git, remote: RemoteUrl, checkout: NonNullable<TaskAssignment["checkout"]>, paths: WorkPaths): Promise<Checkout> {
  return withClone(paths.clone, async () => {
    if (!existsSync(join(paths.clone, ".git"))) {
      rmSync(paths.clone, { recursive: true, force: true });
      mkdirSync(join(paths.clone, ".."), { recursive: true });
      await git.must(["clone", "--no-checkout", remote(checkout.repository), paths.clone], join(paths.clone, ".."));
    } else {
      await git.must(["fetch", "--prune", "origin"], paths.clone);
    }
    await git.run(["remote", "set-head", "origin", "--auto"], paths.clone);
    const base = (await git.must(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], paths.clone)).trim().replace(/^origin\//, "");
    const wanted = checkout.commit ?? checkout.ref;
    let commit: string | undefined;
    if (wanted === null) {
      commit = await verified(git, `origin/${base}`, paths.clone);
    } else {
      commit = (checkout.commit === null ? await verified(git, `origin/${wanted}`, paths.clone) : undefined) ?? (await verified(git, wanted, paths.clone));
      if (commit === undefined) {
        await git.run(["fetch", "origin", wanted], paths.clone);
        commit = await verified(git, wanted, paths.clone);
      }
    }
    if (commit === undefined) {
      throw new Error(`${checkout.repository} has no commit or branch ${wanted ?? base} to check out`);
    }
    if (existsSync(paths.worktree)) {
      if ((await verified(git, "HEAD", paths.worktree)) === commit) {
        return { commit, base, created: false };
      }
      await git.run(["worktree", "remove", "--force", paths.worktree], paths.clone);
      rmSync(paths.worktree, { recursive: true, force: true });
    }
    await git.run(["worktree", "prune"], paths.clone);
    mkdirSync(join(paths.worktree, ".."), { recursive: true });
    await git.must(["worktree", "add", "--detach", paths.worktree, commit], paths.clone);
    return { commit, base, created: true };
  });
}

export function deploymentProblem(reading: DeploymentFileReading | undefined, machine: string | undefined, commit: string): string | undefined {
  if (reading === undefined) {
    return `There is no ${deploymentFile} at ${commit}, so there is no deployment to follow on this machine`;
  }
  if (!reading.ok) {
    return `${deploymentFile} at ${commit} is not a valid deployment file: ${reading.reason}`;
  }
  if (machine !== undefined && reading.file.target !== machine) {
    return `${deploymentFile} at ${commit} names the machine ${reading.file.target}, and this machine is ${machine}; the deployment runs only where the file says`;
  }
  return undefined;
}

export function readDeploymentAt(checkout: string): DeploymentFileReading | undefined {
  const path = join(checkout, deploymentFile);
  if (!existsSync(path)) {
    return undefined;
  }
  return readDeploymentFile(readFileSync(path, "utf8"));
}

export function prepareScratch(paths: WorkPaths, materials: readonly TaskMaterial[], files: ReadonlyMap<string, string> = new Map()): void {
  mkdirSync(inputFolder(paths), { recursive: true });
  mkdirSync(outputFolder(paths), { recursive: true });
  for (const material of materials) {
    const given = files.get(material.name);
    if (given !== undefined) {
      const file = join(inputFolder(paths), material.name);
      if (!existsSync(file)) {
        copyFileSync(given, file);
      }
      continue;
    }
    if (material.text === null) {
      continue;
    }
    const file = join(inputFolder(paths), material.name);
    if (!existsSync(file)) {
      writeFileSync(file, material.text, "utf8");
    }
  }
}

export function listOutput(paths: WorkPaths): string[] {
  const folder = outputFolder(paths);
  if (!existsSync(folder)) {
    return [];
  }
  const names = readdirSync(folder, { recursive: true, encoding: "utf8" });
  return names.sort().flatMap((name) => {
    try {
      const stat = lstatSync(join(folder, name));
      return stat.isFile() ? [`${name} (${stat.size} bytes)`] : [];
    } catch {
      return [];
    }
  });
}

export function clearOutput(paths: WorkPaths): void {
  rmSync(outputFolder(paths), { recursive: true, force: true });
  rmSync(paths.handback, { force: true });
}

const mediaTypes: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".srt": "text/plain",
  ".vtt": "text/vtt",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

export function mediaTypeOf(name: string): string {
  return mediaTypes[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export type TaskCheckOutcome =
  | { readonly ok: true; readonly outcome: TaskOutcome; readonly text: string | null; readonly files: readonly DeliveredFile[]; readonly report: GeneratedText; readonly decisions: readonly Decision[] }
  | { readonly ok: false; readonly problem: string };

export interface TaskCheck {
  readonly paths: WorkPaths;
  readonly inlineBytes?: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export function travelsInline(text: string, limit: number = largestMessageBytes): boolean {
  return Buffer.byteLength(JSON.stringify(text), "utf8") <= limit;
}

export function checkTaskHandback(check: TaskCheck): TaskCheckOutcome {
  const { handback } = check.paths;
  const output = outputFolder(check.paths);
  let text: string;
  try {
    text = readFileSync(handback, "utf8").replace(/^﻿/, "");
  } catch {
    return {
      ok: false,
      problem: `You have not handed back: there is no file at ${handback}. Put any text or files in the output folder ${output}, then write that file as described in your task, with "outcome" done or failed and your "report".`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `The hand-back file ${handback} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Write it again.` };
  }
  const parsed = TaskHandback.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `The hand-back file ${handback} does not have the expected shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`).join("; ")}. It needs "outcome" ("done" or "failed"), "report" with "en" in English and "zh" in Simplified Chinese, and may name "text" (a file in the output folder whose text the owner reads), "files" (a list of file names in the output folder) and "decisions" (each with "chosen", "why" and "otherOptions", every one of them with "en" and "zh").`,
    };
  }
  const given = parsed.data;
  const names = [...(given.text === undefined || given.text === null ? [] : [given.text]), ...given.files];
  if (new Set(names).size !== names.length) {
    return { ok: false, problem: `The hand-back file ${handback} names a file twice. Each file is named once: the text file in "text", every other file in "files".` };
  }
  const sizes = new Map<string, number>();
  for (const name of names) {
    if (!DeliveryFileName.safeParse(name).success) {
      return { ok: false, problem: `"${name}" is not a file name. Name files that are directly in the output folder ${output}, without a folder path.` };
    }
    const path = join(output, name);
    let size: number;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) {
        return { ok: false, problem: `"${name}" in the output folder is not a regular file. Put the result there as a file.` };
      }
      size = stat.size;
    } catch {
      return { ok: false, problem: `The hand-back file names "${name}", but there is no such file in the output folder ${output}. Create it there or correct the name.` };
    }
    sizes.set(name, size);
  }
  let delivered: string | null = null;
  const listed = [...given.files];
  if (given.text !== undefined && given.text !== null) {
    const name = given.text;
    const inline = check.inlineBytes ?? largestMessageBytes;
    if ((sizes.get(name) ?? 0) > inline) {
      listed.unshift(name);
    } else {
      let decoded: string;
      try {
        decoded = decoder.decode(readFileSync(join(output, name))).replace(/^\uFEFF/, "");
      } catch {
        return { ok: false, problem: `"${name}" is not valid UTF-8 text. Write your text result as a UTF-8 file.` };
      }
      if (decoded.trim() === "") {
        return { ok: false, problem: `"${name}" is empty. Write your result into it.` };
      }
      if (travelsInline(decoded, inline)) {
        delivered = decoded;
      } else {
        listed.unshift(name);
      }
    }
  }
  const files: DeliveredFile[] = listed.map((name) => ({ name, size: sizes.get(name) ?? 0, mediaType: mediaTypeOf(name) }));
  return { ok: true, outcome: given.outcome, text: delivered, files, report: given.report, decisions: given.decisions };
}

export function materialLine(material: TaskMaterial): string {
  if (material.attachment !== null && material.attachment !== undefined) {
    return `- input/${material.name}, from ${material.source} (the file the owner attached, ${material.attachment.size} bytes)`;
  }
  return material.text === null
    ? `- Not a file: get it yourself from ${material.source} (named ${material.name})`
    : `- input/${material.name}, from ${material.source}`;
}

export interface TaskPlace {
  readonly scratch: string;
  readonly input: string;
  readonly output: string;
  readonly handback: string;
  readonly checkout: string | null;
  readonly commit: string | null;
  readonly machine: string | undefined;
}

export function taskPlace(paths: WorkPaths, checkout: TaskAssignment["checkout"], commit: string | null, machine: string | undefined): TaskPlace {
  return {
    scratch: scratchFolder(paths),
    input: inputFolder(paths),
    output: outputFolder(paths),
    handback: paths.handback,
    checkout: checkout === null ? null : paths.worktree,
    commit,
    machine,
  };
}

export function assignmentText(task: TaskAssignment, place: TaskPlace): string {
  const repository = task.checkout?.repository;
  return [
    "# Your task",
    "",
    `Title: ${task.title}`,
    ...(place.machine === undefined ? [] : [`This machine: ${place.machine}`]),
    `Scratch folder: ${place.scratch}`,
    `Material folder: ${place.input}`,
    `Output folder: ${place.output}`,
    ...(repository === undefined || place.checkout === null
      ? []
      : [`Checkout of ${repository}: ${place.checkout}, at commit ${place.commit ?? "unknown"} (detached; you start there)`]),
    ...(task.deploys && place.checkout !== null ? [`Deployment recipe: ${join(place.checkout, deploymentFile)}`] : []),
    `Hand back by writing the JSON file at: ${place.handback}`,
    "",
    "What to do:",
    "",
    task.task,
    "",
    task.materials.length === 0 ? "There is no material beyond the task text." : "Material, and where each piece comes from:",
    ...task.materials.map(materialLine),
  ].join("\n");
}
