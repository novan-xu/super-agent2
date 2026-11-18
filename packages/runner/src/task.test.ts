import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { largestMessageBytes } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTaskHandback, deploymentProblem, outputFolder, readDeploymentAt, travelsInline, taskPaths } from "./task.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "runner-task-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const summary = { en: "Wrote it", zh: "写好了" };

function handBack(files: Readonly<Record<string, string>>, handback: unknown) {
  const paths = taskPaths(home, 1);
  mkdirSync(outputFolder(paths), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outputFolder(paths), name), content);
  }
  writeFileSync(paths.handback, JSON.stringify(handback));
  return paths;
}

describe("the text of a task result", () => {
  it("travels inline when it fits in one message of the link", () => {
    const paths = handBack({ "result.md": "Hello" }, { text: "result.md", summary });
    expect(checkTaskHandback({ paths })).toEqual({ ok: true, outcome: "done", text: "Hello", files: [], report: summary });
    expect(travelsInline("x".repeat(100))).toBe(true);
    expect(largestMessageBytes).toBe(64 * 1024 * 1024);
  });

  it("reaches the owner as a file, whole, when it is too long to travel inline", () => {
    const long = "第一段。".repeat(100);
    const paths = handBack({ "result.md": long, "table.csv": "a,b" }, { text: "result.md", files: ["table.csv"], summary });
    expect(checkTaskHandback({ paths, inlineBytes: 64 })).toEqual({
      ok: true,
      outcome: "done",
      text: null,
      files: [
        { name: "result.md", size: Buffer.byteLength(long), mediaType: "text/markdown" },
        { name: "table.csv", size: 3, mediaType: "text/csv" },
      ],
      report: summary,
    });
  });
});

describe("a task's hand-back", () => {
  it("may be a report alone, done or failed", () => {
    const report = { en: "Deployed", zh: "部署好了" };
    expect(checkTaskHandback({ paths: handBack({}, { outcome: "done", report }) })).toEqual({ ok: true, outcome: "done", text: null, files: [], report });
    expect(checkTaskHandback({ paths: handBack({}, { outcome: "failed", report }) })).toMatchObject({ ok: true, outcome: "failed" });
  });

  it("asks again for an outcome it does not know, or a report without its Chinese copy", () => {
    const wrong = checkTaskHandback({ paths: handBack({}, { outcome: "partly", report: { en: "x", zh: "好" } }) });
    expect(wrong.ok ? "" : wrong.problem).toContain('"outcome" ("done" or "failed")');
    expect(checkTaskHandback({ paths: handBack({}, { outcome: "done", report: { en: "x", zh: "x" } }) }).ok).toBe(false);
  });
});

describe("a deployment's recipe in the checkout", () => {
  const recipe = { target: "pc", deploy: "./deploy.sh", health: { command: "./health.sh" }, rollback: "./rollback.sh" };

  function checkout(file: unknown): string {
    const folder = join(home, "checkout");
    mkdirSync(join(folder, ".superagent2"), { recursive: true });
    if (file !== undefined) {
      writeFileSync(join(folder, ".superagent2", "deployment.json"), typeof file === "string" ? file : JSON.stringify(file));
    }
    return folder;
  }

  it("is followed only on the machine it names", () => {
    expect(deploymentProblem(readDeploymentAt(checkout(recipe)), "pc", "abc1234")).toBeUndefined();
    expect(deploymentProblem(readDeploymentAt(checkout(recipe)), "mini", "abc1234")).toContain("names the machine pc, and this machine is mini");
  });

  it("is refused when it is missing or not valid", () => {
    expect(deploymentProblem(readDeploymentAt(checkout(undefined)), "pc", "abc1234")).toContain("There is no .superagent2/deployment.json at abc1234");
    expect(deploymentProblem(readDeploymentAt(checkout({ ...recipe, target: "nas" })), "pc", "abc1234")).toContain("not a valid deployment file");
  });
});
