import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const guidanceFile = fileURLToPath(new URL("../guidance/AGENTS.md", import.meta.url));

export function prepareWorkspace(workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  copyFileSync(guidanceFile, join(workspace, "AGENTS.md"));
  writeFileSync(join(workspace, "CLAUDE.md"), "@AGENTS.md\n");
}
