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
const layouts = process.platform === "win32" ? ["windows"] as const : ["windows", "unix"] as const;

async function installation(root: string, layout: "windows" | "unix") {
  const modules = join(root, "node_modules");
  const folder = join(modules, "@openai", "codex");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "cli.js"), "old");
  const binary = join(root, layout === "windows" ? "codex.cmd" : "codex");
  const shims = layout === "windows" ? [binary, join(root, "codex"), join(root, "codex.ps1")] : [binary];
  if (layout === "windows") {
    await Promise.all(shims.map((shim, index) => writeFile(shim, `shim ${index} %~dp0\\node_modules\\@openai\\codex\\cli.js`)));
  } else {
    await symlink(join(folder, "cli.js"), binary);
  }
  return { modules, folder, binary, shims };
}

describe("program updates", () => {
  it("compares stable versions without downgrading or installing a prerelease", () => {
    expect(newer("1.9.0", "1.10.0")).toBe(true);
    expect(newer("2.0.0", "1.10.0")).toBe(false);
    expect(newer("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(newer("1.0.0", "2.0.0-beta.1")).toBe(false);
    expect(newer("unknown", "2.0.0")).toBe(false);
  });

  it.each(layouts)("recognises only the npm package behind the %s executable", async (layout) => {
    const root = await temp();
    const { modules, folder, binary } = await installation(root, layout);
    expect(await npmPackageFor(binary, modules, "@openai/codex")).toBe(folder);
    expect(await npmPackageFor(binary, modules, "@anthropic-ai/claude-code")).toBeUndefined();
  });

  it.each(layouts)("restores the package and all %s shims if npm fails after removing them", async (layout) => {
    const root = await temp();
    const { modules, folder, binary, shims } = await installation(root, layout);
    const contents = await Promise.all(shims.map((shim) => readFile(shim, "utf8")));
    const prober: Prober = { find: () => "npm", capture: async (_path, args) => {
      if (args[0] === "root") return modules;
      if (args[0] === "view") return "2.0.0";
      await rm(folder, { recursive: true });
      await Promise.all(shims.map((shim) => rm(shim)));
      throw new Error("install failed");
    } };
    const update = await systemProgramUpdateSteps(prober).check({ ...report, path: binary });
    await expect(update?.install()).rejects.toThrow("install failed");
    expect(await readFile(join(folder, "cli.js"), "utf8")).toBe("old");
    expect(await Promise.all(shims.map((shim) => readFile(shim, "utf8")))).toEqual(contents);
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
