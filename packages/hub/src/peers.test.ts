import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentFile, type HubToBrain, type HubToRunner, ServerMessage, type StartCard, type Ticket, peerLinkPath, peerTokenHeader, protocolVersion, runnerTokenHeader, startingEngineTable } from "@super-agent2/protocol";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { assertionHeader } from "./access.js";
import { loadConfig } from "./config.js";
import { secretValues } from "./credentials.js";
import type { Hub } from "./hub.js";
import { createPeerQueue, sharedUpdateRepository } from "./peer-exchange.js";
import { chainStartPath } from "./server.js";
import { connectToPeer } from "./peer-link.js";
import { createPeerStore } from "./peer-store.js";
import { assertion, keySet, personClaims, serviceClaims, signingKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { callBrainTool } from "./testing/brain-tools.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { fakeForge, fakeGitHubBase } from "./testing/forge.js";
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
  let accepting = true;
  server.on("upgrade", (incoming, socket, head) => {
    if (!accepting || incoming.url !== peerLinkPath || incoming.headers["cf-access-client-id"] !== clientId
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
  return {
    url: urlOf(server.address() as AddressInfo), cut,
    setOnline: (online: boolean) => { accepting = online; if (!online) cut(); },
    close: () => { cut(); server.close(); },
  };
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

it("exchanges only approved general memories and principles with durable receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-peer-shared-"));
  const nasDir = join(directory, "nas");
  const localDir = join(directory, "local");
  const clock = new TestClock();
  const key = await signingKey("peer-sharing-test");
  const signedOwner = await assertion({ key, clock, claims: personClaims() });
  const signedPeer = await assertion({ key, clock, claims: { ...serviceClaims(), aud: [peerAudience], common_name: clientId } });
  const options = { clock, targets: [fakeTarget("hub")], credentials: testCredentials, environment: {} };
  const nas = await startTestHub({
    ...options, config: { ...testConfig(nasDir), accessPeerAudience: peerAudience },
    keySource: staticKeySource(keySet(key)),
  });
  const edge = await fakeEdge(() => nas, signedPeer);
  edge.setOnline(false);
  const localToken = createPeerStore(nas.database).add({ name: "work-laptop", clientId, accessTokenId: "sharing-token" });
  const startLocal = () => startTestHub({
    ...options, config: {
      dataDir: localDir, host: "127.0.0.1", port: 0, ownerEmail: "owner@local.invalid", projectFolders: [], brainTokenFile: join(localDir, "brain.token"),
      outboundPeer: { hub: edge.url, clientId, clientSecret, token: localToken },
    },
  });
  let local = await startLocal();
  let localClosed = false;
  const settle = (condition: () => unknown) => expect.poll(condition, { timeout: 9_000, interval: 70 });
  const queued = (hub: Hub) => hub.database.connection.prepare("SELECT target, item, id, payload FROM peer_outbox ORDER BY seq").all();
  const localWords = "你希望先列出已验证的结果。";
  const nasWords = "你希望发版说明用短句。";
  const privateWords = "公司专用系统编号 ABCDEF 一律留在本机。";
  const declinedWords = "你希望保留一条被拒过的偏好。";
  const removedWords = "你希望保留一条已删除的偏好。";
  const discardedWords = "你希望这条离线后撤回的建议。";
  const principle = "Keep retryable operations idempotent at their public entry point.";
  const memoryApi = (hub: Hub, path: string, body: object, method = "POST") => {
    const origin = urlOf(hub.address);
    return fetch(origin + "/api/memories" + path, {
      method, headers: { origin, "content-type": "application/json", ...(hub === nas ? { [assertionHeader]: signedOwner } : {}) },
      body: JSON.stringify(body),
    });
  };

  const nasBrain: HubToBrain[] = [];
  const brain = nas.conversations.attach({ send: (message) => nasBrain.push(message), close: () => undefined });
  brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
  try {
    expect(local.memories.snapshot().sharing).toBe(true);
    expect(nas.memories.snapshot().sharing).toBe(true);
    const legacy = nas.memories.add(nasWords);
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error("Could not seed legacy memory");
    const legacyId = legacy.list.memories[0]!.id;
    expect(queued(nas)).toEqual([]);
    expect((await memoryApi(nas, `/${legacyId}`, { text: nasWords, scope: "general" }, "PUT")).status).toBe(200);
    expect(local.memories.add(privateWords).ok).toBe(true);
    expect(local.memories.add(`你保存的密钥是 ${localToken}`, "general").ok).toBe(false);
    expect((await callBrainTool(local, "remember", { text: localWords, scope: "general" })).isError).toBe(false);
    const draft = local.memories.suggestions().find(({ text }) => text === localWords)!;
    expect(draft.scope).toBe("general");
    expect(queued(local)).toEqual([]);
    expect((await memoryApi(local, `/suggestions/${draft.id}/confirm`, { scope: "general" })).status).toBe(200);
    const firstDelivery = queued(local)[0]!;
    const discarded = local.memories.add(discardedWords, "general");
    if (!discarded.ok) throw new Error("Could not seed withdrawn memory");
    const discardedId = discarded.list.memories.find(({ text }) => text === discardedWords)!.id;
    expect(local.memories.edit(discardedId, privateWords, "local").ok).toBe(true);
    expect(JSON.stringify(queued(local))).not.toContain(privateWords);
    expect(JSON.stringify(queued(local))).not.toContain(discardedWords);

    const declined = nas.memories.remember({ text: declinedWords, conversation: null });
    if (!declined.ok) throw new Error("Could not seed declined memory");
    nas.memories.decline(declined.suggestion.id);
    const removed = nas.memories.add(removedWords);
    if (!removed.ok) throw new Error("Could not seed deleted memory");
    nas.memories.remove(removed.list.memories.find(({ text }) => text === removedWords)!.id);
    for (const words of [declinedWords, removedWords, nasWords]) expect(local.memories.add(words, "general").ok).toBe(true);

    expect((await callBrainTool(local, "propose_principle", { text: principle })).isError).toBe(false);
    const proposal = local.memories.suggestions().find(({ kind }) => kind === "principle")!;
    expect(local.memories.state().pending).not.toContainEqual(expect.objectContaining({ id: proposal.id }));
    expect(queued(local).some(({ payload }) => String(payload).includes(principle))).toBe(false);
    expect((await memoryApi(local, `/suggestions/${proposal.id}/confirm`, {})).status).toBe(200);
    expect(nasBrain.some((message) => message.type === "input" && message.input.text.includes(principle))).toBe(false);
    expect((await memoryApi(nas, "/suggestions/1/confirm", {}, "POST")).status).toBe(404);

    await local.close();
    localClosed = true;
    edge.setOnline(true);
    local = await startLocal();
    localClosed = false;

    await settle(() => queued(local).length + queued(nas).length).toBe(0);
    const fromLaptop = nas.memories.suggestions().find(({ text }) => text === localWords)!;
    const fromNas = local.memories.suggestions().find(({ text }) => text === nasWords);
    expect(fromLaptop).toMatchObject({ kind: "remember", scope: "general", origin: "work-laptop" });
    expect(fromNas).toBeUndefined();
    expect(nas.memories.suggestions().map(({ text }) => text)).toEqual([localWords]);
    expect(nas.memories.list().some(({ text }) => text === localWords)).toBe(false);
    expect((await memoryApi(nas, `/suggestions/${fromLaptop.id}/confirm`, {})).status).toBe(200);
    expect(nas.memories.list().find(({ text }) => text === localWords)?.origin).toBe("work-laptop");
    expect(queued(nas)).toEqual([]);

    const nasNew = "你希望每次复盘都列出可复验的证据。";
    expect((await memoryApi(nas, "", { text: nasNew, scope: "general" })).status).toBe(200);
    await settle(() => local.memories.suggestions().find(({ text }) => text === nasNew)?.origin).toBe("NAS");
    const nasSuggestion = local.memories.suggestions().find(({ text }) => text === nasNew)!;
    expect(local.memories.list().some(({ text }) => text === nasNew)).toBe(false);
    expect((await memoryApi(local, `/suggestions/${nasSuggestion.id}/confirm`, {})).status).toBe(200);
    expect(queued(local)).toEqual([]);

    const notice = nasBrain.find((message) => message.type === "input" && message.input.text.includes(principle));
    expect(notice).toMatchObject({ type: "input", input: { source: "hub", text: expect.stringContaining("docs/development-standard.md") } });
    if (notice?.type !== "input") throw new Error("The NAS brain did not receive the proposal");
    expect(nas.conversations.get(notice.conversation)?.repository).toBe("novan-xu/super-agent2");
    expect(nas.conversations.entries(notice.conversation)).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining(principle) }));

    local.database.connection.prepare("INSERT INTO peer_outbox (target, item, id, payload) VALUES (?, ?, ?, ?)")
      .run(firstDelivery.target!, firstDelivery.item!, firstDelivery.id!, firstDelivery.payload!);
    await settle(() => queued(local).length).toBe(0);
    expect(nas.memories.suggestions()).toEqual([]);
    expect(nas.memories.list().filter(({ text }) => text === localWords)).toHaveLength(1);

    const editedWords = "你希望先列出已验证的结果和对应证据。";
    const localId = local.memories.list().find(({ text }) => text === localWords)!.id;
    const remoteId = nas.memories.list().find(({ text }) => text === localWords)!.id;
    expect((await memoryApi(local, `/${localId}`, { text: editedWords, scope: "general" }, "PUT")).status).toBe(200);
    await settle(() => nas.memories.suggestions()).toContainEqual(expect.objectContaining({ text: editedWords, replaces: [remoteId] }));
    const replacement = nas.memories.suggestions().find(({ text }) => text === editedWords)!;
    expect((await memoryApi(nas, `/suggestions/${replacement.id}/confirm`, {})).status).toBe(200);
    expect(nas.memories.list().some(({ id }) => id === remoteId)).toBe(false);

    expect((await memoryApi(local, `/${localId}`, {}, "DELETE")).status).toBe(200);
    await settle(() => nas.memories.suggestions()).toContainEqual(expect.objectContaining({ kind: "forget", text: editedWords, origin: "work-laptop" }));
    expect(nas.memories.list().some(({ text }) => text === editedWords)).toBe(true);
    const removal = nas.memories.suggestions().find(({ kind }) => kind === "forget")!;
    expect((await memoryApi(nas, `/suggestions/${removal.id}/confirm`, {})).status).toBe(200);
    expect(nas.memories.list().some(({ text }) => text === editedWords)).toBe(false);
    expect(queued(nas)).toEqual([]);
  } finally {
    edge.close();
    if (!localClosed) await local.close();
    await nas.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 35_000);

it("queues merged revisions offline, combines pending build requests, and keeps start authorization local", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-peer-update-"));
  const nasDir = join(directory, "nas");
  const localDir = join(directory, "local");
  const clock = new TestClock();
  const key = await signingKey("peer-update-test");
  const signedOwner = await assertion({ key, clock, claims: personClaims() });
  const signedPeer = await assertion({ key, clock, claims: { ...serviceClaims(), aud: [peerAudience], common_name: clientId } });
  const repository = sharedUpdateRepository;
  const [old, running, first, unseen, second, third, latest] = (["0", "a", "b", "c", "d", "e", "f"] as const).map((digit) => digit.repeat(40)) as [
    string, string, string, string, string, string, string,
  ];
  const forge = fakeForge();
  forge.repository(repository).mainline.push(old, running);
  const recipe = { target: ["mac-mini", "pc"], deploy: "deploy", health: { command: "health" }, rollback: "rollback" };
  const options = { clock, targets: [fakeTarget("hub")], credentials: testCredentials, environment: {}, forgeFetch: forge.fetch, gitHubBase: fakeGitHubBase };
  const startNas = () => startTestHub({
    ...options, keySource: staticKeySource(keySet(key)),
    config: { ...testConfig(nasDir), accessPeerAudience: peerAudience, sourceRepository: repository, version: running },
  });
  let nas = await startNas();
  const edge = await fakeEdge(() => nas, signedPeer);
  edge.setOnline(false);
  const token = createPeerStore(nas.database).add({ name: "work-laptop", clientId, accessTokenId: "update-token" });
  const local = await startTestHub({
    ...options,
    localInstallation: { repository, checkout: localDir, commit: running, restart: () => { throw new Error("The fixture only approves the build"); } },
    config: {
      dataDir: localDir, host: "127.0.0.1", port: 0, ownerEmail: "owner@local.invalid", projectFolders: [], brainTokenFile: join(localDir, "brain.token"),
      outboundPeer: { hub: edge.url, clientId, clientSecret, token },
    },
  });
  const testTitle = { en: "Update the test project", zh: "更新测试项目" };
  const updates = (hub: Hub) => hub.tickets.list().filter((ticket) => ticket.form === "task");
  const queued = (hub: Hub) => hub.database.connection.prepare("SELECT payload FROM peer_outbox WHERE item LIKE 'update:%' ORDER BY seq")
    .all().map(({ payload }) => JSON.parse(String(payload)) as { commit: string });
  const start = (hub: Hub, card: StartCard) => fetch(urlOf(hub.address) + chainStartPath, {
    method: "POST", headers: { origin: urlOf(hub.address), "content-type": "application/json", ...(hub === nas ? { [assertionHeader]: signedOwner } : {}) },
    body: JSON.stringify({ chains: [{ ticket: card.ticket.id, fingerprint: card.fingerprint }] }),
  });
  const cardFor = (hub: Hub, ticket: Ticket) => hub.chains.cards().find((card) => card.ticket.id === ticket.id)!;
  function attach(hub: Hub, name: string) {
    const stored = hub.machines.get(name) ?? hub.machines.add({ name, accessClientId: name }).machine;
    const sent: HubToRunner[] = [];
    const link = hub.runners.attach(stored, { send: (message) => sent.push(message), close: () => undefined });
    const codex = startingEngineTable.codex.mechanical;
    link.receive({ type: "hello", protocol: protocolVersion, works: [], machine: {
      hostname: name, platform: name === "local" ? "win32" : "darwin", arch: "x64", release: "1", user: "owner", slots: { total: 2, free: 2 }, allowances: [],
      programs: [{ id: "codex", installed: true, path: null, version: null, source: "configuration", problem: null, models: [{ id: codex.model, efforts: [codex.effort] }] }],
    } });
    return { sent, link };
  }
  async function merge(hub: Hub, number: number, commit: string, repo = repository, target: string | string[] = recipe.target) {
    const branch = `sa2/peer-update-${number}`;
    const head = `head-${number}`;
    const pull = forge.pull(repo, number, head, ["docs/local.md"], branch, [number]);
    pull.open = false;
    pull.merged = true;
    pull.mergeCommit = commit;
    forge.repository(repo).issues.set(number, "open");
    forge.repository(repo).mainline.push(commit);
    forge.file(repo, commit, deploymentFile, JSON.stringify({ ...recipe, target }));
    const ticket = hub.tickets.open({
      repository: repo, kind: "feature", title: testTitle, summary: testTitle,
      issues: [{ repository: repo, number, title: testTitle, summary: testTitle, url: `https://github.com/${repo}/issues/${number}` }],
    });
    hub.tickets.change((writes) => {
      writes.choose(ticket.id, { machine: hub === nas ? "mac-mini" : "local", engine: "claude", model: "claude", effort: "high", by: { machine: "default", engine: "default", model: "default", effort: "default" } });
      writes.move(ticket.id, "working");
      writes.setBranch(ticket.id, branch);
      writes.setPullRequest(ticket.id, number, testTitle);
      writes.move(ticket.id, "verifying");
    });
    await hub.verification.check(ticket.id);
    expect(hub.tickets.get(ticket.id)?.state).toBe("merged");
  }
  function waitFor(hub: Hub, commit: string): Promise<Ticket> {
    return new Promise((resolve) => {
      const unsubscribe = hub.tickets.subscribe((ticket) => {
        if (ticket.form === "task" && ticket.commit === commit) {
          unsubscribe();
          resolve(ticket);
        }
      });
    });
  }

  try {
    const localRunner = attach(local, "local");
    nas.machines.add({ name: "mac-mini", accessClientId: "mini" });
    await merge(nas, 1, first);
    forge.repository(repository).mainline.push(unseen);
    await merge(nas, 2, second);
    await merge(nas, 3, "1".repeat(40), "owner/unrelated");
    expect(queued(nas).map(({ commit }) => commit)).toEqual([first, second]);
    expect(updates(local)).toEqual([]);

    await nas.close();
    nas = await startNas();
    expect(queued(nas).map(({ commit }) => commit)).toEqual([first, second]);
    const firstCard = waitFor(local, first).then((ticket) => cardFor(local, ticket));
    const newest = waitFor(local, second);
    edge.setOnline(true);
    const outdated = await firstCard;
    const build = await newest;
    expect(updates(local)).toMatchObject([{
      id: outdated.ticket.id, commitRef: second, commit: second, state: "pending", requiredMachine: "local",
      localBuild: true, waits: [], title: { zh: "更新本地版（来自 NAS）" },
    }]);
    expect(local.conversations.entries(build.conversation!)).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining(second.slice(0, 7)) }));
    expect(localRunner.sent.filter(({ type }) => type === "work.task")).toEqual([]);
    expect((await start(local, outdated)).status).toBe(409);
    const record = () => { throw new Error("An older revision would change the card"); };
    expect(await local.taskTickets.peerUpdate({ commit: unseen, running, previous: { commit: second, ticket: build.id }, record })).toBe("ignored");
    expect(await local.taskTickets.peerUpdate({ commit: old, running, record })).toBe("ignored");
    const startedBuild = await start(local, cardFor(local, build));
    expect(startedBuild.status, await startedBuild.text()).toBe(202);
    await local.chains.idle();
    expect(localRunner.sent).toContainEqual(expect.objectContaining({ type: "work.task", task: expect.objectContaining({
      ticket: build.id, localBuild: true, checkout: expect.objectContaining({ commit: second, ref: null }),
    }) }));
    expect(queued(local)).toEqual([]);

    const nasRunner = attach(nas, "mac-mini");
    const deploymentArrived = waitFor(nas, third);
    await merge(local, 4, third);
    const deployment = await deploymentArrived;
    expect(updates(nas)).toMatchObject([{
      id: deployment.id, commit: third, state: "pending", deploymentTargets: ["mac-mini", "pc"],
      waits: [], title: { zh: "部署 Super Agent（来自本地版）" },
    }]);
    expect(nas.conversations.entries(deployment.conversation!)).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining("来自本地版") }));
    expect(nasRunner.sent.filter(({ type }) => type === "work.task")).toEqual([]);
    const newDeployment = waitFor(nas, latest);
    await merge(local, 5, latest, repository, "mac-mini");
    await newDeployment;
    expect(updates(nas)).toMatchObject([{
      id: deployment.id, commit: latest, state: "pending", requiredMachine: "mac-mini",
    }]);
    expect(updates(nas)[0]?.deploymentTargets).toBeUndefined();
    const startedDeployment = await start(nas, cardFor(nas, deployment));
    expect(startedDeployment.status, await startedDeployment.text()).toBe(202);
    await nas.chains.idle();
    expect(nasRunner.sent).toContainEqual(expect.objectContaining({ type: "work.task", task: expect.objectContaining({
      ticket: deployment.id, deploys: true, checkout: expect.objectContaining({ commit: latest, ref: null }),
    }) }));
    const delivered = new Promise<void>((resolve) => {
      const unsubscribe = nas.tickets.subscribe((ticket) => {
        if (ticket.id === deployment.id && ticket.deployedAt !== null) { unsubscribe(); resolve(); }
      });
    });
    nasRunner.link.receive({ type: "work.event", ticket: deployment.id, attempt: 1, seq: 1, at: clock.now(),
      event: { kind: "delivered", commit: latest, text: null, files: [], report: testTitle } });
    await delivered;
    expect(queued(nas)).toEqual([]);
    expect(updates(local)).toHaveLength(1);
  } finally {
    edge.close();
    await local.close();
    await nas.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps update deliveries queued while a peer without update support receives memories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-peer-compatibility-"));
  const hub = await startTestHub({ config: {
    dataDir: directory, host: "127.0.0.1", port: 0, ownerEmail: "owner@local.invalid", projectFolders: [], brainTokenFile: join(directory, "brain.token"),
  } });
  try {
    const queue = createPeerQueue(hub.database, () => ["peer"]);
    queue.enqueue({ kind: "update", repository: sharedUpdateRepository, commit: "a".repeat(40) });
    queue.enqueue({ kind: "remember", item: 1, text: "A general preference." });
    const memory = queue.next("peer", false);
    expect(memory?.payload.kind).toBe("remember");
    queue.acknowledge("peer", memory!.id);
    expect(queue.next("peer", false)).toBeUndefined();
    expect(queue.next("peer", true)?.payload.kind).toBe("update");
  } finally {
    await hub.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
