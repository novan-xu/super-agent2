import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "@super-agent2/catalog";
import {
  type HubToRunner,
  type MachineReport,
  protocolVersion,
  releaseVersionHeader,
  runnerCloseCodes,
  runnerLinkPath,
  runnerReleasePath,
  runnerTokenHeader,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
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
    this.link.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
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

}

describe("a runner's link", () => {
  it("welcomes the machine and reports it online", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    expect(runner.sent[0]).toEqual({ type: "welcome", protocol: protocolVersion, name: "pc" });
    expect(running.runners.statuses()).toEqual([expect.objectContaining({ name: "pc", online: true, report })]);
  });

  it("is no target for a command: a command named after a machine fails, and nothing reaches the runner", async () => {
    const running = await start(true);
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    const record = running.commands.start({ target: "pc", command: "echo hi" });
    expect(await running.commands.finished(record.id)).toMatchObject({ state: "failed", reason: text("command.reason.noTarget", { target: "pc" }) });
    const held = running.commands.start({ target: "pc", command: "gh repo delete novan-xu/old-experiments --yes" });
    await waitForState(running.commands, held.id, "held");
    running.commands.stop(held.id);
    await running.commands.finished(held.id);
    expect(runner.sent.map((message) => message.type)).toEqual(["welcome"]);
  });

  it("closes a revoked runner's connection, also when another process revokes it", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    running.machines.add({ name: "mac", accessClientId: clientId });
    const pc = new FakeRunner().connect(running, "pc");
    const mac = new FakeRunner().connect(running, "mac");
    running.runners.revoke("pc");
    expect(pc.closedWith).toEqual({ code: runnerCloseCodes.revoked, reason: "revoked" });
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
    expect(running.runners.statuses()).toEqual([]);
  });

  it("replaces an older connection of the same machine", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const first = new FakeRunner().connect(running, "pc");
    const second = new FakeRunner().connect(running, "pc");
    expect(first.closedWith?.code).toBe(runnerCloseCodes.replaced);
    expect(second.closedWith).toBeUndefined();
    expect(running.runners.statuses()).toEqual([expect.objectContaining({ name: "pc", online: true })]);
  });

  it("closes the runner's connection as the hub closing when the hub closes", async () => {
    const running = await start();
    running.machines.add({ name: "pc", accessClientId: clientId });
    const runner = new FakeRunner().connect(running, "pc");
    await running.close();
    hub = undefined;
    expect(runner.closedWith?.code).toBe(runnerCloseCodes.closing);
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

  it("announces the hub's version and hands its release only to an admitted runner", async () => {
    const version = "a".repeat(40);
    const asked: { url: string; authorization: string | null }[] = [];
    let answer = 200;
    const forgeFetch: typeof fetch = async (input, init) => {
      asked.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return answer === 200 ? new Response(new Uint8Array([31, 139, 8, 0, 1, 2, 3]), { status: 200 }) : new Response("no", { status: answer });
    };
    hub = await startTestHub({
      config: { ...testConfig(dataDir), version, sourceRepository: "novan-xu/super-agent2" },
      keySource: staticKeySource(keySet(key)),
      clock,
      targets: [fakeTarget("hub")],
      credentials: testCredentials,
      gate: () => ({ kind: "allow" as const }),
      forgeFetch,
    });
    const running = hub;
    const base = `http://127.0.0.1:${running.address.port}`;
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok", version });
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    const service = await assertion({ key, clock, claims: serviceClaims() });
    const owner = await assertion({ key, clock, claims: personClaims() });
    expect((await fetch(`${base}${runnerReleasePath}`, { headers: { "cf-access-jwt-assertion": service } })).status).toBe(403);
    expect((await fetch(`${base}${runnerReleasePath}`, { headers: { "cf-access-jwt-assertion": owner, [runnerTokenHeader]: token } })).status).toBe(403);
    expect(asked).toEqual([]);
    const release = await fetch(`${base}${runnerReleasePath}`, { headers: { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token } });
    expect(release.status).toBe(200);
    expect(release.headers.get(releaseVersionHeader)).toBe(version);
    expect([...new Uint8Array(await release.arrayBuffer())]).toEqual([31, 139, 8, 0, 1, 2, 3]);
    expect(asked).toEqual([{ url: `https://api.github.com/repos/novan-xu/super-agent2/tarball/${version}`, authorization: `Bearer ${testTokens["novan-xu"]}` }]);
    answer = 404;
    expect((await fetch(`${base}${runnerReleasePath}`, { headers: { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token } })).status).toBe(503);

    const admitted = await connect(running, runnerLinkPath, { "cf-access-jwt-assertion": service, [runnerTokenHeader]: token });
    const welcome = new Promise<unknown>((resolve) => admitted.socket?.once("message", (data) => resolve(JSON.parse(String(data)))));
    admitted.socket?.send(JSON.stringify({ type: "hello", protocol: protocolVersion, machine: { ...report, version: "b".repeat(40) } }));
    expect(await welcome).toEqual({ type: "welcome", protocol: protocolVersion, name: "pc", version });
    expect(running.runners.statuses()).toEqual([expect.objectContaining({ name: "pc", online: true, report: expect.objectContaining({ version: "b".repeat(40) }) })]);
    admitted.socket?.close();
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
