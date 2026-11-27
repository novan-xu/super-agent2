import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerMessage, peerLinkPath, peerTokenHeader, protocolVersion, runnerTokenHeader, startingEngineTable } from "@super-agent2/protocol";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { assertionHeader } from "./access.js";
import { loadConfig } from "./config.js";
import { secretValues } from "./credentials.js";
import type { Hub } from "./hub.js";
import { connectToPeer } from "./peer-link.js";
import { createPeerStore } from "./peer-store.js";
import { assertion, keySet, personClaims, serviceClaims, signingKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

const peerAudience = "d".repeat(64);
const runnerAudience = "e".repeat(64);
const clientId = "peer.access";
const clientSecret = "edge-secret";
const prefix = "/remote/work-laptop";

function urlOf(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}`;
}

function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on("error", reject);
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.on("open", () => { socket.terminate(); resolve(101); });
  });
}

async function fakeEdge(target: () => Hub, signed: string) {
  const server = createServer();
  const connections = new Set<Socket>();
  server.on("upgrade", (incoming, socket, head) => {
    if (incoming.url !== peerLinkPath || incoming.headers["cf-access-client-id"] !== clientId
      || incoming.headers["cf-access-client-secret"] !== clientSecret) {
      socket.destroy();
      return;
    }
    const outgoing = request(urlOf(target().address) + peerLinkPath, { headers: { ...incoming.headers, [assertionHeader]: signed } });
    outgoing.on("error", () => socket.destroy());
    outgoing.on("response", (answer) => { answer.resume(); socket.destroy(); });
    outgoing.on("upgrade", (answer, upstream, first) => {
      connections.add(upstream);
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => { connections.delete(upstream); socket.destroy(); });
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(answer.headers).map(([name, value]) => `${name}: ${String(value)}\r\n`).join("")}\r\n`);
      if (first.length > 0) socket.write(first);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    outgoing.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const cut = () => { for (const socket of connections) socket.destroy(); };
  return { url: urlOf(server.address() as AddressInfo), cut, close: () => { cut(); server.close(); } };
}

it("requires a dedicated Access audience and all four local settings", () => {
  const { accessTeam, accessAudience, ownerEmail } = testConfig("test");
  const env = { HUB_DATA_DIR: "test", ACCESS_AUD: accessAudience, ACCESS_TEAM: accessTeam, OWNER_EMAIL: ownerEmail };
  expect(loadConfig({ ...env, ACCESS_PEER_AUD: accessAudience }).ok).toBe(false);
  expect(loadConfig({ ...env, ACCESS_PEER_AUD: peerAudience })).toMatchObject({ ok: true, config: { accessPeerAudience: peerAudience } });
  const outbound = { PEER_HUB_URL: "https://nas.example.test", PEER_ACCESS_CLIENT_ID: clientId, PEER_ACCESS_CLIENT_SECRET: clientSecret, PEER_TOKEN: randomBytes(32).toString("base64url") };
  expect(secretValues(outbound)).toEqual([clientId, clientSecret, outbound.PEER_TOKEN]);
  expect(loadConfig({ HUB_DATA_DIR: "test", PEER_HUB_URL: outbound.PEER_HUB_URL }).ok).toBe(false);
  expect(loadConfig({ ...env, ...outbound }).ok).toBe(false);
  expect(loadConfig({ HUB_DATA_DIR: "test", ...outbound, PEER_HUB_URL: "http://nas.example.test" }).ok).toBe(false);
  expect(loadConfig({ HUB_DATA_DIR: "test", ...outbound })).toMatchObject({ ok: true, config: { host: "127.0.0.1", outboundPeer: { hub: outbound.PEER_HUB_URL } } });
});

it("relays owner actions, live updates and streamed files without retaining laptop content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-peer-"));
  const nasDir = join(directory, "nas");
  const localDir = join(directory, "local");
  const pageDir = join(localDir, "page");
  const nasPage = join(nasDir, "page");
  mkdirSync(pageDir, { recursive: true });
  mkdirSync(nasPage, { recursive: true });
  writeFileSync(join(nasPage, "theme.js"), "/* Trusted NAS theme */");
  writeFileSync(join(pageDir, "theme.js"), "/* Local edition theme */");
  writeFileSync(join(nasPage, "index.html"), '<!doctype html><title>Trusted NAS bundle</title><script src="/theme.js"></script>');
  const responseMarker = `private-page-${randomUUID()}`;
  const requestMarker = `private-owner-message-${randomUUID()}`;
  const fileMarker = `private-file-${randomUUID()}`;
  writeFileSync(join(pageDir, "index.html"), "<!doctype html><title>Local edition bundle</title>");
  const log = join(nasDir, "test.log");
  const clock = new TestClock();
  const key = await signingKey("peer-test");
  const signedOwner = await assertion({ key, clock, claims: personClaims() });
  const signedPeer = await assertion({ key, clock, claims: { ...serviceClaims(), aud: [peerAudience], common_name: clientId } });
  const signedRunner = await assertion({ key, clock, claims: { ...serviceClaims(), aud: [runnerAudience], common_name: clientId } });
  const options = { clock, targets: [fakeTarget("hub")], credentials: testCredentials, environment: {} };
  const startNas = () => startTestHub({
    ...options, config: { ...testConfig(nasDir), accessPeerAudience: peerAudience, accessRunnerAudience: runnerAudience, pageDir: nasPage },
    keySource: staticKeySource(keySet(key)), report: (line) => writeFileSync(log, `${line}\n`, { flag: "a" }),
  });
  const startLocal = () => startTestHub({
    ...options, config: { dataDir: localDir, host: "127.0.0.1", port: 0, ownerEmail: "owner@local.invalid", pageDir, projectFolders: [], brainTokenFile: join(localDir, "brain.token") },
  });
  let nas = await startNas();
  writeFileSync(log, "", { flag: "a" });
  let nasStopped = false;
  let local = await startLocal();
  let localStopped = false;
  const edge = await fakeEdge(() => nas, signedPeer);
  const token = createPeerStore(nas.database).add({ name: "work-laptop", clientId, accessTokenId: "service-token" });
  const { token: runnerToken } = nas.machines.add({ name: "ordinary-runner", accessClientId: clientId });
  const owner = { [assertionHeader]: signedOwner };
  const peer = { [assertionHeader]: signedPeer, [peerTokenHeader]: token };
  const runner = { [assertionHeader]: signedRunner, [peerTokenHeader]: token, [runnerTokenHeader]: runnerToken };
  const outbound = { hub: edge.url, clientId, clientSecret, token };
  const get = (path: string, headers: Record<string, string> = owner) => fetch(urlOf(nas.address) + path, { headers });
  const post = (path: string, value: object, origin = urlOf(nas.address)) => fetch(urlOf(nas.address) + prefix + path, {
    method: "POST", headers: { ...owner, origin, "content-type": "application/json" }, body: JSON.stringify(value),
  });
  const connect = () => connectToPeer(outbound, local.address, 75);
  const sockets: WebSocket[] = [];
  let disconnect: (() => void) | undefined;
  try {
    expect((await get(prefix + "/", {})).status).toBe(403);
    expect((await get(prefix + "/", peer)).status).toBe(403);
    expect((await get("/api/session", peer)).status).toBe(403);
    expect((await get(prefix + "/")).status).toBe(503);
    expect(await upgradeStatus(urlOf(nas.address) + "/runner/link", { ...peer, [runnerTokenHeader]: runnerToken })).toBe(403);
    expect(await upgradeStatus(urlOf(nas.address) + peerLinkPath, owner)).toBe(403);
    expect(await upgradeStatus(urlOf(nas.address) + peerLinkPath, runner)).toBe(403);
    expect(await upgradeStatus(urlOf(nas.address) + peerLinkPath, { ...peer, [peerTokenHeader]: "x".repeat(43) })).toBe(403);
    expect(await upgradeStatus(urlOf(nas.address) + prefix + "/ws", { origin: urlOf(nas.address) })).toBe(403);
    expect(await upgradeStatus(urlOf(nas.address) + prefix + "/ws", { ...owner, origin: "https://unrelated.example" })).toBe(403);
    expect((await fetch(urlOf(local.address) + "/api/session", { headers: { origin: "https://unrelated.example" } })).status).toBe(403);

    const topic = local.conversations.create();
    local.conversations.send(topic.id, responseMarker);
    disconnect = connect();
    await expect.poll(async () => (await get(prefix + "/api/session")).status, { timeout: 4_000 }).toBe(200);
    const page = await get(`${prefix}/conversations/${topic.id}`);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(await page.text()).toContain(`<title>Trusted NAS bundle</title><script src="${prefix}/theme.js">`);
    expect(await (await fetch(urlOf(local.address) + "/")).text()).toContain("Local edition bundle");
    expect(await (await get(prefix + "/theme.js")).text()).toBe("/* Trusted NAS theme */");
    expect((await get(prefix + "/brain/mcp")).status).toBe(404);
    expect((await get(prefix + "/sw.js")).status).toBe(404);

    const socket = new WebSocket(urlOf(nas.address) + prefix + "/ws", { headers: { ...owner, origin: urlOf(nas.address) } });
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(ServerMessage.parse(JSON.parse(data.toString()))));
    await once(socket, "open", { signal: AbortSignal.timeout(4_000) });
    socket.send(JSON.stringify({ type: "watch", conversation: topic.id, snapshot: true }));
    await expect.poll(() => messages.some(({ type }) => type === "topic.detail")).toBe(true);
    expect((await post(`/api/conversations/${topic.id}/messages`, { text: requestMarker }, "https://unrelated.example")).status).toBe(403);
    expect((await post(`/api/conversations/${topic.id}/messages`, { text: requestMarker })).status).toBe(202);
    await expect.poll(() => messages.find((message) => message.type === "entry" && "text" in message.entry && message.entry.text === requestMarker)).toBeDefined();
    const detail = await get(`${prefix}/api/conversations/${topic.id}`);
    expect(detail.headers.get("cdn-cache-control")).toBe("no-store");
    expect(detail.headers.get("content-security-policy")).toContain("sandbox");
    const content = await detail.text();
    expect(content).toContain(responseMarker);
    expect(content).toContain(requestMarker);
    expect(await (await get("/api/conversations")).text()).not.toContain(topic.id);

    const repository = "demo/remote-test";
    const title = { en: "Run a remote test", zh: "运行远程测试" };
    const ticket = local.tickets.open({ kind: "feature", repository, title, summary: title, issues: [{ repository, number: 1, title, summary: title, url: `https://github.com/${repository}/issues/1` }] });
    local.machines.add({ name: "work-runner", accessClientId: "local-runner", system: "macos" });
    const machine = local.machines.get("work-runner")!;
    const link = local.runners.attach(machine, { send: () => undefined, close: () => undefined });
    const claude = startingEngineTable.claude.standard;
    link.receive({ type: "hello", protocol: protocolVersion, works: [], machine: {
      hostname: machine.name, platform: "darwin", arch: "arm64", release: "1", user: "owner", slots: { total: 1, free: 1 }, allowances: [],
      programs: [{ id: "claude", installed: true, path: null, version: null, source: "configuration", problem: null, models: [{ id: claude.model, efforts: [claude.effort] }] }],
    } });
    expect(local.chains.arranger.state([{
      ticket: ticket.id, kind: "feature", issues: [{ number: 1, difficulty: "standard" }], platform: "macos", reason: title, machine: machine.name, ownerEngine: "claude",
    }]).ok).toBe(true);
    const card = local.chains.cards().find((candidate) => candidate.ticket.id === ticket.id);
    expect(card).toBeDefined();
    expect((await post("/api/chains/start", { chains: [{ ticket: ticket.id, fingerprint: card!.fingerprint }] })).status).toBe(202);
    expect(nas.tickets.get(ticket.id)).toBeUndefined();

    const bytes = Buffer.from(fileMarker.repeat(22_000));
    const created = await post("/api/attachments", { name: "private.bin", size: bytes.length, mediaType: "application/octet-stream" });
    const { attachment } = await created.json() as { attachment: { id: string } };
    const file = `${prefix}/api/attachments/${attachment.id}`;
    const uploaded = await fetch(urlOf(nas.address) + file + "/upload?offset=0", {
      method: "PUT", headers: { ...owner, origin: urlOf(nas.address), "content-type": "application/octet-stream" }, body: bytes,
    });
    expect(uploaded.ok).toBe(true);
    const downloaded = await get(file);
    expect(downloaded.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    const range = await get(file, { ...owner, range: `bytes=0-${fileMarker.length - 1}` });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe(fileMarker);
    const head = await fetch(urlOf(nas.address) + file, { method: "HEAD", headers: owner });
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(await head.text()).toBe("");

    const closed = once(socket, "close", { signal: AbortSignal.timeout(4_000) });
    edge.cut();
    await closed;
    await expect.poll(async () => (await get(prefix + "/api/session")).status, { timeout: 4_000 }).toBe(200);
    await nas.close();
    nasStopped = true;
    nas = await startNas();
    nasStopped = false;
    await expect.poll(async () => (await get(prefix + "/api/session")).status, { timeout: 4_000 }).toBe(200);
    disconnect();
    await local.close();
    localStopped = true;
    await expect.poll(async () => (await get(prefix + "/api/session")).status, { timeout: 4_000 }).toBe(503);
    local = await startLocal();
    localStopped = false;
    disconnect = connect();
    await expect.poll(async () => (await get(prefix + "/api/session")).status, { timeout: 4_000 }).toBe(200);
    expect(await (await get(`${prefix}/api/conversations/${topic.id}`)).text()).toContain(requestMarker);

    const files = readdirSync(nasDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.some((entry) => entry.name === "hub.sqlite")).toBe(true);
    expect(files.some(({ parentPath }) => parentPath.startsWith(join(nasDir, "attachments")))).toBe(false);
    const traces = files.map((entry) => readFileSync(join(entry.parentPath, entry.name)));
    for (const privateText of [requestMarker, responseMarker, fileMarker, token, clientSecret]) {
      expect(traces.some((trace) => trace.includes(privateText))).toBe(false);
    }
    createPeerStore(nas.database).remove("work-laptop");
    expect((await get(prefix + "/api/session")).status).toBe(404);
  } finally {
    for (const socket of sockets) socket.terminate();
    disconnect?.();
    edge.close();
    if (!localStopped) await local.close();
    if (!nasStopped) await nas.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
