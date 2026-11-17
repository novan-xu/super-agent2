import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceFile } from "./replace-file.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runner-replace-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function failing(code: string): (from: string, to: string) => void {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
}

describe("replacing a file", () => {
  it("renames the new content over the old", () => {
    const target = join(directory, "a.json");
    writeFileSync(target, "old");
    writeFileSync(`${target}.new`, "new");
    replaceFile(`${target}.new`, target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(`${target}.new`)).toBe(false);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("writes the content into the file when Windows refuses the rename with %s", (code) => {
    const target = join(directory, "a.json");
    writeFileSync(target, "old");
    writeFileSync(`${target}.new`, "new");
    replaceFile(`${target}.new`, target, "new", failing(code));
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(`${target}.new`)).toBe(false);
  });

  it("does not hide any other failure", () => {
    const target = join(directory, "a.json");
    writeFileSync(`${target}.new`, "new");
    expect(() => replaceFile(`${target}.new`, target, "new", failing("ENOSPC"))).toThrow("ENOSPC");
    expect(existsSync(target)).toBe(false);
  });
});
