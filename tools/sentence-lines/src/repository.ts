import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "@super-agent2/zero-comment";
import { findSentenceLines } from "./index.js";

export function checkRepository(root: string): { checked: number; lines: string[] } {
  let checked = 0;
  const lines: string[] = [];
  for (const path of listFiles(root)) {
    if (!/\.(?:md|markdown)$/i.test(path)) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    checked++;
    for (const finding of findSentenceLines(readFileSync(absolute, "utf8"))) {
      lines.push(`${path}:${finding.line}: ${finding.message}`);
    }
  }
  return { checked, lines };
}
