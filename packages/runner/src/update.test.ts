import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryFiles, installEntry, readState, writeState } from "./entry.js";
import { createUpdater, defaultRetryMilliseconds, mainIn, type Updater, type UpdateSteps } from "./update.js";
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
    const target = mainIn(join(home, "versions", next));
    expect(readState(entryFiles(home))).toEqual({ current: target, currentVersion: next, previous: oldMain, previousVersion: running, trial: 0 });
    expect(readFileSync(join(home, "versions", next, revisionFile), "utf8")).toBe(`${next}\n`);
    expect(readdirSync(join(home, "versions"))).toEqual([next]);
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
    expect(existsSync(join(home, "versions", next))).toBe(false);
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
      mkdirSync(dirname(mainIn(join(files.versions, version))), { recursive: true });
    }
    mkdirSync(join(files.versions, `${"5".repeat(40)}.part`));
    writeState(files, { current: mainIn(join(files.versions, later)), currentVersion: later, previous: mainIn(join(files.versions, next)), previousVersion: next, trial: 2 });
    updater().confirmed();
    expect(readState(files)).toEqual({ current: mainIn(join(files.versions, later)), currentVersion: later, previous: mainIn(join(files.versions, next)), previousVersion: next });
    expect(readdirSync(files.versions).sort()).toEqual([next, later]);
    expect(lines).toEqual(["Version 3333333 reached the hub; it stays"]);
  });
});
