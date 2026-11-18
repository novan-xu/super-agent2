import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./finding.js";
import { findComments, languageOf } from "./languages.js";

export interface FileFinding extends Finding {
  path: string;
}

export interface RepositoryReport {
  checked: number;
  findings: FileFinding[];
  conflicts: FileFinding[];
}

export const conflictMessage = "merge conflict marker";

export function checkConflicts(text: string): Finding[] {
  if (text.includes("\0")) {
    return [];
  }
  const found: Finding[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("<<<<<<<") || line.startsWith(">>>>>>>")) {
      found.push({ line: index + 1, column: 1, message: conflictMessage });
    }
  }
  return found;
}

export function listFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter((path) => path !== ""))].sort();
}

export function checkText(path: string, text: string): Finding[] {
  const language = languageOf(path);
  if (language === undefined) {
    return [];
  }
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const unique = new Map<string, Finding>();
  for (const finding of findComments(language, body)) {
    unique.set(`${finding.line}:${finding.column}:${finding.message}`, finding);
  }
  return [...unique.values()].sort((a, b) => a.line - b.line || a.column - b.column);
}

export function checkRepository(root: string): RepositoryReport {
  const findings: FileFinding[] = [];
  const conflicts: FileFinding[] = [];
  let checked = 0;
  for (const path of listFiles(root)) {
    const absolute = join(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    for (const finding of checkConflicts(text)) {
      conflicts.push({ path, ...finding });
    }
    if (languageOf(path) === undefined) {
      continue;
    }
    checked += 1;
    for (const finding of checkText(path, text)) {
      findings.push({ path, ...finding });
    }
  }
  return { checked, findings, conflicts };
}

export function formatFinding(finding: FileFinding): string {
  return `${finding.path}:${finding.line}:${finding.column}: ${finding.message}`;
}
