import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerTokenHeader } from "@super-agent2/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { type Hub, startHub } from "./hub.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { emptyRepositoryForge } from "./testing/http.js";

let dataDir: string;
let hub: Hub;
let url: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-loopback-"));
  const page = join(dataDir, "page");
  mkdirSync(page);
  writeFileSync(join(page, "index.html"), "<!doctype html><title>Local page</title>");
  const loaded = loadConfig({ HUB_DATA_DIR: dataDir, HUB_PAGE_DIR: page, HUB_PORT: "0" });
  if (!loaded.ok) throw new Error(loaded.problems.join("\n"));
  hub = await startHub({ config: loaded.config, credentials: testCredentials, targets: [fakeTarget("hub")], forgeFetch: emptyRepositoryForge });
  url = `http://127.0.0.1:${hub.address.port}`;
});

afterAll(async () => {
  await hub?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function status(path: string, headers: Record<string, string> = {}, upgrade = false): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const sent = request(`${url}${path}`, { headers: {
      ...(upgrade ? { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } : {}), ...headers,
    } });
    sent.on("response", (response) => { response.resume(); resolve(response.statusCode); });
    sent.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    sent.on("error", reject);
    sent.end();
  });
}

it("binds only to loopback without Access audiences", () => {
  expect(hub.address.address).toBe("127.0.0.1");
  expect(loadConfig({ HUB_DATA_DIR: dataDir, HUB_HOST: "0.0.0.0" })).toMatchObject({ ok: false, problems: [expect.stringContaining("loopback")] });
});

it("admits the local owner with a matching HTTP origin and exposes only health to other hosts and sites", async () => {
  const localhost = `localhost:${hub.address.port}`;
  expect(await status("/", { host: localhost, origin: `http://${localhost}` })).toBe(200);
  expect(await (await fetch(`${url}/api/session`)).json()).toMatchObject({ identity: { kind: "person", email: "owner@local.invalid" } });
  const denied: Record<string, string>[] = [
    { host: "other.invalid" }, { host: "127.0.0.1:0" }, { origin: "https://other.invalid" },
    { origin: url.replace("http:", "https:") }, { origin: url, "sec-fetch-site": "cross-site" },
  ];
  for (const headers of denied) {
    for (const path of ["/", "/api/session", "/runner/install", "/brain/mcp", "/mcp", "/inbox/message", "/work-requests/disabled", "/unknown"]) {
      expect(await status(path, headers)).toBe(403);
    }
    expect(await status("/health", headers)).toBe(200);
    expect(await status("/ws", headers, true)).toBe(403);
  }
});

it("keeps brain and runner tokens on their own paths", async () => {
  const authorization = `Bearer ${readFileSync(join(dataDir, "brain.token"), "utf8").trim()}`;
  expect(await status("/brain/link", { authorization }, true)).toBe(101);
  expect(await status("/api/session", { authorization })).toBe(403);
  expect(await status("/ws", { authorization }, true)).toBe(403);
  const { token } = hub.machines.add({ name: "test-runner", accessClientId: "test" });
  expect(await status("/runner/link", {}, true)).toBe(403);
  expect(await status("/runner/link", { [runnerTokenHeader]: token }, true)).toBe(101);
  expect(await status("/runner/link", { [runnerTokenHeader]: token, origin: "https://other.invalid" }, true)).toBe(403);
  expect(await status("/runner/install", { [runnerTokenHeader]: token })).toBe(404);
  expect(await status("/mcp")).toBe(404);
  expect(await status("/inbox/message")).toBe(404);
});

it("passes loopback identity to the confirmation and chain start services", async () => {
  const command = hub.commands.start({ target: "hub", account: "novan-xu", command: "Remove-Item -LiteralPath 'D:\\outside' -Recurse" });
  const held = hub.lock?.get(command.id);
  expect(held?.answer).toBeNull();
  const post = (path: string, data: object) => fetch(`${url}${path}`, {
    method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(data),
  });
  expect((await post(`/api/commands/${command.id}/release`, { fingerprint: held?.fingerprint })).status).toBe(202);
  expect(hub.lock?.get(command.id)?.answer).toBe("released");
  const start = await post("/api/chains/start", { chains: [{ ticket: 1, fingerprint: "a".repeat(64) }] });
  expect(start.status).toBe(409);
  expect(await start.json()).toEqual({ error: "conflict" });
});
