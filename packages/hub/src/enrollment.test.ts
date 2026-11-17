import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeRunnerSetup,
  enrollPath,
  type HubToBrain,
  installCodeHeader,
  installCodeLifetime,
  MachineAdded,
  MachineRevoked,
  protocolVersion,
  SettingsSnapshot,
  startingEngineTable,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessServiceTokens } from "./cloudflare.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { createInstallCodes, installCodeHash, installCommand, macosScript, windowsScript } from "./enrollment.js";
import type { Hub } from "./hub.js";
import { assertion, keySet, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
let database: HubDatabase | undefined;

const version = "0123456789abcdef0123456789abcdef01234567";

interface FakeTokens extends AccessServiceTokens {
  readonly created: string[];
  readonly removed: string[];
  failRemove: boolean;
  failCreate: boolean;
}

function fakeTokens(): FakeTokens {
  const tokens: FakeTokens = {
    created: [],
    removed: [],
    failRemove: false,
    failCreate: false,
    create: async (name) => {
      if (tokens.failCreate) {
        throw new Error("Cloudflare is down");
      }
      tokens.created.push(name);
      return { id: `token-${tokens.created.length}`, clientId: `client${tokens.created.length}.access`, clientSecret: `secret${tokens.created.length}abcdef` };
    },
    remove: async (id) => {
      if (tokens.failRemove) {
        throw new Error("Cloudflare is down");
      }
      tokens.removed.push(id);
    },
  };
  return tokens;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-enrollment-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  database?.close();
  database = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("install codes", () => {
  it("keep only the code's hash, and are used once, before they expire", () => {
    database = openDatabase({ dataDir, clock });
    const codes = createInstallCodes(database, clock);
    const issued = codes.issue({ name: "pc", system: "windows", hub: "https://agent.example.com" });
    expect(issued.expiresAt).toBe(clock.now() + installCodeLifetime);
    expect(readFileSync(join(dataDir, "hub.sqlite")).includes(Buffer.from(issued.code))).toBe(false);
    expect(database.connection.prepare("SELECT code_hash FROM install_codes").get()).toEqual({ code_hash: installCodeHash(issued.code) });
    expect(codes.pending()).toEqual([{ name: "pc", system: "windows", expiresAt: issued.expiresAt }]);
    expect(codes.claim(issued.code)).toEqual({ name: "pc", system: "windows", hub: "https://agent.example.com" });
    expect(codes.claim(issued.code)).toBeUndefined();
    codes.release(issued.code);
    expect(codes.claim(issued.code)).toBeDefined();
    codes.finish(issued.code);
    codes.release(issued.code);
    expect(codes.claim(issued.code)).toBeUndefined();
    const late = codes.issue({ name: "mini", system: "macos", hub: "https://agent.example.com" });
    clock.advance(installCodeLifetime);
    expect(codes.claim(late.code)).toBeUndefined();
    expect(codes.pending()).toEqual([]);
    expect(codes.claim("not a code")).toBeUndefined();
  });

  it("replace an earlier code for the same name", () => {
    database = openDatabase({ dataDir, clock });
    const codes = createInstallCodes(database, clock);
    const first = codes.issue({ name: "pc", system: "windows", hub: "https://a.example.com" });
    const second = codes.issue({ name: "pc", system: "macos", hub: "https://a.example.com" });
    expect(codes.claim(first.code)).toBeUndefined();
    expect(codes.claim(second.code)?.system).toBe("macos");
  });
});

describe("the install line and script", () => {
  const code = "A".repeat(43);

  it("carries the code and the hub's address and nothing else", () => {
    expect(installCommand("windows", "https://agent.example.com", code)).toBe(
      `powershell -NoProfile -Command "irm -Method Post -MaximumRedirection 0 -Headers @{'${installCodeHeader}'='${code}'} -Uri 'https://agent.example.com${enrollPath}' | iex"`,
    );
    expect(installCommand("macos", "https://agent.example.com", code)).toBe(`/bin/sh -c "$(curl -fsS -X POST -H '${installCodeHeader}: ${code}' 'https://agent.example.com${enrollPath}')"`);
  });

  const values = { hub: "https://agent.example.com", version, setup: "superagent2-runner-setup:abc_DEF-1", clientId: "c1.access", clientSecret: "s3cret", runnerToken: "t0ken_-" };

  it("fetches the hub's release with the new credentials, saves the settings through the runner's setup and installs it", () => {
    for (const script of [macosScript(values), windowsScript(values)]) {
      expect(script).toContain("https://agent.example.com/runner/release");
      expect(script).toContain(values.setup);
      expect(script).toContain("cf-access-client-secret");
      expect(script).toContain("x-runner-token");
      expect(script).toContain("setup");
      expect(script).toContain("install");
      expect(script).toContain("SUPERAGENT2_RUNNER_FOREGROUND");
      expect(script).toContain("0123456789ab");
    }
  });

  it("refuses a value it could not quote safely", () => {
    expect(() => macosScript({ ...values, clientSecret: "a'b" })).toThrow();
    expect(() => windowsScript({ ...values, runnerToken: "a b" })).toThrow();
  });
});

async function start(options: { tokens?: AccessServiceTokens; release?: boolean } = {}): Promise<Hub> {
  hub = await startTestHub({
    config: { ...testConfig(dataDir), ...(options.release === false ? {} : { version, sourceRepository: "novan-xu/super-agent2" }) },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [fakeTarget("hub")],
    credentials: testCredentials,
    gate: () => ({ kind: "allow" as const }),
    machinePollMilliseconds: 10,
    report: () => undefined,
    ...(options.tokens === undefined ? {} : { serviceTokens: options.tokens }),
  });
  return hub;
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function owner(running: Hub, path: string, method: "POST" | "PUT", body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    method,
    headers: { origin: base(running), "content-type": "application/json", "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), ...headers },
    body: JSON.stringify(body),
  });
}

async function add(running: Hub, name: string, system: "windows" | "macos" = "windows"): Promise<{ added: MachineAdded; code: string }> {
  const response = await owner(running, "/api/machines", "POST", { name, system });
  expect(response.status).toBe(201);
  const added = MachineAdded.parse(await response.json());
  const code = /'([A-Za-z0-9_-]{43})'/.exec(added.command)?.[1] ?? /: ([A-Za-z0-9_-]{43})'/.exec(added.command)?.[1] ?? "";
  return { added, code };
}

function redeem(running: Hub, code: string): Promise<Response> {
  return fetch(`${base(running)}${enrollPath}`, { method: "POST", headers: { [installCodeHeader]: code } });
}

describe("adding a machine from the page", () => {
  it("gives a line whose code a machine without credentials redeems once for its runner token and service token", async () => {
    const tokens = fakeTokens();
    const running = await start({ tokens });
    const { added, code } = await add(running, "studio");
    expect(added.command).toContain(`${base(running)}${enrollPath}`);
    expect(added.expiresAt).toBe(clock.now() + installCodeLifetime);
    expect(running.settings.snapshot().enrollments).toEqual([{ name: "studio", system: "windows", expiresAt: added.expiresAt }]);
    expect(tokens.created).toEqual([]);
    const script = await redeem(running, code);
    expect(script.status).toBe(200);
    expect(script.headers.get("cache-control")).toBe("no-store");
    const text = await script.text();
    const line = /'(superagent2-runner-setup:[^']+)'/.exec(text)?.[1] ?? "";
    const setup = decodeRunnerSetup(line);
    expect(setup).toMatchObject({ hub: base(running), name: "studio", accessClientId: "client1.access", accessClientSecret: "secret1abcdef" });
    expect(tokens.created).toEqual(["superagent2-runner-studio"]);
    const machine = running.machines.byToken(setup?.runnerToken ?? "");
    expect(machine).toMatchObject({ name: "studio", accessClientId: "client1.access", accessTokenId: "token-1" });
    expect(running.runners.admit({ kind: "service", clientId: "client1.access" }, setup?.runnerToken)).toBeDefined();
    expect((await redeem(running, code)).status).toBe(403);
    expect(running.settings.snapshot().enrollments).toEqual([]);
  });

  it("refuses an expired code, an unknown one and one sent another way", async () => {
    const running = await start({ tokens: fakeTokens() });
    const { code } = await add(running, "studio", "macos");
    expect((await redeem(running, "B".repeat(43))).status).toBe(403);
    expect((await fetch(`${base(running)}${enrollPath}`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base(running)}${enrollPath}?code=${code}`, { method: "GET" })).status).toBe(404);
    expect((await fetch(`${base(running)}${enrollPath}/x`, { method: "POST", headers: { [installCodeHeader]: code } })).status).toBe(403);
    clock.advance(installCodeLifetime);
    expect((await redeem(running, code)).status).toBe(403);
  });

  it("keeps the code when Cloudflare fails, so the line can be run again", async () => {
    const tokens = fakeTokens();
    tokens.failCreate = true;
    const running = await start({ tokens });
    const { code } = await add(running, "studio");
    expect((await redeem(running, code)).status).toBe(503);
    expect(running.machines.active("studio")).toBeUndefined();
    tokens.failCreate = false;
    expect((await redeem(running, code)).status).toBe(200);
  });

  it("says plainly that Cloudflare or the release is missing, and adds nothing", async () => {
    const running = await start();
    const response = await owner(running, "/api/machines", "POST", { name: "studio", system: "windows" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "cloudflare" });
    expect(running.settings.snapshot().canAdd).toEqual({ cloudflare: false, release: true });
    expect(running.settings.snapshot().enrollments).toEqual([]);
    await running.close();
    hub = undefined;
    const second = await start({ tokens: fakeTokens(), release: false });
    expect(await (await owner(second, "/api/machines", "POST", { name: "studio", system: "windows" })).json()).toEqual({ error: "release" });
  });

  it("is the owner's action from the page's own origin, as JSON, for a valid new name", async () => {
    const running = await start({ tokens: fakeTokens() });
    expect((await fetch(`${base(running)}/api/machines`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await owner(running, "/api/machines", "POST", { name: "hub", system: "windows" })).status).toBe(400);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "linux" })).status).toBe(400);
    const service = await assertion({ key, clock, claims: serviceClaims() });
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" }, { "Cf-Access-Jwt-Assertion": service })).status).toBe(403);
    const { code } = await add(running, "pc");
    await redeem(running, code);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" })).status).toBe(409);
  });
});

describe("revoking a machine from the page", () => {
  it("refuses the machine from then on and removes its service token", async () => {
    const tokens = fakeTokens();
    const running = await start({ tokens });
    const { code } = await add(running, "studio");
    const setup = decodeRunnerSetup(/'(superagent2-runner-setup:[^']+)'/.exec(await (await redeem(running, code)).text())?.[1] ?? "");
    const response = await owner(running, "/api/machines/studio/revoke", "POST", {});
    expect(response.status).toBe(200);
    expect(MachineRevoked.parse(await response.json())).toEqual({ name: "studio", accessToken: "removed" });
    expect(tokens.removed).toEqual(["token-1"]);
    expect(running.runners.admit({ kind: "service", clientId: "client1.access" }, setup?.runnerToken)).toBeUndefined();
    expect(running.settings.snapshot().machines).toEqual([]);
    expect((await owner(running, "/api/machines/studio/revoke", "POST", {})).status).toBe(404);
  });

  it("still revokes when Cloudflare refuses, and says the token was kept", async () => {
    const tokens = fakeTokens();
    tokens.failRemove = true;
    const running = await start({ tokens });
    const { code } = await add(running, "studio");
    await redeem(running, code);
    const response = await owner(running, "/api/machines/studio/revoke", "POST", {});
    expect(await response.json()).toEqual({ name: "studio", accessToken: "kept" });
    expect(running.machines.active("studio")).toBeUndefined();
  });

  it("says no token was removed for a machine added with an existing one", async () => {
    const running = await start({ tokens: fakeTokens() });
    running.machines.add({ name: "old", accessClientId: "old.access" });
    expect(await (await owner(running, "/api/machines/old/revoke", "POST", {})).json()).toEqual({ name: "old", accessToken: "none" });
    expect((await owner(running, "/api/machines/x/revoke", "POST", { extra: 1 })).status).toBe(400);
  });
});

describe("the other settings", () => {
  it("reads the whole snapshot for the owner", async () => {
    const running = await start({ tokens: fakeTokens() });
    const response = await fetch(`${base(running)}/api/settings`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    const snapshot = SettingsSnapshot.parse(await response.json());
    expect(snapshot.accounts).toEqual([
      { account: "novan-xu", configured: true },
      { account: "nuofan-island", configured: true },
    ]);
    expect(snapshot.brain).toEqual({ linked: false, order: ["gpt", "claude", "deepseek"], providers: [] });
    expect(snapshot.repositories).toEqual([{ repository: "novan-xu/super-agent2", account: "novan-xu", chosen: false }]);
    expect((await fetch(`${base(running)}/api/settings`)).status).toBe(403);
  });

  it("sends a changed provider order to the brain at once, and again when it links", async () => {
    const running = await start();
    const sent: HubToBrain[] = [];
    const link = running.conversations.attach({ send: (message) => sent.push(message), close: () => undefined });
    link.receive({ type: "hello", protocol: protocolVersion, running: [] });
    expect(sent.filter((message) => message.type === "order")).toEqual([]);
    expect((await owner(running, "/api/brain/order", "PUT", { order: ["gpt", "gpt"] })).status).toBe(400);
    const response = await owner(running, "/api/brain/order", "PUT", { order: ["claude", "gpt"] });
    expect(SettingsSnapshot.parse(await response.json()).brain.order).toEqual(["claude", "gpt", "deepseek"]);
    expect(sent.filter((message) => message.type === "order")).toEqual([{ type: "order", order: ["claude", "gpt", "deepseek"] }]);
    link.detach();
    const again: HubToBrain[] = [];
    running.conversations.attach({ send: (message) => again.push(message), close: () => undefined }).receive({ type: "hello", protocol: protocolVersion, running: [] });
    expect(again.filter((message) => message.type === "order")).toEqual([{ type: "order", order: ["claude", "gpt", "deepseek"] }]);
  });

  it("shows what the brain says about its providers while it is linked", async () => {
    const running = await start();
    const link = running.conversations.attach({ send: () => undefined, close: () => undefined });
    link.receive({ type: "hello", protocol: protocolVersion, running: [] });
    const providers = [{ provider: "gpt" as const, model: "gpt-6-astra", effort: "high", available: false, until: clock.now() + 60_000 }];
    link.receive({ type: "providers", order: ["gpt", "deepseek"], providers });
    expect(running.settings.snapshot().brain).toEqual({ linked: true, order: ["gpt", "deepseek"], providers });
    link.detach();
    expect(running.settings.snapshot().brain.providers).toEqual([]);
  });

  it("refuses a table cell no online machine offers, and changes nothing", async () => {
    const running = await start();
    const table = { ...startingEngineTable, codex: { ...startingEngineTable.codex, complex: { model: "gpt-9", effort: "high" } } };
    const response = await owner(running, "/api/engine-table", "PUT", { table });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "unsupported" });
    expect(running.defaults.table()).toEqual(startingEngineTable);
    expect((await owner(running, "/api/engine-table", "PUT", { table: startingEngineTable })).status).toBe(200);
  });

  it("corrects a repository's account, and forgets the correction when it matches the owner", async () => {
    const running = await start();
    const response = await owner(running, "/api/repositories/account", "PUT", { repository: "novan-xu/super-agent2", account: "nuofan-island" });
    expect(SettingsSnapshot.parse(await response.json()).repositories).toEqual([{ repository: "novan-xu/super-agent2", account: "nuofan-island", chosen: true }]);
    expect(running.repositories.accountOf("Novan-Xu/Super-Agent2")).toBe("nuofan-island");
    await owner(running, "/api/repositories/account", "PUT", { repository: "novan-xu/super-agent2", account: "novan-xu" });
    expect(running.repositories.list()).toEqual([{ repository: "novan-xu/super-agent2", account: "novan-xu", chosen: false }]);
    expect((await owner(running, "/api/repositories/account", "PUT", { repository: "x", account: "novan-xu" })).status).toBe(400);
  });
});
