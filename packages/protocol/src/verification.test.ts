import { describe, expect, it } from "vitest";
import { changeLevel, isDocumentation, TicketVerification } from "./verification.js";

describe("the level of a change", () => {
  it.each(["README.md", "docs/guide.md", "docs/deep/notes.markdown", "CHANGELOG", "LICENSE", "licence.txt", "docs/api.rst", "manual.adoc", "notes/todo.txt", "AUTHORS"])("treats %s as documentation", (path) => {
    expect(isDocumentation(path)).toBe(true);
  });

  it.each(["src/app.ts", "package.json", ".woodpecker/check.yaml", "Dockerfile", "requirements.txt", "requirements-dev.txt", "CMakeLists.txt", "docs/page.mdx", "docs/logo.svg", "Makefile", "docs/", "md"])(
    "treats %s as code",
    (path) => {
      expect(isDocumentation(path)).toBe(false);
    },
  );

  it("is documentation only when every changed file, and every file it was renamed from, is", () => {
    expect(changeLevel([{ path: "README.md" }, { path: "docs/a.md" }])).toBe("documentation");
    expect(changeLevel([{ path: "README.md" }, { path: "src/a.ts" }])).toBe("code");
    expect(changeLevel([{ path: "docs/a.md", previous: "docs/b.md" }])).toBe("documentation");
    expect(changeLevel([{ path: "docs/a.md", previous: "src/a.ts" }])).toBe("code");
    expect(changeLevel([])).toBe("code");
  });

  it("parses a ticket's verification", () => {
    const parsed = TicketVerification.parse({
      head: "abc",
      level: "code",
      rule: "workflows",
      state: "waiting",
      waiting: "pipeline",
      reason: "Woodpecker has no pipeline for the head abc yet",
      pipeline: null,
      workflows: [],
      failures: [],
      mergeCommit: null,
      deployment: null,
      skipReason: null,
      checkedAt: 1,
    });
    expect(parsed.rule).toBe("workflows");
  });
});
