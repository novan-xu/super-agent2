import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineStatus } from "@super-agent2/protocol";
import { expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { createStartDefaults } from "./defaults.js";
import { createModelDiscovery } from "./model-discovery.js";
import { TestClock } from "./testing/access.js";

function machine(name: string, models: { id: string; efforts: string[] }[]): MachineStatus {
  return MachineStatus.parse({ name, online: true, createdAt: 0, lastSeenAt: 0, report: { hostname: name, platform: "darwin", release: "", arch: "", user: "", slots: { total: 1, free: 1 }, programs: [{ id: "codex", installed: true, path: null, version: null, models, source: "program", problem: null }] } });
}

it("baselines, batches new IDs per engine, and remembers them across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "models-"));
  const clock = new TestClock();
  const db = openDatabase({ dataDir: dir, clock });
  try {
    const told: string[] = [];
    const defaults = createStartDefaults({ database: db, clock, statuses: () => [] });
    const discovery = () => createModelDiscovery(db, defaults, (_notice, prompt) => told.push(prompt));
    const old = { id: "old", efforts: ["high"] };
    discovery().scan([machine("pc", [old]), machine("mac", [{ id: "other", efforts: ["low"] }])]);
    expect(told).toEqual([]);
    const next = [machine("pc", [{ ...old, efforts: ["low"] }, { id: "new", efforts: ["high"] }, { id: "newer", efforts: ["max"] }]), machine("mac", [{ id: "other", efforts: ["low"] }, { id: "new", efforts: ["low"] }])];
    discovery().scan(next);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("new: pc (efforts: high); mac (efforts: low)");
    expect(told[0]).toContain("newer: pc (efforts: max)");
    expect(told[0]).toContain("Current start-defaults row");
    discovery().scan(next);
    discovery().scan([machine("pc", [old])]);
    discovery().scan(next);
    expect(told).toHaveLength(1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
