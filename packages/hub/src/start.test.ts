import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startFromEnvironment } from "./start.js";
import { audience, keySet, ownerEmail, signingKey, staticKeySource, team, TestClock } from "./testing/access.js";

describe("startFromEnvironment", () => {
  it("refuses to start on an invalid configuration and says which value is wrong", async () => {
    const lines: string[] = [];
    const hub = await startFromEnvironment(
      { ACCESS_TEAM: team, ACCESS_AUD: "wrong", OWNER_EMAIL: ownerEmail, HUB_DATA_DIR: "unused" },
      { report: (line) => lines.push(line) },
    );
    expect(hub).toBeUndefined();
    expect(lines[0]).toMatch(/configuration is invalid/);
    expect(lines.slice(1)).toHaveLength(1);
    expect(lines[1]).toMatch(/^ {2}ACCESS_AUD /);
  });

  it("starts on a valid configuration", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hub-start-"));
    const lines: string[] = [];
    const key = await signingKey("key-1");
    const hub = await startFromEnvironment(
      { ACCESS_TEAM: team, ACCESS_AUD: audience, OWNER_EMAIL: ownerEmail, HUB_DATA_DIR: dataDir, HUB_PORT: "0", HUB_HOST: "127.0.0.1" },
      { report: (line) => lines.push(line), keySource: staticKeySource(keySet(key)), clock: new TestClock() },
    );
    try {
      expect(hub).toBeDefined();
      expect(lines).toEqual([`Hub listening on 127.0.0.1:${hub?.address.port}`]);
    } finally {
      await hub?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
