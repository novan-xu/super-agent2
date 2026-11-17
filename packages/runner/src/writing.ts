import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  type DeliveredFile,
  DeliveryFileName,
  type GeneratedText,
  maximumDeliveredBytes,
  maximumDeliveredFileBytes,
  maximumDeliveredFiles,
  maximumDeliveredText,
  type WritingMaterial,
  WritingHandback,
  type WritingTask,
} from "@super-agent2/protocol";
import type { WorkPaths } from "./workplace.js";

export function writingPaths(home: string, ticket: number): WorkPaths {
  const folder = join(home, "work", `t${ticket}`);
  return {
    clone: join(home, "repos", "none"),
    worktree: join(folder, "scratch"),
    folder,
    handback: join(folder, "handback.json"),
  };
}

export function inputFolder(paths: WorkPaths): string {
  return join(paths.worktree, "input");
}

export function outputFolder(paths: WorkPaths): string {
  return join(paths.worktree, "output");
}

export function prepareScratch(paths: WorkPaths, materials: readonly WritingMaterial[]): void {
  mkdirSync(inputFolder(paths), { recursive: true });
  mkdirSync(outputFolder(paths), { recursive: true });
  for (const material of materials) {
    if (material.text === null) {
      continue;
    }
    const file = join(inputFolder(paths), material.name);
    if (!existsSync(file)) {
      writeFileSync(file, material.text, "utf8");
    }
  }
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

export type WritingOutcome =
  | { readonly ok: true; readonly text: string | null; readonly files: readonly DeliveredFile[]; readonly report: GeneratedText }
  | { readonly ok: false; readonly problem: string };

export interface WritingCheck {
  readonly paths: WorkPaths;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function megabytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`;
}

export function checkWritingHandback(check: WritingCheck): WritingOutcome {
  const { handback } = check.paths;
  const output = outputFolder(check.paths);
  let text: string;
  try {
    text = readFileSync(handback, "utf8").replace(/^﻿/, "");
  } catch {
    return {
      ok: false,
      problem: `You have not handed back: there is no file at ${handback}. Put your result in the output folder ${output}, then write that file as described in your task.`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `The hand-back file ${handback} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Write it again.` };
  }
  const parsed = WritingHandback.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `The hand-back file ${handback} does not have the expected shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`).join("; ")}. It needs "summary" with "en" in English and "zh" in Simplified Chinese, and "text" (the name of the file in the output folder that holds your result) and/or "files" (a list of file names in the output folder).`,
    };
  }
  const given = parsed.data;
  const names = [...(given.text === undefined || given.text === null ? [] : [given.text]), ...given.files];
  if (names.length === 0) {
    return { ok: false, problem: `The hand-back file ${handback} names nothing to deliver. Name your result file in "text", and any other files in "files".` };
  }
  if (new Set(names).size !== names.length) {
    return { ok: false, problem: `The hand-back file ${handback} names a file twice. Each file is named once: the text file in "text", every other file in "files".` };
  }
  if (given.files.length > maximumDeliveredFiles) {
    return { ok: false, problem: `You listed ${given.files.length} files; at most ${maximumDeliveredFiles} can be delivered. Combine them and write the hand-back file again.` };
  }
  const read = new Map<string, Buffer>();
  let total = 0;
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
    if (size > maximumDeliveredFileBytes) {
      return { ok: false, problem: `"${name}" is ${size} bytes; a delivered file can be at most ${megabytes(maximumDeliveredFileBytes)}. Make it smaller or split it, then write the hand-back file again.` };
    }
    total += size;
    if (total > maximumDeliveredBytes) {
      return { ok: false, problem: `The files together are more than ${megabytes(maximumDeliveredBytes)}. Deliver less, then write the hand-back file again.` };
    }
    read.set(name, readFileSync(path));
  }
  let delivered: string | null = null;
  if (given.text !== undefined && given.text !== null) {
    const bytes = read.get(given.text);
    try {
      delivered = decoder.decode(bytes).replace(/^﻿/, "");
    } catch {
      return { ok: false, problem: `"${given.text}" is not valid UTF-8 text. Write your text result as a UTF-8 file.` };
    }
    if (delivered.trim() === "") {
      return { ok: false, problem: `"${given.text}" is empty. Write your result into it.` };
    }
    if (delivered.length > maximumDeliveredText) {
      return { ok: false, problem: `"${given.text}" is ${delivered.length} characters; a text result can be at most ${maximumDeliveredText}. Deliver the rest as a file listed in "files", or shorten it.` };
    }
  }
  const files: DeliveredFile[] = given.files.map((name) => {
    const bytes = read.get(name) ?? Buffer.alloc(0);
    return { name, size: bytes.length, mediaType: mediaTypeOf(name), data: bytes.toString("base64") };
  });
  return { ok: true, text: delivered, files, report: given.summary };
}

export function materialLine(material: WritingMaterial): string {
  return material.text === null
    ? `- Not a file: get it yourself from ${material.source} (named ${material.name})`
    : `- input/${material.name}, from ${material.source}`;
}

export interface WritingPlace {
  readonly scratch: string;
  readonly input: string;
  readonly output: string;
  readonly handback: string;
}

export function writingPlace(paths: WorkPaths): WritingPlace {
  return { scratch: paths.worktree, input: inputFolder(paths), output: outputFolder(paths), handback: paths.handback };
}

export function writingTaskText(task: WritingTask, place: WritingPlace): string {
  return [
    "# Your task",
    "",
    `Title: ${task.title}`,
    `Working folder: ${place.scratch}`,
    `Material folder: ${place.input}`,
    `Output folder: ${place.output}`,
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
