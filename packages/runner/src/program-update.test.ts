import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { machineChoices, type MachineStatus, type ProgramReport } from "@super-agent2/protocol";
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

  it("keeps models available for an unrecognised channel and clears the note when recognised", async () => {
    let reports: ProgramReport[] = [{ ...report, id: "dsh", models: [{ id: "deepseek-flash", efforts: ["high"] }] }];
    let recognised = false;
    const updater = createProgramUpdater({
      busy: () => 0, report: () => reports, publish: (value) => { reports = value; },
      lock: () => undefined, log: () => undefined, reprobe: async () => undefined,
      steps: { check: async () => recognised ? { latest: "1.0.0", install: async () => undefined } : undefined },
    });
    updater.check();
    await updater.settled();
    expect(reports[0]).toMatchObject({ problem: null, update: { channel: null, note: expect.stringContaining("Unrecognised") } });
    const status: MachineStatus = { name: "mini", online: true, createdAt: 1, lastSeenAt: 1, report: {
      hostname: "mini", platform: "darwin", release: "1", arch: "arm64", user: "owner", slots: { total: 1, free: 1 }, programs: reports, allowances: [],
    } };
    expect(machineChoices([status])[0]?.engines[0]?.models).toEqual(reports[0]?.models);
    reports[0]!.problem = "probe failed";
    expect(machineChoices([status])[0]?.engines[0]?.models).toEqual([]);
    recognised = true;
    updater.check();
    await updater.settled();
    expect(reports[0]?.update).toEqual({ channel: "npm", note: null });
    expect(reports[0]?.problem).toBe("probe failed");
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

import { selfUpdateFor } from "./program-update-self.js";

describe("vendor self-updates", () => {
  it("recognises Claude's native layout and restores its launcher on failure", async () => {
    const home = await temp();
    const bin = join(home, ".local", "bin");
    const versions = join(home, ".local", "share", "claude", "versions");
    await mkdir(bin, { recursive: true });
    await mkdir(versions, { recursive: true });
    const executable = join(bin, "claude.exe");
    await writeFile(executable, "old");
    const calls: string[][] = [];
    const prober: Prober = { find: () => undefined, capture: async (_path, args) => {
      calls.push([...args]);
      await writeFile(executable, "broken");
      throw new Error("failed");
    } };
    const update = await selfUpdateFor({ ...report, id: "claude", path: executable }, prober, home);
    expect(update?.channel).toBe("Claude Code native");
    await expect(update?.install()).rejects.toThrow("failed");
    expect(await readFile(executable, "utf8")).toBe("old");
    expect(calls).toEqual([["install", "stable"]]);
    await rm(versions, { recursive: true });
    expect(await selfUpdateFor({ ...report, id: "claude", path: executable }, prober, home)).toBeUndefined();
  });

  it("runs Antigravity's updater and rejects a downgrade or prerelease", async () => {
    const home = await temp();
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "agy");
    await writeFile(executable, "old");
    let version = "2.0.0";
    const prober: Prober = { find: () => undefined, capture: async (_path, args) => {
      if (args[0] === "update") { await writeFile(executable, "new"); return ""; }
      return version;
    } };
    const update = await selfUpdateFor({ ...report, id: "antigravity", path: executable }, prober, home);
    expect(update?.channel).toBe("Antigravity CLI");
    await update?.install();
    expect(await readFile(executable, "utf8")).toBe("new");
    await writeFile(executable, "old");
    version = "2.0.0-beta.1";
    await expect(update?.install()).rejects.toThrow("prerelease");
    expect(await readFile(executable, "utf8")).toBe("old");
    expect(await selfUpdateFor({ ...report, id: "antigravity", path: join(home, "other") }, prober, home)).toBeUndefined();
  });

  it("uses the npm prefix containing the resolved package", async () => {
    if (process.platform === "win32") return;
    const prefix = await temp();
    const modules = join(prefix, "lib", "node_modules");
    const folder = join(modules, "@openai", "codex");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "cli.js"), "old");
    const bin = join(prefix, "bin");
    await mkdir(bin);
    const executable = join(bin, "codex");
    await symlink(join(folder, "cli.js"), executable);
    const calls: string[][] = [];
    const prober: Prober = { find: () => "npm", capture: async (_path, args) => {
      calls.push([...args]);
      return args[0] === "root" ? join(prefix, "elsewhere", "node_modules") : "2.0.0";
    } };
    const update = await systemProgramUpdateSteps(prober).check({ ...report, path: executable });
    await update?.install();
    expect(calls.at(-1)).toEqual(["install", "--global", "--prefix", await realpath(prefix), "@openai/codex@2.0.0"]);
  });
});

it("passes npm prefix paths containing spaces as one argument", async () => {
  const { systemProber } = await import("./programs.js");
  const cwd = await temp();
  const prober = systemProber({ cwd, environment: process.env });
  expect((await prober.capture(process.execPath, ["-p", "process.argv[1]", "prefix with spaces"])).trim()).toBe("prefix with spaces");
});
