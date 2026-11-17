import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guidanceFile, prepareWorkspace } from "./workspace.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "brain-workspace-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the brain's workspace", () => {
  it("holds the one guidance file under the name Codex and dsh read, and points the name Claude Code reads at it", () => {
    const workspace = join(directory, "workspace");
    prepareWorkspace(workspace);
    expect(readdirSync(workspace).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe(readFileSync(guidanceFile, "utf8"));
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("puts the guidance back when it is prepared again", () => {
    prepareWorkspace(directory);
    prepareWorkspace(directory);
    expect(readFileSync(join(directory, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });
});
