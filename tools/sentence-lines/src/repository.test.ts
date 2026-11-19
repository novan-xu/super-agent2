import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkRepository } from "./repository.js";

it("checks tracked and untracked Markdown, skipping ignored and deleted files", () => {
  const root = mkdtempSync(join(tmpdir(), "sentence-lines-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "ignored.md\n");
    writeFileSync(join(root, "tracked.md"), "First. Second.\n");
    writeFileSync(join(root, "deleted.md"), "First. Second.\n");
    execFileSync("git", ["add", "."], { cwd: root });
    rmSync(join(root, "deleted.md"));
    writeFileSync(join(root, "new.markdown"), "A wrapped\nsentence.\n");
    writeFileSync(join(root, "ignored.md"), "First. Second.\n");
    writeFileSync(join(root, "other.txt"), "First. Second.\n");
    expect(checkRepository(root)).toEqual({ checked: 2, lines: [
      "new.markdown:1: sentence wraps onto the next line",
      "tracked.md:1: multiple sentences on one line",
    ] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
