import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessClientIdHeader,
  accessClientSecretHeader,
  decodeRunnerSetup,
  type HubToBrain,
  MachineAdded,
  MachineRevoked,
  machineAccessWarning,
  protocolVersion,
  runnerInstallPath,
  runnerTokenHeader,
  SettingsSnapshot,
  startingEngineTable,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessServiceTokens, ServiceToken } from "./cloudflare.js";
import { openDatabase } from "./database.js";
import type { Hub } from "./hub.js";
import { installCommand, macosScript, windowsScript } from "./machine-admin.js";
import { migrations as hubMigrations } from "./migrations.js";
import { assertion, audience, issuer, keySet, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;

const version = "0123456789abcdef0123456789abcdef01234567";
const runnerAudience = "b".repeat(64);

interface FakeTokens extends AccessServiceTokens {
  readonly created: string[];
  readonly removed: string[];
  failRemove: boolean;
  failCreate: boolean;
  next: Partial<ServiceToken>;
}

function fakeTokens(): FakeTokens {
  const tokens: FakeTokens = {
    created: [],
    removed: [],
    failRemove: false,
    failCreate: false,
    next: {},
    create: async (name) => {
      if (tokens.failCreate) {
        throw new Error("Cloudflare refused to create the service token (HTTP 403): Authentication error");
      }
      tokens.created.push(name);
      const count = tokens.created.length;
      return { id: `token-${count}`, clientId: `client${count}.access`, clientSecret: `secret${count}abcdef0123456789`, expiresAt: null, ...tokens.next };
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
  dataDir = mkdtempSync(join(tmpdir(), "hub-machine-admin-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(options: { tokens?: AccessServiceTokens; release?: boolean; forgeFetch?: typeof fetch } = {}): Promise<Hub> {
  hub = await startTestHub({
    config: { ...testConfig(dataDir), accessRunnerAudience: runnerAudience, ...(options.release === false ? {} : { version, sourceRepository: "novan-xu/super-agent2" }) },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [fakeTarget("hub")],
    credentials: testCredentials,
    gate: () => ({ kind: "allow" as const }),
    machinePollMilliseconds: 10,
    report: () => undefined,
    ...(options.forgeFetch === undefined ? {} : { forgeFetch: options.forgeFetch }),
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

interface Line {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly runnerToken: string;
}

it("lets the owner save storage for an offline machine and validates the request", async () => {
  const running = await start();
  running.machines.add({ name: "pc", accessClientId: "client.access" });
  const path = "/api/machines/pc/storage";
  const storage = { projectsDir: "C:\\My Projects", artifactsDir: "M:\\Zdir\\Super-agent" };
  expect((await owner(running, path, "PUT", storage, { origin: "https://example.com" })).status).toBe(403);
  expect((await owner(running, path, "PUT", { projectsDir: "path\nwith\nnewline" })).status).toBe(400);
  expect((await owner(running, "/api/machines/missing/storage", "PUT", storage)).status).toBe(404);
  const response = await owner(running, path, "PUT", storage);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(storage);
  expect(running.settings.snapshot().machines[0]).toMatchObject({ name: "pc", online: false, storage });
  await running.close();
  hub = undefined;
  const reopened = await start();
  expect(reopened.machines.active("pc")?.storage).toEqual(storage);
});

function windowsLine(command: string): Line {
  const value = (header: string) => new RegExp(`'${header}' = '([^']+)'`).exec(command)?.[1] ?? "";
  return { clientId: value(accessClientIdHeader), clientSecret: value(accessClientSecretHeader), runnerToken: value(runnerTokenHeader) };
}

function macosLine(command: string): Line {
  const value = (name: string) => new RegExp(`${name}='([^']+)'`).exec(command)?.[1] ?? "";
  return { clientId: value("id"), clientSecret: value("secret"), runnerToken: value("token") };
}

async function add(running: Hub, name: string, system: "windows" | "macos" = "windows"): Promise<{ added: MachineAdded; line: Line }> {
  const response = await owner(running, "/api/machines", "POST", { name, system });
  expect(response.status).toBe(201);
  const added = MachineAdded.parse(await response.json());
  return { added, line: system === "windows" ? windowsLine(added.command) : macosLine(added.command) };
}

async function asMachine(clientId: string, audienceTag: string = runnerAudience): Promise<string> {
  return assertion({ key, clock, claims: { iss: issuer, aud: [audienceTag], common_name: clientId, sub: "", type: "app" } });
}

async function fetchScript(running: Hub, line: Line, audienceTag?: string): Promise<Response> {
  return fetch(`${base(running)}${runnerInstallPath}`, {
    headers: { "Cf-Access-Jwt-Assertion": await asMachine(line.clientId, audienceTag), [runnerTokenHeader]: line.runnerToken },
  });
}

describe("the install line and script", () => {
  const credentials = { hub: "https://agent.example.com", clientId: "c1.access", clientSecret: "0123abcd", runnerToken: "t0ken_-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };

  it("carries the machine's credentials to the authenticated install route, and keeps them out of process arguments on macOS", () => {
    const windows = installCommand("windows", credentials);
    expect(windows).toBe(
      `& { $access = @{ 'cf-access-client-id' = 'c1.access'; 'cf-access-client-secret' = '0123abcd'; 'x-runner-token' = '${credentials.runnerToken}' }; irm -MaximumRedirection 0 -Headers $access -Uri 'https://agent.example.com/runner/install' | iex }`,
    );
    const macos = installCommand("macos", credentials);
    expect(macos).toContain("curl -fsSL --max-redirs 0 -H @- 'https://agent.example.com/runner/install'");
    expect(macos).toContain(`id='c1.access'; secret='0123abcd'; token='${credentials.runnerToken}'`);
    expect(macos.match(/0123abcd/g)).toHaveLength(1);
    expect(macos.startsWith("( ") && macos.endsWith(" )")).toBe(true);
  });

  it("refuses a value that is not safe in both shells", () => {
    expect(() => installCommand("windows", { ...credentials, clientSecret: "a'b" })).toThrow();
    expect(() => installCommand("macos", { ...credentials, runnerToken: "a b" })).toThrow();
    expect(() => installCommand("macos", { ...credentials, clientId: "$(x)" })).toThrow();
    expect(() => installCommand("windows", { ...credentials, hub: "https://agent.example.com/path" })).toThrow();
    expect(() => installCommand("windows", { ...credentials, hub: "https://agent.example.com';x" })).toThrow();
  });

  const values = { hub: "https://agent.example.com", version, setup: "superagent2-runner-setup:abc_DEF-1" };

  it("fetches the hub's release with the credentials the line holds, saves them through the runner's setup and installs it", () => {
    for (const script of [macosScript(values), windowsScript(values)]) {
      expect(script).toContain("https://agent.example.com/runner/release");
      expect(script).toContain(values.setup);
      expect(script).toContain("setup");
      expect(script).toContain("install");
      expect(script).toContain("SUPERAGENT2_RUNNER_FOREGROUND");
      expect(script).toContain("0123456789ab");
    }
    expect(windowsScript(values)).toContain("-Headers $access");
    expect(windowsScript(values)).toContain("@($setup, $access['cf-access-client-secret'], $access['x-runner-token']) | & node $main setup");
    expect(macosScript(values)).toContain("credentials | curl -fsS -H @- \"$release\"");
    expect(macosScript(values)).toContain('printf "%s\\n%s\\n%s\\n" "$setup" "$client_secret" "$runner_token" | node "$main" setup');
  });

  it("never prints a credential", () => {
    const shown = (script: string) => script.split(/\r?\n/).filter((line) => /\b(echo|Write-Host|Write-Output)\b/.test(line));
    for (const line of [...shown(macosScript(values)), ...shown(windowsScript(values))]) {
      expect(line).not.toMatch(/client_secret|runner_token|client_id|\$access/);
    }
  });

  it("refuses a value it could not quote safely", () => {
    expect(() => macosScript({ ...values, setup: "a'b" })).toThrow();
    expect(() => windowsScript({ ...values, hub: "a b" })).toThrow();
  });
});

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
}

async function lineServer(script: string): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    received.push({ headers: request.headers, path: request.url ?? "" });
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(script);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function run(program: string, args: readonly string[], environment: Record<string, string>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: { ...process.env, ...environment }, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

describe("running the install line", () => {
  const line = { clientId: "c1.access", clientSecret: "0123abcd", runnerToken: "t0ken_-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };

  it.runIf(process.platform === "win32")("hands Windows PowerShell's script the credentials in a variable that is gone afterwards", async () => {
    const out = join(dataDir, "seen.txt");
    const server = await lineServer(
      "& { if ($env:SEEN_SECRET) { exit 4 }; Set-Content -Encoding ascii -Path $env:SEEN_FILE -Value @($access['cf-access-client-id'], $access['cf-access-client-secret'], $access['x-runner-token']) }",
    );
    try {
      const command = `$ProgressPreference = 'SilentlyContinue'; ${installCommand("windows", { hub: server.url, ...line })}; if ($null -ne $access) { exit 3 }`;
      const code = await run("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { SEEN_FILE: out });
      expect(code).toBe(0);
      expect(readFileSync(out, "utf8").split(/\r?\n/).slice(0, 3)).toEqual([line.clientId, line.clientSecret, line.runnerToken]);
      expect(server.received).toHaveLength(1);
      expect(server.received[0]?.path).toBe(runnerInstallPath);
      expect(server.received[0]?.headers[accessClientSecretHeader]).toBe(line.clientSecret);
      expect(server.received[0]?.headers[runnerTokenHeader]).toBe(line.runnerToken);
    } finally {
      await server.close();
    }
  });

  it.runIf(process.platform !== "win32")("hands the macOS script the credentials on its standard input, not in its environment", async () => {
    const out = join(dataDir, "seen.txt");
    const server = await lineServer(
      'IFS= read -r a; IFS= read -r b; IFS= read -r c; if env | grep -q "$b"; then exit 4; fi; printf "%s\\n%s\\n%s\\n" "$a" "$b" "$c" > "$SEEN_FILE"\n',
    );
    try {
      const shells = ["/bin/sh", "/bin/zsh", "/bin/bash"].filter((shell) => {
        try {
          readFileSync(shell);
          return true;
        } catch {
          return false;
        }
      });
      expect(shells.length).toBeGreaterThan(0);
      for (const shell of shells) {
        rmSync(out, { force: true });
        const code = await run(shell, ["-c", installCommand("macos", { hub: server.url, ...line })], { SEEN_FILE: out });
        expect(code).toBe(0);
        expect(readFileSync(out, "utf8").split("\n").slice(0, 3)).toEqual([line.clientId, line.clientSecret, line.runnerToken]);
      }
      expect(server.received[0]?.path).toBe(runnerInstallPath);
      expect(server.received[0]?.headers[accessClientIdHeader]).toBe(line.clientId);
      expect(server.received[0]?.headers[accessClientSecretHeader]).toBe(line.clientSecret);
      expect(server.received[0]?.headers[runnerTokenHeader]).toBe(line.runnerToken);
    } finally {
      await server.close();
    }
  });
});

describe("adding a machine from the page", () => {
  it("makes its service token and runner token at once and answers the line that carries them", async () => {
    const tokens = fakeTokens();
    const running = await start({ tokens });
    const { added, line } = await add(running, "studio");
    expect(added.command).toContain(`${base(running)}${runnerInstallPath}`);
    expect(tokens.created).toEqual(["superagent2-runner-studio"]);
    expect(line).toMatchObject({ clientId: "client1.access", clientSecret: "secret1abcdef0123456789" });
    const machine = running.machines.byToken(line.runnerToken);
    expect(machine).toMatchObject({ name: "studio", accessClientId: "client1.access", accessTokenId: "token-1", system: "windows", hub: base(running), accessExpiresAt: null });
    const stored = readFileSync(join(dataDir, "hub.sqlite"));
    expect(stored.includes(Buffer.from(line.clientSecret))).toBe(false);
    expect(stored.includes(Buffer.from(line.runnerToken))).toBe(false);
    expect(running.settings.snapshot().machines).toEqual([{ name: "studio", online: false, createdAt: clock.now(), lastSeenAt: null, report: null, system: "windows" }]);
  });

  it("serves the install script only to that machine, through the runner application", async () => {
    const running = await start({ tokens: fakeTokens() });
    const { line } = await add(running, "studio", "macos");
    const script = await fetchScript(running, line);
    expect(script.status).toBe(200);
    expect(script.headers.get("cache-control")).toBe("no-store");
    const text = await script.text();
    expect(text).not.toContain(line.clientSecret);
    expect(text).not.toContain(line.runnerToken);
    expect(decodeRunnerSetup(/setup='(superagent2-runner-setup:[^']+)'/.exec(text)?.[1] ?? "")).toEqual({ hub: base(running), name: "studio", accessClientId: line.clientId });
    expect((await fetch(`${base(running)}${runnerInstallPath}`)).status).toBe(403);
    expect((await fetchScript(running, { ...line, runnerToken: "A".repeat(43) })).status).toBe(403);
    expect((await fetchScript(running, { ...line, clientId: "other.access" })).status).toBe(403);
    expect((await fetchScript(running, line, audience)).status).toBe(403);
    const asOwner = await fetch(`${base(running)}${runnerInstallPath}`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), [runnerTokenHeader]: line.runnerToken } });
    expect(asOwner.status).toBe(403);
    const added = running.machines.add({ name: "old", accessClientId: "old.access" });
    expect((await fetchScript(running, { clientId: "old.access", clientSecret: "x", runnerToken: added.token })).status).toBe(404);
  });

  it("adds nothing and says why when Cloudflare refuses the token", async () => {
    const tokens = fakeTokens();
    tokens.failCreate = true;
    const running = await start({ tokens });
    const response = await owner(running, "/api/machines", "POST", { name: "studio", system: "windows" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "cloudflare_refused", reason: "Cloudflare refused to create the service token (HTTP 403): Authentication error" });
    expect(running.machines.get("studio")).toBeUndefined();
    tokens.failCreate = false;
    expect((await owner(running, "/api/machines", "POST", { name: "studio", system: "windows" })).status).toBe(201);
  });

  it("deletes a token whose credentials the line could not carry, and adds nothing", async () => {
    const tokens = fakeTokens();
    tokens.next = { clientSecret: "has'quote" };
    const running = await start({ tokens });
    const response = await owner(running, "/api/machines", "POST", { name: "studio", system: "windows" });
    expect(response.status).toBe(502);
    expect(tokens.removed).toEqual(["token-1"]);
    expect(running.machines.get("studio")).toBeUndefined();
  });

  it("says plainly that Cloudflare or the release is missing, and adds nothing", async () => {
    const running = await start();
    const response = await owner(running, "/api/machines", "POST", { name: "studio", system: "windows" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "cloudflare" });
    expect(running.settings.snapshot().canAdd).toEqual({ cloudflare: false, release: true });
    expect(running.settings.snapshot().machines).toEqual([]);
    await running.close();
    hub = undefined;
    const tokens = fakeTokens();
    const second = await start({ tokens, release: false });
    expect(await (await owner(second, "/api/machines", "POST", { name: "studio", system: "windows" })).json()).toEqual({ error: "release" });
    expect(tokens.created).toEqual([]);
  });

  it("is the owner's action from the page's own origin, as JSON, for a valid new name", async () => {
    const tokens = fakeTokens();
    const running = await start({ tokens });
    expect((await fetch(`${base(running)}/api/machines`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await owner(running, "/api/machines", "POST", { name: "hub", system: "windows" })).status).toBe(400);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "linux" })).status).toBe(400);
    const service = await assertion({ key, clock, claims: serviceClaims() });
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" }, { "Cf-Access-Jwt-Assertion": service })).status).toBe(403);
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" }, { "Cf-Access-Jwt-Assertion": await asMachine("x.access") })).status).toBe(403);
    expect(tokens.created).toEqual([]);
    await add(running, "pc");
    expect((await owner(running, "/api/machines", "POST", { name: "pc", system: "windows" })).status).toBe(409);
    expect(tokens.created).toEqual(["superagent2-runner-pc"]);
  });
});

describe("revoking a machine from the page", () => {
  it("refuses a machine that never connected from then on and deletes its service token", async () => {
    const tokens = fakeTokens();
    const running = await start({ tokens });
    const { line } = await add(running, "studio");
    const response = await owner(running, "/api/machines/studio/revoke", "POST", {});
    expect(response.status).toBe(200);
    expect(MachineRevoked.parse(await response.json())).toEqual({ name: "studio", accessToken: "removed" });
    expect(tokens.removed).toEqual(["token-1"]);
    expect(running.runners.admit({ kind: "service", clientId: line.clientId }, line.runnerToken)).toBeUndefined();
    expect((await fetchScript(running, line)).status).toBe(403);
    expect(running.settings.snapshot().machines).toEqual([]);
    expect((await owner(running, "/api/machines/studio/revoke", "POST", {})).status).toBe(404);
  });

  it("still revokes when Cloudflare refuses, and says the token was kept", async () => {
    const tokens = fakeTokens();
    tokens.failRemove = true;
    const running = await start({ tokens });
    await add(running, "studio");
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

describe("a service token that runs out", () => {
  it("is dated, for a token the hub made before tokens were made not to expire", () => {
    const earlier = openDatabase({ dataDir, clock, migrations: hubMigrations.filter((migration) => migration.version <= 27) });
    const insert = earlier.connection.prepare("INSERT INTO machines (name, token_hash, access_client_id, access_token_id, created_at) VALUES (?, ?, ?, ?, ?)");
    insert.run("made", "a".repeat(64), "made.access", "token-1", clock.now());
    insert.run("reused", "b".repeat(64), "reused.access", null, clock.now());
    earlier.close();
    const later = openDatabase({ dataDir, clock });
    expect(later.connection.prepare("SELECT name, access_expires_at FROM machines ORDER BY name").all()).toEqual([
      { name: "made", access_expires_at: clock.now() + 365 * 24 * 60 * 60 * 1000 },
      { name: "reused", access_expires_at: null },
    ]);
    expect(later.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'install_codes'").all()).toEqual([]);
    later.close();
  });

  it("shows in 设置 when it runs out, and tells the owner and the brain once, a month ahead", async () => {
    const tokens = fakeTokens();
    tokens.next = { expiresAt: clock.now() + 2 * machineAccessWarning };
    const running = await start({ tokens });
    const sent: HubToBrain[] = [];
    running.conversations.attach({ send: (message) => sent.push(message), close: () => undefined }).receive({ type: "hello", protocol: protocolVersion, running: [] });
    await add(running, "studio");
    expect(running.settings.snapshot().machines[0]?.accessExpiresAt).toBe(clock.now() + 2 * machineAccessWarning);
    const notices = () => running.conversations.list().flatMap((conversation) => running.conversations.entries(conversation.id)).filter((entry) => entry.kind === "notice");
    running.admin.warnExpiring();
    expect(notices()).toEqual([]);
    clock.advance(machineAccessWarning);
    running.admin.warnExpiring();
    running.admin.warnExpiring();
    expect(notices()).toHaveLength(1);
    expect(JSON.stringify(notices()[0])).toContain("studio");
    expect(sent.some((message) => JSON.stringify(message).includes("The Cloudflare Access service token of the machine studio runs out"))).toBe(true);
  });

  it("is not dated when Cloudflare makes it not to expire", async () => {
    const running = await start({ tokens: fakeTokens() });
    await add(running, "studio");
    clock.advance(10 * 365 * 24 * 60 * 60 * 1000);
    running.admin.warnExpiring();
    expect(running.settings.snapshot().machines[0]?.accessExpiresAt).toBeUndefined();
    expect(running.conversations.list().flatMap((conversation) => running.conversations.entries(conversation.id))).toEqual([]);
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
    expect(snapshot.brain).toEqual({ linked: false, order: ["claude", "gpt", "deepseek"], providers: [] });
    expect(snapshot.workerOrder).toEqual(["gpt", "claude", "deepseek"]);
    expect(running.database.connection.prepare("SELECT key FROM hub_settings WHERE key IN ('brain_order', 'worker_order')").all()).toEqual([]);
    expect(snapshot.repositories).toEqual([{ repository: "novan-xu/super-agent2", account: "novan-xu", chosen: false, pinned: false }]);
    expect((await fetch(`${base(running)}/api/settings`)).status).toBe(403);
  });

  it("sends a changed provider order to the brain at once, and again when it links", async () => {
    const running = await start();
    const sent: HubToBrain[] = [];
    const link = running.conversations.attach({ send: (message) => sent.push(message), close: () => undefined });
    link.receive({ type: "hello", protocol: protocolVersion, running: [] });
    expect(sent.filter((message) => message.type === "order")).toEqual([]);
    expect((await owner(running, "/api/brain/order", "PUT", { order: ["gpt", "gpt", "deepseek"] })).status).toBe(400);
    const response = await owner(running, "/api/brain/order", "PUT", { order: ["deepseek", "claude", "gpt"] });
    expect(SettingsSnapshot.parse(await response.json())).toMatchObject({
      brain: { order: ["deepseek", "claude", "gpt"] }, workerOrder: ["gpt", "claude", "deepseek"],
    });
    expect(sent.filter((message) => message.type === "order")).toEqual([{ type: "order", order: ["deepseek", "claude", "gpt"] }]);
    link.detach();
    const again: HubToBrain[] = [];
    running.conversations.attach({ send: (message) => again.push(message), close: () => undefined }).receive({ type: "hello", protocol: protocolVersion, running: [] });
    expect(again.filter((message) => message.type === "order")).toEqual([{ type: "order", order: ["deepseek", "claude", "gpt"] }]);
  });

  it("keeps a legacy brain order independent of worker settings across restarts", async () => {
    const running = await start();
    running.database.connection.prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES ('brain_order', ?, ?)").run(JSON.stringify(["gpt", "claude"]), clock.now());
    const sent: HubToBrain[] = [];
    running.conversations.attach({ send: (message) => sent.push(message), close: () => undefined }).receive({ type: "hello", protocol: protocolVersion, running: [] });
    expect(sent.filter((message) => message.type === "order")).toEqual([{ type: "order", order: ["gpt", "claude", "deepseek"] }]);
    expect(running.settings.snapshot().workerOrder).toEqual(["gpt", "claude", "deepseek"]);
    expect((await owner(running, "/api/workers/order", "PUT", { order: ["deepseek", "gpt"] })).status).toBe(400);
    const change = { order: ["deepseek", "gpt", "claude"] };
    expect((await owner(running, "/api/workers/order", "PUT", change, { origin: "https://untrusted.example" })).status).toBe(403);
    const response = await owner(running, "/api/workers/order", "PUT", change);
    expect(SettingsSnapshot.parse(await response.json())).toMatchObject({
      brain: { order: ["gpt", "claude", "deepseek"] }, workerOrder: change.order,
    });
    expect(sent.filter((message) => message.type === "order")).toHaveLength(1);
    expect(running.defaults.order(false)).toEqual(["dsh", "codex", "claude"]);
    await running.close();
    const restarted = await start();
    const snapshot = await fetch(`${base(restarted)}/api/settings`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    expect(SettingsSnapshot.parse(await snapshot.json())).toMatchObject({
      brain: { order: ["gpt", "claude", "deepseek"] }, workerOrder: change.order,
    });
    expect(restarted.defaults.order(false)).toEqual(["dsh", "codex", "claude"]);
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
    expect(SettingsSnapshot.parse(await response.json()).repositories).toEqual([{ repository: "novan-xu/super-agent2", account: "nuofan-island", chosen: true, pinned: false }]);
    expect(running.repositories.accountOf("Novan-Xu/Super-Agent2")).toBe("nuofan-island");
    await owner(running, "/api/repositories/account", "PUT", { repository: "novan-xu/super-agent2", account: "novan-xu" });
    expect(running.repositories.list()).toEqual([{ repository: "novan-xu/super-agent2", account: "novan-xu", chosen: false, pinned: false }]);
    expect((await owner(running, "/api/repositories/account", "PUT", { repository: "x", account: "novan-xu" })).status).toBe(400);
  });

  it("authenticates, validates, publishes and persists repository pins", async () => {
    const running = await start();
    const path = "/api/repositories/pin";
    const request = { repository: "Novan-Xu/Super-Agent2", pinned: true };
    expect((await fetch(`${base(running)}${path}`, { method: "POST" })).status).toBe(403);
    expect((await owner(running, path, "POST", request, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await owner(running, path, "POST", { ...request, pinned: "true" })).status).toBe(400);
    expect((await owner(running, path, "POST", { ...request, repository: "org/unknown" })).status).toBe(404);

    const updates: SettingsSnapshot[] = [];
    const unsubscribe = running.settings.subscribe((snapshot) => updates.push(snapshot));
    const saved = await owner(running, path, "POST", request);
    expect(saved.status).toBe(200);
    expect(SettingsSnapshot.parse(await saved.json()).repositories[0]?.pinned).toBe(true);
    expect(updates.at(-1)?.repositories[0]?.pinned).toBe(true);
    unsubscribe();
    await running.close();
    hub = undefined;

    const restarted = await start();
    expect(restarted.settings.snapshot().repositories[0]?.pinned).toBe(true);
    const removed = await owner(restarted, path, "POST", { ...request, pinned: false });
    expect(SettingsSnapshot.parse(await removed.json()).repositories[0]?.pinned).toBe(false);
  });

  it("validates and persists the complete pinned repository order", async () => {
    const running = await start();
    for (const repository of ["org/first", "org/second"]) {
      running.repositories.set(repository, "nuofan-island");
      expect(running.repositories.setPinned(repository, true)).toBe(true);
    }
    const path = "/api/repositories/order";
    expect((await fetch(`${base(running)}${path}`, { method: "POST" })).status).toBe(403);
    for (const repositories of [["org/first"], ["org/first", "org/first"], ["org/first", "org/unknown"]]) {
      expect((await owner(running, path, "POST", { repositories })).status).toBe(409);
    }
    expect((await owner(running, path, "POST", { repositories: "bad" })).status).toBe(400);
    const updates: SettingsSnapshot[] = [];
    const unsubscribe = running.settings.subscribe((snapshot) => updates.push(snapshot));
    const response = await owner(running, path, "POST", { repositories: ["ORG/SECOND", "org/first"] });
    expect(response.status).toBe(200);
    const ordered = (snapshot: SettingsSnapshot) => snapshot.repositories.filter((row) => row.pinned).sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0)).map((row) => row.repository);
    expect(ordered(SettingsSnapshot.parse(await response.json()))).toEqual(["org/second", "org/first"]);
    expect(ordered(updates.at(-1)!)).toEqual(["org/second", "org/first"]);
    unsubscribe();
    await running.close();
    hub = undefined;
    const restarted = await start();
    expect(ordered(restarted.settings.snapshot())).toEqual(["org/second", "org/first"]);
  });

  it("validates, publishes and persists repository aliases", async () => {
    const running = await start();
    const path = "/api/repositories/alias";
    const request = { repository: "Novan-Xu/Super-Agent2", alias: "  Agent  " };
    expect((await fetch(`${base(running)}${path}`, { method: "POST" })).status).toBe(403);
    expect((await owner(running, path, "POST", { ...request, alias: "x".repeat(41) })).status).toBe(400);
    expect((await owner(running, path, "POST", { ...request, alias: "bad\nname" })).status).toBe(400);
    expect((await owner(running, path, "POST", { ...request, extra: true })).status).toBe(400);
    expect((await owner(running, path, "POST", { ...request, repository: "org/unknown" })).status).toBe(404);
    const updates: SettingsSnapshot[] = [];
    const unsubscribe = running.settings.subscribe((snapshot) => updates.push(snapshot));
    const saved = await owner(running, path, "POST", request);
    expect(SettingsSnapshot.parse(await saved.json()).repositories[0]?.alias).toBe("Agent");
    expect(updates.at(-1)?.repositories[0]?.alias).toBe("Agent");
    unsubscribe();
    await running.close();
    hub = undefined;
    const restarted = await start();
    expect(restarted.settings.snapshot().repositories[0]?.alias).toBe("Agent");
    const cleared = await owner(restarted, path, "POST", { ...request, alias: null });
    expect(SettingsSnapshot.parse(await cleared.json()).repositories[0]?.alias).toBeUndefined();
  });

  it("discovers repositories on start and refreshes the catalog for an owner request", async () => {
    const path = "/api/repositories/refresh";
    let name = "novan-xu/First";
    const running = await start({
      forgeFetch: async (input) => {
        const affiliation = new URL(String(input)).searchParams.get("affiliation");
        return Response.json(affiliation === "owner"
          ? [{ full_name: name, owner: { login: "novan-xu" }, archived: false, pushed_at: null, default_branch: "main" }]
          : []);
      },
    });
    const names = () => running.settings.snapshot().repositories.map((row) => row.repository);
    await expect.poll(names).toContain("novan-xu/First");
    name = "novan-xu/Second";
    clock.advance(60_000);
    expect((await fetch(`${base(running)}${path}`, { method: "POST" })).status).toBe(403);
    expect((await owner(running, path, "POST", {})).status).toBe(202);
    await expect.poll(names).toEqual(["novan-xu/Second", "novan-xu/super-agent2"]);
  });
});
