import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hubEnvironment, readLocalSettings, stateFolder } from "./settings.js";

let root: string;
let home: string;
let projects: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "local-settings-")));
  home = join(root, "state");
  projects = join(root, "my projects");
  mkdirSync(projects);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("creates the template only on the first start and passes through integration settings", () => {
  expect(readLocalSettings(home, {})).toBeUndefined();
  const file = join(home, "local.env");
  expect(readFileSync(file, "utf8")).toContain("PORT=18180");
  expect(() => readLocalSettings(home, {})).toThrow(/PROJECTS_DIR/);
  writeFileSync(file, `PROJECTS_DIR="${projects}"\nTIME_ZONE=Asia/Shanghai\nACCESS_TEAM=example\n`);
  const loaded = readLocalSettings(home, { HUB_ROUTING_PRIMARY: "bigram" });
  expect(loaded?.projects).toBe(projects);
  expect(hubEnvironment(home, loaded?.env ?? {})).toMatchObject({
    HUB_PORT: "18180", HUB_DATA_DIR: join(home, "hub"), HUB_TICKET_TIME_ZONE: "Asia/Shanghai",
    ACCESS_TEAM: "example", HUB_ROUTING_PRIMARY: "bigram",
  });
});

it("refuses a state folder within projects even when it is reached through a link", () => {
  const alias = join(root, "alias");
  symlinkSync(projects, alias, "junction");
  const unsafe = stateFolder({ SUPERAGENT2_HOME: join(alias, "state") });
  expect(() => readLocalSettings(unsafe, { PROJECTS_DIR: projects })).toThrow(/outside PROJECTS_DIR/);
});
