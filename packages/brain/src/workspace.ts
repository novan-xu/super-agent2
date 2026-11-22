import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const guidanceFiles = ["AGENTS.md", "deployment.md", "tasks.md"];

export function prepareWorkspace(workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  for (const file of guidanceFiles) {
    copyFileSync(new URL(`../guidance/${file}`, import.meta.url), join(workspace, file));
  }
  writeFileSync(join(workspace, "CLAUDE.md"), "@AGENTS.md\n");
}
