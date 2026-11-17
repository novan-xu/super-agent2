import { describe, expect, it } from "vitest";
import { clean, flagged } from "./fixtures.js";
import { checkText } from "./repository.js";

const path = (file: string): string => `packages/web/src/${file}`;

describe("checkText", () => {
  it.each(flagged)("reports $name at its lines", (fixture) => {
    const lines = checkText(path(fixture.file), fixture.source).map((finding) => finding.line);
    expect(lines).toEqual(fixture.lines);
  });

  it.each(clean)("reports nothing for $name", (fixture) => {
    expect(checkText(path(fixture.file), fixture.source)).toEqual([]);
  });

  it("names the literal text and its column", () => {
    const [finding] = checkText(path("a.tsx"), "export const a = <p>Save</p>;\n");
    expect(finding).toEqual({ line: 1, column: 21, message: 'literal text "Save"' });
  });

  it("shortens a long literal in its message", () => {
    const [finding] = checkText(path("a.tsx"), `export const a = <p>${"word ".repeat(30)}</p>;\n`);
    expect(finding?.message.length).toBeLessThan(80);
    expect(finding?.message.endsWith('…"')).toBe(true);
  });

  it("fails a page that cannot be parsed", () => {
    const findings = checkText(path("broken.tsx"), "export const a = <p>\n  {x\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/^cannot be parsed: /);
  });

  it("does not read test files, other packages or other languages", () => {
    const source = "export const a = <p>Hello</p>;\n";
    expect(checkText("packages/web/src/App.test.tsx", source)).toEqual([]);
    expect(checkText("packages/hub/src/view.tsx", source)).toEqual([]);
    expect(checkText("packages/web/src/view.ts", "export const a = 'Hello';\n")).toEqual([]);
    expect(checkText("packages/web/node_modules/x/view.tsx", source)).toEqual([]);
  });

  it("reads the same on Windows paths and with a byte order mark", () => {
    const slash = String.fromCharCode(92);
    const windows = ["packages", "web", "src", "a.tsx"].join(slash);
    expect(checkText(windows, "\uFEFFexport const a = <p>Hello</p>;\n")).toHaveLength(1);
  });
});
