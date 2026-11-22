import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWorkspace } from "./workspace.js";

const source = (file: string) => readFileSync(new URL(`../guidance/${file}`, import.meta.url), "utf8");

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "brain-workspace-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the brain's workspace", () => {
  it("points Claude Code at the same startup guide as Codex and dsh and copies the optional guides beside it", () => {
    const workspace = join(directory, "workspace");
    prepareWorkspace(workspace);
    expect(readdirSync(workspace).sort()).toEqual(["AGENTS.md", "CLAUDE.md", "deployment.md", "tasks.md"]);
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const startup = readFileSync(join(workspace, "AGENTS.md"), "utf8");
    expect(startup).toBe(source("AGENTS.md"));
    for (const file of ["deployment.md", "tasks.md"]) {
      expect(startup).toContain(`Read \`${file}\``);
      expect(startup).not.toContain(`@${file}`);
      expect(readFileSync(join(workspace, file), "utf8")).toBe(source(file));
    }
  });

  it("puts the guidance back when it is prepared again", () => {
    prepareWorkspace(directory);
    writeFileSync(join(directory, "AGENTS.md"), "Old startup guide");
    rmSync(join(directory, "tasks.md"));
    prepareWorkspace(directory);
    expect(readFileSync(join(directory, "AGENTS.md"), "utf8")).toBe(source("AGENTS.md"));
    expect(readFileSync(join(directory, "tasks.md"), "utf8")).toBe(source("tasks.md"));
  });
});
