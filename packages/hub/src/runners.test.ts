import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "@super-agent2/catalog";
import {
  type HubToRunner,
  type MachineReport,
  protocolVersion,
  runnerCloseCodes,
  runnerLinkPath,
  runnerTokenHeader,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { interruptedReason } from "./commands.js";
import type { Hub } from "./hub.js";
import type { RunnerLink } from "./runners.js";
import { assertion, keySet, personClaims, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials, testTokens, waitForState } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;

const clientId = "0123456789abcdef.access";

const report: MachineReport = {
  hostname: "test-pc",
  platform: "win32",
  release: "10.0",
  arch: "x64",
  user: "owner",
  slots: { total: 2, free: 2 },
  programs: [],
  allowances: [],
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-runners-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(withLock = false): Promise<Hub> {
  hub = await startTestHub({
    config: { ...testConfig(dataDir), projectFolders: ["/srv/projects"] },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [fakeTarget("hub")],
    credentials: testCredentials,
    ...(withLock ? {} : { gate: () => ({ kind: "allow" as const }) }),
    machinePollMilliseconds: 10,
  });
  return hub;
}

class FakeRunner {
  readonly sent: HubToRunner[] = [];
  closedWith: { code: number; reason: string } | undefined;
  link: RunnerLink | undefined;
  private readonly waiting = new Set<() => void>();

  connect(running: Hub, name: string): this {
    const machine = running.machines.active(name);
    if (machine === undefined) {
      throw new Error(`no machine ${name}`);
    }
    this.link = running.runners.attach(machine, {
      send: (message) => {
        this.sent.push(message);
        this.wake();
      },
      close: (code, reason) => {
        this.closedWith = { code, reason };
        this.link?.closed();
        this.wake();
      },
    });
    this.link.receive({ type: "hello", protocol: protocolVersion, machine: report });
    return this;
  }

  private wake(): void {
    for (const wake of this.waiting) {
      wake();
    }
  }

  until<T>(find: () => T | undefined): Promise<T> {
    return new Promise((resolve) => {
      const check = () => {
        const found = find();
        if (found !== undefined) {
          this.waiting.delete(check);
          resolve(found);
        }
      };
      this.waiting.add(check);
      check();
    });
  }

  run(): Promise<Extract<HubToRunner, { type: "run" }>> {
    return this.until(() => this.sent.find((message): message is Extract<HubToRunner, { type: "run" }> => message.type === "run"));
  }
}

describe("a runner as a target", () => {
  it("runs a command by the machine's name, streams its output and records its end", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    expect(runner.sent[0]).toEqual({ type: "welcome", protocol: protocolVersion, name: "pc" });
    const record = running.commands.start({ target: "pc", command: "echo hi", cwd: "C:\\work" });
    const run = await runner.run();
    expect(run).toMatchObject({ command: "echo hi", cwd: "C:\\work" });
    expect(run.environment["GH_TOKEN"]).toBe(testTokens["novan-xu"]);
    await waitForState(running.commands, record.id, "running");
    const bytes = Buffer.from("héllo\n", "utf8");
    runner.link?.receive({ type: "output", id: run.id, stream: "stdout", data: bytes.subarray(0, 2).toString("base64") });
    runner.link?.receive({ type: "output", id: run.id, stream: "stdout", data: bytes.subarray(2).toString("base64") });
    runner.link?.receive({ type: "ended", id: run.id, exitCode: 3, signal: null });
    const ended = await running.commands.finished(record.id);
    expect(ended).toMatchObject({ state: "exited", exitCode: 3 });
    expect(running.commands.output(record.id).map((chunk) => chunk.data).join("")).toBe("héllo\n");
    expect(running.runners.statuses()).toEqual([expect.objectContaining({ name: "pc", online: true, report })]);
  });

  it("sends a stop and records the command as stopped", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    const record = running.commands.start({ target: "pc", command: "sleep" });
    const run = await runner.run();
    await waitForState(running.commands, record.id, "running");
    running.commands.stop(record.id);
    await runner.until(() => runner.sent.find((message) => message.type === "stop" && message.id === run.id));
    runner.link?.receive({ type: "ended", id: run.id, exitCode: 1, signal: null });
    expect(await running.commands.finished(record.id)).toMatchObject({ state: "stopped" });
  });

  it("records a command the runner could not start as failed", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    const record = running.commands.start({ target: "pc", command: "x", cwd: "Z:\\missing" });
    const run = await runner.run();
    runner.link?.receive({ type: "failed", id: run.id, reason: "The folder Z:\\missing does not exist on this machine" });
    expect(await running.commands.finished(record.id)).toMatchObject({ state: "failed", reason: "The folder Z:\\missing does not exist on this machine" });
  });

  it("fails a command for a machine that is offline, and one for an unknown or revoked name", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const offline = running.commands.start({ target: "pc", command: "x" });
    expect(await running.commands.finished(offline.id)).toMatchObject({ state: "failed", reason: text("command.reason.offline", { target: "pc" }) });
    running.runners.revoke("pc");
    const revoked = running.commands.start({ target: "pc", command: "x" });
    expect(await running.commands.finished(revoked.id)).toMatchObject({ state: "failed", reason: text("command.reason.noTarget", { target: "pc" }) });
  });

  it("records a running command as interrupted when the connection drops", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    const record = running.commands.start({ target: "pc", command: "sleep" });
    await runner.run();
    await waitForState(running.commands, record.id, "running");
    runner.link?.closed();
    expect(await running.commands.finished(record.id)).toMatchObject({
      state: "interrupted",
      reason: text("command.reason.machineLost", { target: "pc" }),
    });
    expect(running.runners.statuses()[0]?.online).toBe(false);
  });

  it("closes a revoked runner's connection and interrupts its command, also when another process revokes it", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    running.machines.add({ name: "mac", accessClientId: clientId });
    const pc = new FakeRunner().connect(running, "pc");
    const mac = new FakeRunner().connect(running, "mac");
    const record = running.commands.start({ target: "pc", command: "sleep" });
    await pc.run();
    await waitForState(running.commands, record.id, "running");
    running.runners.revoke("pc");
    expect(pc.closedWith).toEqual({ code: runnerCloseCodes.revoked, reason: "revoked" });
    expect(await running.commands.finished(record.id)).toMatchObject({ state: "interrupted" });
    expect(mac.closedWith).toBeUndefined();
    const { openDatabase } = await import("./database.js");
    const { createMachineStore } = await import("./machines.js");
    const other = openDatabase({ dataDir, clock });
    try {
      createMachineStore(other, clock).revoke("mac");
    } finally {
      other.close();
    }
    await mac.until(() => mac.closedWith);
    expect(mac.closedWith).toEqual({ code: runnerCloseCodes.revoked, reason: "revoked" });
  });

  it("replaces an older connection of the same machine", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const first = new FakeRunner().connect(running, "pc");
    const record = running.commands.start({ target: "pc", command: "sleep" });
    await first.run();
    await waitForState(running.commands, record.id, "running");
    const second = new FakeRunner().connect(running, "pc");
    expect(first.closedWith?.code).toBe(runnerCloseCodes.replaced);
    expect(await running.commands.finished(record.id)).toMatchObject({ state: "interrupted" });
    const next = running.commands.start({ target: "pc", command: "echo" });
    const run = await second.run();
    second.link?.receive({ type: "ended", id: run.id, exitCode: 0, signal: null });
    expect(await running.commands.finished(next.id)).toMatchObject({ state: "exited" });
  });

  it("records a runner's command as interrupted by the hub when the hub closes", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    const record = running.commands.start({ target: "pc", command: "sleep" });
    await runner.run();
    await waitForState(running.commands, record.id, "running");
    await running.close();
    hub = undefined;
    expect(runner.closedWith?.code).toBe(runnerCloseCodes.closing);
    const { openDatabase } = await import("./database.js");
    const database = openDatabase({ dataDir, clock });
    try {
      const row = database.connection.prepare("SELECT state, reason FROM commands WHERE id = ?").get(record.id);
      expect(row).toEqual({ state: "interrupted", reason: interruptedReason });
    } finally {
      database.close();
    }
  });

  it("holds a command on the lock's list for a runner as for any other target", async () => {
    const running = await start(true);
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    const record = running.commands.start({ target: "pc", command: "gh repo delete novan-xu/old-experiments --yes" });
    const held = await waitForState(running.commands, record.id, "held");
    expect(held.reason).toContain("gh repo delete");
    expect(runner.sent.filter((message) => message.type === "run")).toEqual([]);
    running.commands.stop(record.id);
    await running.commands.finished(record.id);
    expect(runner.sent.filter((message) => message.type === "run")).toEqual([]);
  });
});

describe("the runner's path at the front door", () => {
  async function connect(running: Hub, path: string, headers: Record<string, string>): Promise<{ opened: boolean; status?: number; socket?: WebSocket }> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}${path}`, { headers });
      socket.on("open", () => resolve({ opened: true, socket }));
      socket.on("unexpected-response", (_request, response) => {
        resolve({ opened: false, status: response.statusCode ?? 0 });
        response.resume();
        socket.terminate();
      });
      socket.on("error", () => undefined);
    });
  }

  it("admits a service token only together with its machine's runner token", async () => {
    const running = await start();
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    const service = await assertion({ key, clock, claims: serviceClaims() });
    const owner = await assertion({ key, clock, claims: personClaims() });
    const other = await assertion({ key, clock, claims: { ...serviceClaims(), common_name: "another.access" } });
    expect(await connect(running, runnerLinkPath, { "cf-access-jwt-assertion": service })).toMatchObject({ opened: false, status: 403 });
    expect(await connect(running, runnerLinkPath, { "cf-access-jwt-assertion": owner, [runnerTokenHeader]: token })).toMatchObject({ opened: false, status: 403 });
    expect(await connect(running, runnerLinkPath, { "cf-access-jwt-assertion": other, [runnerTokenHeader]: token })).toMatchObject({ opened: false, status: 403 });
    expect(await connect(running, runnerLinkPath, { [runnerTokenHeader]: token })).toMatchObject({ opened: false, status: 403 });
    expect(await connect(running, "/runner/other", { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token })).toMatchObject({ opened: false, status: 404 });
    const admitted = await connect(running, runnerLinkPath, { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token });
    expect(admitted.opened).toBe(true);
    const welcome = new Promise<unknown>((resolve) => admitted.socket?.once("message", (data) => resolve(JSON.parse(String(data)))));
    admitted.socket?.send(JSON.stringify({ type: "hello", protocol: protocolVersion, machine: report }));
    expect(await welcome).toEqual({ type: "welcome", protocol: protocolVersion, name: "pc" });
    const closed = new Promise<number>((resolve) => admitted.socket?.once("close", (code) => resolve(code)));
    running.runners.revoke("pc");
    expect(await closed).toBe(runnerCloseCodes.revoked);
    expect(await connect(running, runnerLinkPath, { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token })).toMatchObject({ opened: false, status: 403 });
  });

  it("keeps a service token out of every other path, even with a runner token", async () => {
    const running = await start();
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    const service = await assertion({ key, clock, claims: serviceClaims() });
    const base = `http://127.0.0.1:${running.address.port}`;
    for (const path of ["/api/session", "/api/commands", "/api/machines", "/", runnerLinkPath]) {
      const answer = await fetch(`${base}${path}`, { headers: { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token } });
      expect(answer.status).toBe(403);
    }
    expect(await connect(running, "/ws", { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token })).toMatchObject({ opened: false, status: 403 });
    const owner = await assertion({ key, clock, claims: personClaims() });
    const machines = await fetch(`${base}/api/machines`, { headers: { "cf-access-jwt-assertion": owner } });
    expect(machines.status).toBe(200);
    expect(await machines.json()).toEqual({ machines: [expect.objectContaining({ name: "pc", online: false })] });
  });

  it("closes a runner that sends something it does not understand", async () => {
    const running = await start();
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    const service = await assertion({ key, clock, claims: serviceClaims() });
    const admitted = await connect(running, runnerLinkPath, { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token });
    const closed = new Promise<number>((resolve) => admitted.socket?.once("close", (code) => resolve(code)));
    admitted.socket?.send(JSON.stringify({ type: "hello", protocol: protocolVersion + 1, machine: report }));
    expect(await closed).toBe(1008);
  });
});
