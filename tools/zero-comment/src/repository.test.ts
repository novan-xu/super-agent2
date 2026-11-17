import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "./fixtures.js";
import { run } from "./report.js";
import { checkRepository, listFiles } from "./repository.js";

let root = "";

function write(path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "zero-comment-"));
  git("init", "--quiet");
  write(".gitignore", "ignored/\n");
  for (const fixture of fixtures) {
    write(`clean/${fixture.file}`, fixture.clean);
    write(`commented/${fixture.file}`, fixture.commented);
  }
  write("ignored/source.ts", "// ignored\n");
  write("notes.txt", "// not a checked language\n");
  write("removed.ts", "export const a = 1;\n");
  git("add", "--all");
  rmSync(join(root, "removed.ts"));
  write("untracked/source.ts", "export const a = 1; // untracked\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listFiles", () => {
  it("lists tracked and untracked files but not ignored ones", () => {
    const files = listFiles(root);
    expect(files).toContain("clean/source.ts");
    expect(files).toContain("untracked/source.ts");
    expect(files).not.toContain("ignored/source.ts");
  });
});

describe("checkRepository", () => {
  it("reports every commented file of every language with its lines", () => {
    const report = checkRepository(root);
    for (const fixture of fixtures) {
      const lines = report.findings
        .filter((finding) => finding.path === `commented/${fixture.file}`)
        .map((finding) => finding.line);
      expect(lines, fixture.name).toEqual(fixture.lines);
    }
  });

  it("passes every clean file", () => {
    const report = checkRepository(root);
    expect(report.findings.filter((finding) => finding.path.startsWith("clean/"))).toEqual([]);
  });

  it("checks untracked files, skips ignored, unknown and removed files", () => {
    const report = checkRepository(root);
    const paths = new Set(report.findings.map((finding) => finding.path));
    expect(paths.has("untracked/source.ts")).toBe(true);
    expect(paths.has("ignored/source.ts")).toBe(false);
    expect(paths.has("notes.txt")).toBe(false);
    expect(report.checked).toBe(fixtures.length * 2 + 1);
  });
});

describe("run", () => {
  it("fails and names each file and line", () => {
    const result = run(root);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain("commented/source.ts:1:14: comment");
    expect(result.lines).toContain("commented/Dockerfile:4:13: comment");
    expect(result.lines).toContain("untracked/source.ts:1:21: comment");
  });

  it("passes a repository without comments", () => {
    const clean = mkdtempSync(join(tmpdir(), "zero-comment-clean-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: clean, stdio: "ignore" });
      writeFileSync(join(clean, "a.ts"), "export const a = 1;\n");
      expect(run(clean)).toEqual({ exitCode: 0, lines: ["No comments in 1 checked file(s)."] });
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
