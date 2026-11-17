import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureEntry, entryFiles, installEntry, maximumTrialStarts, readState, writeState } from "./entry.js";

let home: string;
let mark: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "runner-entry-"));
  mark = join(home, "mark");
  for (const name of ["old", "new"]) {
    writeFileSync(join(home, `${name}.mjs`), `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.MARK, ${JSON.stringify(name)} + " " + process.argv[2]);\n`);
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function start(command: string): string {
  execFileSync(process.execPath, [entryFiles(home).entry, command], { env: { ...process.env, MARK: mark }, stdio: "ignore", windowsHide: true });
  return readFileSync(mark, "utf8");
}

describe("the runner's entry", () => {
  it("starts the version in its state, and goes back to the one before after too many starts that never reached the hub", () => {
    const files = installEntry(home, join(home, "old.mjs"), "1".repeat(40));
    expect(start("run")).toBe("old run");
    writeState(files, { current: join(home, "new.mjs"), currentVersion: "2".repeat(40), previous: join(home, "old.mjs"), previousVersion: "1".repeat(40), trial: 0 });
    for (let count = 1; count <= maximumTrialStarts; count += 1) {
      expect(start("run")).toBe("new run");
      expect(readState(files)?.trial).toBe(count);
    }
    expect(start("status")).toBe("new status");
    expect(readState(files)?.trial).toBe(maximumTrialStarts);
    expect(start("run")).toBe("old run");
    expect(readState(files)).toMatchObject({ current: join(home, "old.mjs"), currentVersion: "1".repeat(40), failed: { version: "2".repeat(40), permanent: true } });
    expect(readState(files)?.trial).toBeUndefined();
    expect(start("run")).toBe("old run");
  });

  it("starts the version it was installed with when its state cannot be read, and keeps a state it finds", () => {
    const files = installEntry(home, join(home, "old.mjs"), undefined);
    writeFileSync(files.state, "{ not json");
    expect(start("run")).toBe("old run");
    writeState(files, { current: join(home, "new.mjs") });
    ensureEntry(home, join(home, "old.mjs"), undefined);
    expect(readState(files)?.current).toBe(join(home, "new.mjs"));
  });
});
