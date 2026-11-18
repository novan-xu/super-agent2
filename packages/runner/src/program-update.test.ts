import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProgramReport } from "@super-agent2/protocol";
import { createProgramUpdater, newer, npmPackageFor, systemProgramUpdateSteps } from "./program-update.js";
import type { Prober } from "./programs.js";

const report: ProgramReport = { id: "codex", installed: true, path: "/bin/codex", version: "1.0.0", models: [], source: "program", problem: null };
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temp() { const path = await mkdtemp(join(tmpdir(), "program-update-test-")); temporary.push(path); return path; }

describe("program updates", () => {
  it("compares stable versions without downgrading or installing a prerelease", () => {
    expect(newer("1.9.0", "1.10.0")).toBe(true);
    expect(newer("2.0.0", "1.10.0")).toBe(false);
    expect(newer("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(newer("1.0.0", "2.0.0-beta.1")).toBe(false);
    expect(newer("unknown", "2.0.0")).toBe(false);
  });

  it("recognises only the npm package behind the resolved executable", async () => {
    const root = await temp();
    const folder = join(root, "node_modules", "@openai", "codex");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "cli.js"), "old");
    const binary = join(root, "codex");
    await symlink(join(folder, "cli.js"), binary);
    expect(await npmPackageFor(binary, join(root, "node_modules"), "@openai/codex")).toBe(folder);
    expect(await npmPackageFor(binary, join(root, "node_modules"), "@anthropic-ai/claude-code")).toBeUndefined();
  });

  it("restores the package and executable if npm fails after removing them", async () => {
    const root = await temp();
    const modules = join(root, "node_modules");
    const folder = join(modules, "@openai", "codex");
    const binary = join(root, "codex");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "cli.js"), "old");
    await symlink(join(folder, "cli.js"), binary);
    const prober: Prober = { find: () => "npm", capture: async (_path, args) => {
      if (args[0] === "root") return modules;
      if (args[0] === "view") return "2.0.0";
      await rm(folder, { recursive: true });
      await rm(binary);
      throw new Error("install failed");
    } };
    const update = await systemProgramUpdateSteps(prober).check({ ...report, path: binary });
    await expect(update?.install()).rejects.toThrow("install failed");
    expect(await readFile(binary, "utf8")).toBe("old");
  });

  it("waits for idle, locks out new work, and publishes a fresh probe after installation", async () => {
    let busy = 1;
    let reports = [report];
    const events: string[] = [];
    const updater = createProgramUpdater({
      busy: () => busy, report: () => reports, publish: (value) => { reports = value; },
      lock: (active) => events.push(`lock ${active}`), log: () => undefined,
      reprobe: async () => { reports = [{ ...report, version: "2.0.0", models: [{ id: "new", efforts: [] }] }]; events.push("probe"); },
      steps: { check: async () => ({ latest: "2.0.0", install: async () => { events.push("install"); } }) },
    });
    updater.check();
    expect(events).toEqual([]);
    busy = 0;
    updater.changed();
    await updater.settled();
    expect(events).toEqual(["lock true", "install", "probe", "lock false"]);
    expect(reports[0]?.models[0]?.id).toBe("new");
  });
});
