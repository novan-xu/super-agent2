import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryFiles, installEntry, readState, writeState } from "./entry.js";
import { createUpdater, defaultRetryMilliseconds, mainIn, readyFile, type Updater, type UpdateSteps, versionFolder } from "./update.js";
import { checkoutOf, revisionFile } from "./version.js";

const running = "1".repeat(40);
const next = "2".repeat(40);
const later = "3".repeat(40);

let home: string;
let oldMain: string;
let busy: number;
let restarts: number;
let now: number;
let lines: string[];
let calls: string[];
let failing: Partial<Record<keyof UpdateSteps, string>>;
let reportedAs: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "runner-update-"));
  oldMain = join(home, "checkout", "packages", "runner", "dist", "main.js");
  installEntry(home, oldMain, running);
  busy = 0;
  restarts = 0;
  now = 1_000_000;
  lines = [];
  calls = [];
  failing = {};
  reportedAs = undefined;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const steps: UpdateSteps = {
  download: async (version, file) => {
    calls.push(`download ${version.slice(0, 1)}`);
    if (failing.download !== undefined) {
      throw new Error(failing.download);
    }
    writeFileSync(file, "archive");
  },
  extract: async (_file, folder) => {
    calls.push("extract");
    mkdirSync(join(folder, "packages", "runner", "dist"), { recursive: true });
  },
  install: async (folder) => {
    calls.push("install");
    if (failing.install !== undefined) {
      throw new Error(failing.install);
    }
    writeFileSync(mainIn(folder), "built");
  },
  check: async (main) => {
    calls.push("check");
    return reportedAs ?? readFileSync(join(checkoutOf(main), revisionFile), "utf8").trim();
  },
};

function updater(supervised = true): Updater {
  return createUpdater({
    home,
    mainPath: oldMain,
    version: running,
    supervised,
    steps,
    busy: () => busy,
    restart: () => {
      restarts += 1;
    },
    log: (line) => lines.push(line),
    now: () => now,
  });
}

describe("a runner moving to the hub's version", () => {
  it("keeps a prepared version through a reconnect until it switches", async () => {
    const update = updater();
    busy = 1;
    update.announced(next);
    await update.settled();
    const folder = versionFolder(join(home, "versions"), next);
    update.confirmed();
    expect(existsSync(mainIn(folder))).toBe(true);
    expect(existsSync(join(folder, readyFile))).toBe(true);
    busy = 0;
    update.changed();
    expect(restarts).toBe(1);
    expect(readState(entryFiles(home))?.current).toBe(mainIn(folder));
  });

  it.each(["folder", "main", "marker"])("prepares again when the ready %s is missing before switching", async (missing) => {
    const update = updater();
    busy = 1;
    update.announced(next);
    await update.settled();
    const folder = versionFolder(join(home, "versions"), next);
    rmSync(missing === "folder" ? folder : missing === "main" ? mainIn(folder) : join(folder, readyFile), { recursive: true, force: true });
    calls.length = 0;
    busy = 0;
    update.changed();
    expect(restarts).toBe(0);
    expect(readState(entryFiles(home))?.current).toBe(oldMain);
    await update.settled();
    expect(calls).toEqual(["download 2", "extract", "install", "check"]);
    expect(restarts).toBe(1);
    expect(existsSync(mainIn(folder))).toBe(true);
    expect(existsSync(join(folder, readyFile))).toBe(true);
  });

  it("prepares the announced version while work runs, and switches to it only once nothing runs", async () => {
    const update = updater();
    busy = 1;
    update.announced(next);
    await update.settled();
    expect(calls).toEqual(["download 2", "extract", "install", "check"]);
    expect(restarts).toBe(0);
    expect(readState(entryFiles(home))?.current).toBe(oldMain);
    expect(lines.at(-1)).toBe("Version 2222222 is ready; the runner switches to it once its 1 running piece(s) of work end");
    update.changed();
    expect(restarts).toBe(0);
    busy = 0;
    update.changed();
    update.changed();
    expect(restarts).toBe(1);
    const target = mainIn(versionFolder(join(home, "versions"), next));
    expect(readState(entryFiles(home))).toEqual({ current: target, currentVersion: next, previous: oldMain, previousVersion: running, trial: 0 });
    expect(readFileSync(join(versionFolder(join(home, "versions"), next), revisionFile), "utf8")).toBe(`${next}\n`);
    expect(readdirSync(join(home, "versions"))).toEqual([next.slice(0, 12)]);
    expect(readFileSync(join(versionFolder(join(home, "versions"), next), readyFile), "utf8").trim()).toBe(next);
  });

  it("does not switch to a version the hub no longer runs, as when a release of the hub went back, and switches once it runs it again", async () => {
    const update = updater();
    busy = 1;
    update.announced(next);
    await update.settled();
    expect(lines.at(-1)).toBe("Version 2222222 is ready; the runner switches to it once its 1 running piece(s) of work end");
    update.announced(running);
    expect(lines.at(-1)).toBe("The hub runs 1111111 again, the version of this runner, so it does not switch to 2222222");
    busy = 0;
    update.changed();
    expect(restarts).toBe(0);
    expect(readState(entryFiles(home))?.current).toBe(oldMain);
    calls.length = 0;
    update.announced(next);
    await update.settled();
    expect(calls).toEqual([]);
    expect(restarts).toBe(1);
    expect(readState(entryFiles(home))?.currentVersion).toBe(next);
  });

  it("does not switch to a version it was still preparing when the hub went back", async () => {
    const update = updater();
    update.announced(next);
    update.announced(running);
    await update.settled();
    expect(calls).toEqual(["download 2", "extract", "install", "check"]);
    update.changed();
    expect(restarts).toBe(0);
  });

  it("leaves its own version, an unknown one and an unsupervised runner alone", async () => {
    updater().announced(running);
    updater().announced(undefined);
    const unsupervised = updater(false);
    unsupervised.announced(next);
    await unsupervised.settled();
    expect(calls).toEqual([]);
    expect(lines).toEqual(["The hub runs 2222222 and this runner is at 1111111; it updates itself only when it was started by its supervisor or launch agent"]);
  });

  it("keeps running its version when a step fails, removes what it half made, and tries again only after a while", async () => {
    failing.install = "pnpm install ended with 1: no network";
    const update = updater();
    update.announced(next);
    await update.settled();
    expect(restarts).toBe(0);
    expect(readdirSync(join(home, "versions"))).toEqual([]);
    expect(readState(entryFiles(home))).toMatchObject({ current: oldMain, failed: { version: next, reason: "pnpm install ended with 1: no network", permanent: false } });
    expect(lines.at(-1)).toBe("The update to 2222222 failed, and this runner goes on at 1111111: pnpm install ended with 1: no network");
    calls.length = 0;
    update.announced(next);
    await update.settled();
    expect(calls).toEqual([]);
    delete failing.install;
    now += defaultRetryMilliseconds;
    update.announced(next);
    await update.settled();
    expect(calls).toEqual(["download 2", "extract", "install", "check"]);
    expect(restarts).toBe(1);
  });

  it("refuses a build whose runner does not say it is the version asked for", async () => {
    reportedAs = later;
    const update = updater();
    update.announced(next);
    await update.settled();
    expect(restarts).toBe(0);
    expect(readState(entryFiles(home))?.failed?.reason).toBe("the new runner says it is 3333333");
    expect(existsSync(versionFolder(join(home, "versions"), next))).toBe(false);
  });

  it("never tries again a version that stopped before it reached the hub", async () => {
    const files = entryFiles(home);
    writeState(files, { current: oldMain, currentVersion: running, failed: { version: next, reason: "It stopped 3 times", at: now, permanent: true } });
    now += 10 * defaultRetryMilliseconds;
    const update = updater();
    update.announced(next);
    await update.settled();
    expect(calls).toEqual([]);
    update.announced(later);
    await update.settled();
    expect(calls[0]).toBe("download 3");
  });

  it("keeps a version once it reached the hub, and only the current and previous versions on disk", () => {
    const files = entryFiles(home);
    for (const version of [next, later, "4".repeat(40)]) {
      mkdirSync(dirname(mainIn(versionFolder(files.versions, version))), { recursive: true });
    }
    writeFileSync(join(files.versions, `${"5".repeat(12)}.tar.gz`), "left over");
    writeState(files, { current: mainIn(versionFolder(files.versions, later)), currentVersion: later, previous: mainIn(versionFolder(files.versions, next)), previousVersion: next, trial: 2 });
    updater().confirmed();
    expect(readState(files)).toEqual({ current: mainIn(versionFolder(files.versions, later)), currentVersion: later, previous: mainIn(versionFolder(files.versions, next)), previousVersion: next });
    expect(readdirSync(files.versions).sort()).toEqual([next.slice(0, 12), later.slice(0, 12)]);
    expect(lines).toEqual(["Version 3333333 reached the hub; it stays"]);
  });
});
