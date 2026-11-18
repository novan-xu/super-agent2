import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadConfig, parseSettings } from "./config.js";
import { absoluteOn, MachineStorage, ticketArtifacts } from "./storage.js";
import { githubRepository } from "./workplace.js";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "runner-storage-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("accepts rooted macOS paths and fully qualified Windows drive and UNC paths", () => {
  for (const path of ["C:\\01_Projects", "M:/Zdir/Super-agent", "\\\\nas\\share\\Super-agent", "//nas/share"]) {
    expect(absoluteOn("win32", path)).toBe(true);
  }
  for (const path of ["C:Projects", "\\Projects", "/Projects", "\\\\nas", "Projects", "~/Projects"]) {
    expect(absoluteOn("win32", path)).toBe(false);
  }
  expect(absoluteOn("darwin", "/Volumes/NAS/Zdir/Super-agent")).toBe(true);
  for (const path of ["~/Projects", "Projects", "C:\\Projects"]) expect(absoluteOn("darwin", path)).toBe(false);
});

it("reads the local defaults from runner.env and applies valid page overrides before them", async () => {
  const local = join(root, "Local Projects");
  const chosen = join(root, "Other Projects");
  const nas = join(root, "nas");
  for (const path of [local, chosen, nas]) mkdirSync(path);
  const config = loadConfig(parseSettings([
    "SUPERAGENT2_HUB=https://example.test", "MACHINE_NAME=test", "ACCESS_CLIENT_ID=id", "ACCESS_CLIENT_SECRET=secret",
    `RUNNER_TOKEN=${"a".repeat(43)}`, `PROJECTS_DIR="${local}"`, `ARTIFACTS_DIR=${nas}`,
  ].join("\n")));
  if (!config.ok) throw new Error(config.problems.join(", "));
  const storage = new MachineStorage(root, config.config.storage ?? {});
  expect(storage.selection()).toEqual({ projectsDir: local, artifactsDir: nas });
  storage.apply({ projectsDir: chosen });
  expect(storage.selection()).toEqual({ projectsDir: chosen, artifactsDir: nas });
  storage.apply({ projectsDir: "relative", artifactsDir: "relative" });
  expect(await storage.report()).toMatchObject({
    projectsDir: { path: chosen, problem: "not-absolute" },
    artifactsDir: { path: nas, reachable: true, problem: "not-absolute" },
  });
  const restarted = new MachineStorage(root, config.config.storage ?? {});
  restarted.apply({ projectsDir: join(root, "absent") });
  expect((await restarted.report()).projectsDir).toEqual({ path: chosen, problem: "not-found" });
  restarted.apply({});
  expect(restarted.selection()).toEqual({ projectsDir: local, artifactsDir: nas });
  expect(new MachineStorage(root, {}).selection()).toEqual({});
});

it("uses a local ticket folder while the shared path is unavailable and uses the NAS when it returns", async () => {
  const nas = join(root, "nas");
  const storage = new MachineStorage(root, { artifactsDir: nas });
  const local = join(root, "artifacts", "repo", "tickets", "t7");
  expect((await storage.report()).artifactsDir).toEqual({ path: join(root, "artifacts"), reachable: false, problem: "unreachable" });
  expect(await ticketArtifacts(root, storage.selection().artifactsDir, "owner/Repo", 7)).toEqual({ path: local, unavailable: nas });
  expect(existsSync(nas)).toBe(false);
  writeFileSync(join(local, "build.log"), "local");
  mkdirSync(nas);
  expect((await storage.report()).artifactsDir).toMatchObject({ path: nas, reachable: true });
  const shared = join(nas, "repo", "tickets", "t7");
  expect(await ticketArtifacts(root, storage.selection().artifactsDir, "owner/Repo", 7)).toEqual({ path: shared, unavailable: null });
  expect(existsSync(shared)).toBe(true);
  expect(existsSync(join(local, "build.log"))).toBe(true);
});

it("recognizes the same GitHub repository across URL forms", () => {
  for (const url of [
    "https://github.com/Owner/Repo.git", "git@GitHub.com:Owner/Repo", "ssh://git@github.com/owner/repo.git",
    "git://github.com/owner/repo/", "ssh://git@ssh.github.com:443/owner/repo.git", "git@github.com:/owner/repo",
  ]) expect(githubRepository(url)).toBe("owner/repo");
  expect(githubRepository("https://github.com.example/owner/repo")).toBeUndefined();
  expect(githubRepository("file://github.com/owner/repo")).toBeUndefined();
  expect(githubRepository("https://github.com/other/repo")).toBe("other/repo");
});
