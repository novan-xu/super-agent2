import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, flagged } from "./fixtures.js";
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
  root = mkdtempSync(join(tmpdir(), "markup-text-"));
  git("init", "--quiet");
  write(".gitignore", "packages/web/ignored/\n");
  for (const fixture of flagged) {
    write(`packages/web/flagged/${fixture.file}`, fixture.source);
  }
  for (const fixture of clean) {
    write(`packages/web/clean/${fixture.file}`, fixture.source);
  }
  write("packages/web/ignored/view.tsx", "export const a = <p>Hello</p>;\n");
  write("packages/web/src/view.test.tsx", "export const a = <p>Hello</p>;\n");
  write("packages/hub/view.tsx", "export const a = <p>Hello</p>;\n");
  write("packages/web/removed.tsx", "export const a = <p>{text('a')}</p>;\n");
  git("add", "--all");
  rmSync(join(root, "packages/web/removed.tsx"));
  write("packages/web/untracked/view.tsx", "export const a = <p>Hello</p>;\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listFiles", () => {
  it("lists tracked and untracked files but not ignored ones", () => {
    const files = listFiles(root);
    expect(files).toContain("packages/web/clean/catalog.tsx");
    expect(files).toContain("packages/web/untracked/view.tsx");
    expect(files).not.toContain("packages/web/ignored/view.tsx");
  });
});

describe("checkRepository", () => {
  it("reports every flagged page with its lines and no clean page", () => {
    const report = checkRepository(root);
    for (const fixture of flagged) {
      const lines = report.findings.filter((finding) => finding.path === `packages/web/flagged/${fixture.file}`).map((finding) => finding.line);
      expect(lines, fixture.name).toEqual(fixture.lines);
    }
    expect(report.findings.filter((finding) => finding.path.startsWith("packages/web/clean/"))).toEqual([]);
  });

  it("reads new files that are not ignored, and nothing else outside the page", () => {
    const paths = new Set(checkRepository(root).findings.map((finding) => finding.path));
    expect(paths).toContain("packages/web/untracked/view.tsx");
    expect(paths).not.toContain("packages/web/ignored/view.tsx");
    expect(paths).not.toContain("packages/web/src/view.test.tsx");
    expect(paths).not.toContain("packages/hub/view.tsx");
  });
});

describe("run", () => {
  it("fails and names the file and the line", () => {
    const result = run(root);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain('packages/web/flagged/between.tsx:4:13: literal text "Save the draft"');
    expect(result.lines.at(-1)).toMatch(/every label comes from the catalog/);
  });
});

describe("run on a clean page", () => {
  it("passes", () => {
    const folder = mkdtempSync(join(tmpdir(), "markup-text-clean-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: folder, stdio: "ignore" });
      mkdirSync(join(folder, "packages/web/src"), { recursive: true });
      writeFileSync(join(folder, "packages/web/src/App.tsx"), "export const App = () => <main>{text('app.name')}</main>;\n");
      const result = run(folder);
      expect(result.exitCode).toBe(0);
      expect(result.lines).toEqual(["No literal text in the markup of 1 checked page file(s)."]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
