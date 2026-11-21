import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MachineReport, protocolVersion, PushPayload } from "@super-agent2/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Hub } from "./hub.js";
import { createPushDevice, receivePush } from "./push-device.js";
import { generateVapidKeys } from "./push.js";
import type { RunnerLink } from "./runners.js";
import { keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

let directory: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
let tick: () => void;
let bodies: Buffer[];
const keys = generateVapidKeys();

const report: MachineReport = {
  hostname: "pc", platform: "win32", release: "1", arch: "x64", user: "owner", slots: { total: 2, free: 2 }, allowances: [],
  programs: [{ id: "codex", installed: true, path: "codex", version: "1", models: [{ id: "model", efforts: ["high"] }], source: "program", problem: null }],
};

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "health-notices-"));
  clock = new TestClock();
  key = await signingKey("key");
  bodies = [];
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(directory, { recursive: true, force: true });
});

async function start(): Promise<Hub> {
  hub = await startTestHub({
    config: { ...testConfig(directory), vapid: keys }, clock, keySource: staticKeySource(keySet(key)), targets: [], credentials: testCredentials,
    healthTicker: (callback) => { tick = callback; return () => undefined; },
    pushFetch: (_input, init) => { bodies.push(Buffer.from(init?.body as Uint8Array)); return Promise.resolve(new Response(null, { status: 201 })); },
  });
  return hub;
}

function connect(running: Hub, current: MachineReport): RunnerLink {
  const machine = running.machines.active("pc");
  if (machine === undefined) throw new Error("Machine missing");
  const link = running.runners.attach(machine, { send: () => undefined, close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, machine: current, works: [] });
  return link;
}

function notices(running: Hub, scope: "daily" | "code"): string[] {
  return running.conversations.stream(undefined, undefined, { kind: scope }).entries.flatMap(({ entry }) => entry.kind === "notice" && entry.text.includes("问题") ? [entry.text] : []);
}

it("delivers one problem and recovery in both views, one push, and survives a restart", async () => {
  let running = await start();
  running.machines.add({ name: "pc", accessClientId: "pc-client" });
  const device = createPushDevice();
  expect(running.push?.subscribe({ endpoint: "http://127.0.0.1:9/device", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: keys.publicKey }, "http://localhost")).toBe("saved");
  const broken: MachineReport = { ...report, programs: [{ ...report.programs[0]!, version: null, models: [], problem: "version exited 1" }] };
  const link = connect(running, broken);
  link.receive({ type: "report", machine: broken });
  await running.push?.idle();
  expect(notices(running, "daily")).toHaveLength(1);
  expect(notices(running, "code")).toEqual(notices(running, "daily"));
  const topics = running.conversations.list().filter((topic) => topic.system);
  expect(topics).toHaveLength(2);
  expect(topics.find((topic) => topic.needsRepository)?.repository).toBeNull();
  expect(running.conversations.archiveForBrain(topics.find((topic) => topic.needsRepository)!.id, "other")).toContain("system");
  expect(running.database.connection.prepare("SELECT count(*) AS n FROM conversation_entries WHERE kind = 'notice' AND prompt IS NOT NULL").get()?.["n"]).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(PushPayload.parse(JSON.parse(receivePush(device, bodies[0]!))).body).toContain("version exited 1");
  await running.close();
  hub = undefined;
  running = await start();
  const again = connect(running, broken);
  await running.push?.idle();
  expect(notices(running, "daily")).toHaveLength(1);
  expect(bodies).toHaveLength(1);
  again.receive({ type: "report", machine: report });
  expect(notices(running, "daily")).toHaveLength(2);
  expect(notices(running, "code")).toEqual(notices(running, "daily"));
  expect(notices(running, "daily").at(-1)).toContain("恢复");
  expect(bodies).toHaveLength(1);
});

it("excludes limits, delays overload and offline incidents, and recovers once", async () => {
  const running = await start();
  running.machines.add({ name: "pc", accessClientId: "pc-client" });
  const link = connect(running, report);
  running.defaults.markUnavailable("codex", "opaque vendor message", clock.now() + 3600000, "limit");
  expect(notices(running, "daily")).toHaveLength(0);
  running.defaults.markUnavailable("codex", "rate limit exceeded", clock.now() + 3600000);
  expect(notices(running, "daily")).toHaveLength(0);
  running.defaults.markUnavailable("codex", "expired login", clock.now() + 3600000, "problem");
  expect(notices(running, "daily")).toHaveLength(1);
  clock.advance(1);
  running.defaults.recovered("codex", clock.now());
  expect(notices(running, "daily")).toHaveLength(2);
  running.defaults.markUnavailable("codex", "opaque", clock.now() + 3600000, "overload");
  link.closed();
  clock.advance(599999);
  tick();
  expect(notices(running, "daily")).toHaveLength(2);
  clock.advance(1);
  tick();
  tick();
  expect(notices(running, "daily")).toHaveLength(4);
  expect(notices(running, "code")).toEqual(notices(running, "daily"));
  connect(running, report);
  clock.advance(1);
  running.defaults.recovered("codex", clock.now());
  expect(notices(running, "daily")).toHaveLength(6);
});

it("ignores program reports during an update and detects an empty model list afterwards", async () => {
  const running = await start();
  running.machines.add({ name: "pc", accessClientId: "pc-client" });
  const link = connect(running, report);
  const empty: MachineReport = { ...report, updatingPrograms: true, programs: [{ ...report.programs[0]!, models: [] }] };
  link.receive({ type: "report", machine: empty });
  expect(notices(running, "daily")).toHaveLength(0);
  link.receive({ type: "report", machine: { ...empty, updatingPrograms: false, programs: [{ ...report.programs[0]!, models: [], problem: "models: rate limit exceeded" }] } });
  expect(notices(running, "daily")).toHaveLength(0);
  link.receive({ type: "report", machine: { ...empty, updatingPrograms: false } });
  expect(notices(running, "daily")[0]).toContain("no models reported");
});


it("keeps the offline grace period across a hub restart", async () => {
  let running = await start();
  running.machines.add({ name: "pc", accessClientId: "pc-client" });
  const link = connect(running, report);
  link.closed();
  clock.advance(300000);
  await running.close();
  hub = undefined;
  running = await start();
  clock.advance(299999);
  tick();
  expect(notices(running, "daily")).toHaveLength(0);
  clock.advance(1);
  tick();
  expect(notices(running, "daily")).toHaveLength(1);
  connect(running, report);
  expect(notices(running, "daily")).toHaveLength(2);
});

it("starts a fresh grace period after a hub restart when no disconnect was recorded", async () => {
  let running = await start();
  running.machines.add({ name: "pc", accessClientId: "pc-client" });
  connect(running, report);
  clock.advance(3600000);
  await running.close();
  hub = undefined;
  running = await start();
  tick();
  expect(notices(running, "daily")).toHaveLength(0);
  clock.advance(600000);
  tick();
  expect(notices(running, "daily")).toHaveLength(1);
  expect(notices(running, "daily")[0]).toContain("机器 pc 已离线");
});
