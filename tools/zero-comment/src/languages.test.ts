import { describe, expect, it } from "vitest";
import { fixtures } from "./fixtures.js";
import { languageOf } from "./languages.js";
import { checkText } from "./repository.js";

describe.each(fixtures)("$name", (fixture) => {
  it("is recognised by its file name", () => {
    expect(languageOf(fixture.file)).toBeDefined();
  });

  it("passes a file without comments", () => {
    expect(checkText(fixture.file, fixture.clean)).toEqual([]);
  });

  it("reports every comment by line", () => {
    const findings = checkText(fixture.file, fixture.commented);
    expect(findings.map((finding) => finding.line)).toEqual(fixture.lines);
    expect(findings.every((finding) => finding.message === "comment")).toBe(true);
  });

  it("reports the same lines with Windows line endings", () => {
    const findings = checkText(fixture.file, fixture.commented.replaceAll("\n", "\r\n"));
    expect(findings.map((finding) => finding.line)).toEqual(fixture.lines);
  });
});

describe("languageOf", () => {
  it.each([
    ["a/b.ts", "typescript"],
    ["a/b.mts", "typescript"],
    ["a/b.d.ts", "declaration"],
    ["a/b.tsx", "tsx"],
    ["a/b.jsx", "javascript"],
    ["a/b.yml", "yaml"],
    ["a/b.htm", "html"],
    ["a/b.bash", "shell"],
    ["a/b.psm1", "powershell"],
    ["a/b.psd1", "powershell"],
    ["a/b.jsonc", "json"],
    ["deploy/Dockerfile.hub", "dockerfile"],
    ["deploy/hub.Dockerfile", "dockerfile"],
    ["Containerfile", "dockerfile"],
    ["README.markdown", "markdown"],
  ])("maps %s to %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  it.each(["a/b.txt", "LICENSE", ".gitignore", "a/b.png"])("leaves %s unchecked", (path) => {
    expect(languageOf(path)).toBeUndefined();
  });
});

describe("checkText", () => {
  it("reports the column of a comment", () => {
    expect(checkText("a.ts", "const a = 1; // x\n")).toEqual([{ line: 1, column: 14, message: "comment" }]);
  });

  it("reports the column of a comment embedded in HTML", () => {
    expect(checkText("a.html", "<script>let a; /* x */</script>\n")).toEqual([
      { line: 1, column: 16, message: "comment" },
    ]);
  });

  it("ignores a byte order mark", () => {
    expect(checkText("a.ts", "﻿const a = 1;\n")).toEqual([]);
    expect(checkText("a.ts", "﻿// x\n")).toEqual([{ line: 1, column: 1, message: "comment" }]);
  });

  it("fails a shell file that cannot be parsed", () => {
    const [finding] = checkText("a.sh", 'echo "unterminated\n');
    expect(finding?.message).toMatch(/^cannot be parsed/);
  });

  it("fails a script that cannot be parsed", () => {
    const [finding] = checkText("a.ts", "const = ;\n");
    expect(finding?.message).toMatch(/^cannot be parsed/);
  });
});
