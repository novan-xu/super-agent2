import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { largestMessageBytes } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWritingHandback, outputFolder, travelsInline, writingPaths } from "./writing.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "runner-writing-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const summary = { en: "Wrote it", zh: "写好了" };

function handBack(files: Readonly<Record<string, string>>, handback: unknown) {
  const paths = writingPaths(home, 1);
  mkdirSync(outputFolder(paths), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outputFolder(paths), name), content);
  }
  writeFileSync(paths.handback, JSON.stringify(handback));
  return paths;
}

describe("the text of a writing result", () => {
  it("travels inline when it fits in one message of the link", () => {
    const paths = handBack({ "result.md": "Hello" }, { text: "result.md", summary });
    expect(checkWritingHandback({ paths })).toEqual({ ok: true, text: "Hello", files: [], report: summary });
    expect(travelsInline("x".repeat(100))).toBe(true);
    expect(largestMessageBytes).toBe(64 * 1024 * 1024);
  });

  it("reaches the owner as a file, whole, when it is too long to travel inline", () => {
    const long = "第一段。".repeat(100);
    const paths = handBack({ "result.md": long, "table.csv": "a,b" }, { text: "result.md", files: ["table.csv"], summary });
    expect(checkWritingHandback({ paths, inlineBytes: 64 })).toEqual({
      ok: true,
      text: null,
      files: [
        { name: "result.md", size: Buffer.byteLength(long), mediaType: "text/markdown" },
        { name: "table.csv", size: 3, mediaType: "text/csv" },
      ],
      report: summary,
    });
  });
});
