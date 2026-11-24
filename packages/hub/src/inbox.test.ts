import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentPartBytes, brainToolsPath, conversationHeader, turnHeader } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPushDevice, receivePush } from "./push-device.js";
import { generateVapidKeys } from "./push.js";
import type { Hub } from "./hub.js";
import { assertion, issuer, keySet, personClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { attachBrain, requestBrainTool, startToolTurn } from "./testing/brain-tools.js";
import { startTestHub } from "./testing/http.js";

const inboxAudience = "c".repeat(64);
const runnerAudience = "b".repeat(64);
const mcpAudience = "d".repeat(64);
let directory: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub;
let removed: string[];
let failRemoval: boolean;
let pushes: Buffer[];
let ownerAssertion: string;
let inboxAssertion: string;
let tokens: number;

function launch({ oauth = true, inbox = true } = {}) {
  const vapid = generateVapidKeys();
  return startTestHub({
    config: { ...testConfig(directory), accessRunnerAudience: runnerAudience, vapid,
      ...(inbox ? { accessInboxAudience: inboxAudience } : {}), ...(oauth ? { accessMcpAudience: mcpAudience } : {}) },
    keySource: staticKeySource(keySet(key)), clock, targets: [fakeTarget("hub")], credentials: testCredentials,
    gate: () => ({ kind: "allow" }), report: () => undefined,
    inboxServiceTokens: { create: async () => { tokens += 1; return { id: `token-${tokens}`, clientId: tokens === 1 ? "source.access" : `source-${tokens}.access`, clientSecret: "secret", expiresAt: null }; }, remove: async (id) => { if (failRemoval) throw new Error("offline"); removed.push(id); } },
    pushFetch: async (_url, init) => { pushes.push(Buffer.from(init?.body as Uint8Array)); return new Response(null, { status: 201 }); },
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hub-inbox-"));
  clock = new TestClock();
  key = await signingKey("inbox-key");
  removed = []; pushes = []; failRemoval = false; tokens = 0;
  hub = await launch();
  ownerAssertion = await assertion({ key, clock });
  inboxAssertion = await serviceAssertion("source.access");
});
afterEach(async () => { await hub?.close(); rmSync(directory, { recursive: true, force: true }); });

const base = () => `http://127.0.0.1:${hub.address.port}`;
async function owner(path: string, body?: unknown) {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: base(), "content-type": "application/json", "cf-access-jwt-assertion": ownerAssertion }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function post(token: string | undefined, body: unknown = { text: "hello" }, headers: Record<string, string> = {}) {
  return fetch(`${base()}/inbox/message`, { method: "POST", headers: { ...(token === undefined ? {} : { "cf-access-jwt-assertion": token }), ...headers }, body: JSON.stringify(body) });
}
async function create(name = "shortcut") {
  const result = await owner("/api/inbox/sources", { name });
  expect(result.status).toBe(201);
  return await result.json() as { id: string; clientId: string; clientSecret: string };
}

function serviceAssertion(client: string) {
  return assertion({ key, clock, claims: { iss: issuer, aud: [inboxAudience], common_name: client, sub: "", type: "app" } });
}

function mcp(token: string | null, body: unknown, headers: Record<string, string> = {}, path = "/inbox/mcp") {
  return fetch(`${base()}${path}`, { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(token === null ? {} : { "cf-access-jwt-assertion": token }), ...headers,
  }, body: JSON.stringify(body) });
}

async function call(name: string, args: unknown, token = inboxAssertion, path = "/inbox/mcp") {
  const response = await mcp(token, { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name, arguments: args } }, { "mcp-protocol-version": "2025-11-25" }, path);
  expect(response.status).toBe(200);
  const { id, result } = await response.json() as { id: string; result: { isError?: boolean; content: { text: string }[] } };
  expect(id).toBe("call");
  const text = result.content[0]!.text;
  return result.isError ? { error: text } : { data: JSON.parse(text) as Record<string, unknown> };
}

async function transfers() {
  return await (await owner("/api/transfer")).json() as { items: { seq: number; text: string; title?: string; files: { id: string; name: string; size: number; mediaType: string }[] }[] };
}

describe("inbox", () => {
  it("isolates audiences and only accepts known, active service tokens", async () => {
    const source = await create();
    expect(source).toMatchObject({ clientId: "source.access", clientSecret: "secret" });
    const ownerOnInbox = await assertion({ key, clock, claims: { ...personClaims(), aud: [inboxAudience] } });
    const runner = await assertion({ key, clock, claims: { iss: issuer, aud: [runnerAudience], common_name: "source.access", sub: "", type: "app" } });
    const unknown = await assertion({ key, clock, claims: { iss: issuer, aud: [inboxAudience], common_name: "unknown.access", sub: "", type: "app" } });
    for (const token of [undefined, ownerAssertion, ownerOnInbox, runner, unknown]) expect((await post(token)).status).toBe(403);
    expect((await fetch(`${base()}/api/session`, { headers: { "cf-access-jwt-assertion": inboxAssertion } })).status).toBe(403);
    expect((await owner(`/api/inbox/sources/${source.id}/revoke`, {})).status).toBe(200);
    expect(removed).toEqual(["token-1"]);
    expect((await post(inboxAssertion)).status).toBe(403);
  });

  it("stores and pushes a source message without starting a turn, and reopens the same archived topic", async () => {
    await create();
    const device = createPushDevice();
    expect(hub.push?.subscribe({ endpoint: "https://push.example.net/abc", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: hub.push.publicKey }, "https://hub.example.com")).toBe("saved");
    const first = await post(inboxAssertion, { text: "hello", title: "Report", link: "https://example.com" }, { "Idempotency-Key": "one" });
    expect(first.status).toBe(202);
    const entry = await first.json() as { id: string };
    const topic = hub.conversations.list().find((item) => item.title === "shortcut")!;
    expect(hub.conversations.entries(topic.id)).toEqual([expect.objectContaining({ id: entry.id, kind: "notice", source: "shortcut", text: "Report\n\nhello\n\nhttps://example.com" })]);
    expect(hub.conversations.topics.recent(topic.id, Number.MAX_SAFE_INTEGER, 10).messages).toEqual([expect.objectContaining({ id: entry.id, preview: "[shortcut] Report" })]);
    expect(hub.conversations.topics.search("hello", topic.id, Number.MAX_SAFE_INTEGER, 10).messages).toEqual([expect.objectContaining({ id: entry.id })]);
    expect(hub.database.connection.prepare("SELECT count(*) AS n FROM turns").get()?.["n"]).toBe(0);
    await hub.push?.idle();
    expect(JSON.parse(receivePush(device, pushes[0]!))).toMatchObject({ title: "shortcut", body: "hello", url: `/conversations/${topic.id}?scope=daily` });
    expect((await post(inboxAssertion, { text: "hello", title: "Report", link: "https://example.com" }, { "Idempotency-Key": "one" })).status).toBe(202);
    expect((await post(inboxAssertion, { text: "different" }, { "Idempotency-Key": "one" })).status).toBe(409);
    expect(hub.conversations.entries(topic.id)).toHaveLength(1);
    expect(hub.conversations.archive(topic.id).ok).toBe(true);
    expect((await post(inboxAssertion, { text: "again" })).status).toBe(202);
    expect(hub.conversations.get(topic.id)?.topicState).toBe("active");
    expect(hub.conversations.entries(topic.id)).toHaveLength(2);
  });

  it("refuses a revoked source even when Cloudflare cannot delete its token", async () => {
    const source = await create();
    failRemoval = true;
    const response = await owner(`/api/inbox/sources/${source.id}/revoke`, {});
    expect(await response.json()).toEqual({ removed: false });
    expect((await post(inboxAssertion)).status).toBe(403);
  });

  it("validates and limits messages per source", async () => {
    await create();
    expect((await post(inboxAssertion, { text: "" })).status).toBe(400);
    expect((await post(inboxAssertion, { text: "x".repeat(16001) })).status).toBe(400);
    for (let i = 0; i < 60; i++) expect((await post(inboxAssertion, { text: `message ${i}` })).status).toBe(202);
    expect((await post(inboxAssertion)).status).toBe(429);
    clock.advance(60001);
    expect((await post(inboxAssertion)).status).toBe(202);
  });
});

describe("inbox MCP transfers", () => {
  it("negotiates Streamable HTTP and lists tools only for valid active inbox sources", async () => {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await mcp(inboxAssertion, list)).status).toBe(403);
    const source = await create();
    const ownerOnInbox = await assertion({ key, clock, claims: { ...personClaims(), aud: [inboxAudience] } });
    const runner = await assertion({ key, clock, claims: { iss: issuer, aud: [runnerAudience], common_name: source.clientId, sub: "", type: "app" } });
    for (const token of [null, ownerAssertion, ownerOnInbox, runner, await serviceAssertion("unknown.access")]) {
      expect((await mcp(token, list)).status).toBe(403);
    }
    expect((await mcp(inboxAssertion, list, { origin: "https://other.example" })).status).toBe(403);
    expect((await mcp(inboxAssertion, list, { "mcp-protocol-version": "unsupported" })).status).toBe(400);
    const initial = await mcp(inboxAssertion, { jsonrpc: "2.0", id: 0, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0" },
    } });
    expect(await initial.json()).toMatchObject({ id: 0, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    expect(initial.headers.has("mcp-session-id")).toBe(false);
    expect((await mcp(inboxAssertion, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await fetch(`${base()}/inbox/mcp`, { headers: { "cf-access-jwt-assertion": inboxAssertion, accept: "text/event-stream" } })).status).toBe(405);
    const listed = await mcp(inboxAssertion, list, { "mcp-protocol-version": "2025-06-18" });
    const { result } = await listed.json() as { result: { tools: { name: string }[] } };
    expect(result.tools.map(({ name }) => name)).toEqual(["send_files", "begin_upload", "upload_part", "finish_upload"]);
    failRemoval = true;
    await owner(`/api/inbox/sources/${source.id}/revoke`, {});
    expect((await mcp(inboxAssertion, list)).status).toBe(403);
  });

  it("publishes byte-identical files once, labels and pushes the transfer, and keeps it out of topics", async () => {
    await create("desktop-agent");
    const device = createPushDevice();
    expect(hub.push?.subscribe({ endpoint: "https://push.example.net/abc", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: hub.push.publicKey }, "https://hub.example.com")).toBe("saved");
    const bytes = Buffer.from([0, 200, 255]);
    const args = { idempotency_key: "one", note: "  Report ready  ", files: [
      { name: "report.bin", content_base64: bytes.toString("base64") },
      { name: "empty.txt", media_type: "text/plain", content_base64: "" },
    ] };
    const sends = await Promise.all([call("send_files", args), call("send_files", args)]);
    const { items } = await transfers();
    expect(items).toHaveLength(1);
    const entry = items[0]!;
    expect(entry).toMatchObject({ title: "desktop-agent", text: args.note, files: [{ name: "report.bin", size: 3 }, { name: "empty.txt", size: 0, mediaType: "text/plain" }] });
    expect(sends).toEqual(Array(2).fill({ data: { entry_id: entry.seq, files: ["report.bin", "empty.txt"] } }));
    expect(await call("send_files", { ...args, note: "different" })).toHaveProperty("error", expect.stringContaining("already in use"));
    expect(Buffer.from(await (await owner(`/api/transfer/files/${entry.files[0]!.id}`)).arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${base()}/api/transfer/files/${entry.files[0]!.id}`, { headers: { "cf-access-jwt-assertion": inboxAssertion } })).status).toBe(403);
    await hub.push?.idle();
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(receivePush(device, pushes[0]!))).toMatchObject({ title: "desktop-agent", body: "report.bin, empty.txt", url: "/transfer" });
    for (const table of ["conversation_entries", "turns"]) {
      expect(hub.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect((await fetch(`${base()}/api/transfer/${entry.seq}`, { method: "DELETE", headers: { origin: base(), "cf-access-jwt-assertion": ownerAssertion } })).status).toBe(200);
    expect(await call("send_files", args)).toEqual(sends[0]);
    expect((await transfers()).items).toEqual([]);
  });

  it("uploads a 100 MiB file in bounded, replayable parts and exposes it only after finish", async () => {
    await create();
    const key = { idempotency_key: "big" };
    const maximum = 100 * 1024 * 1024;
    const manifest = { ...key, files: [{ name: "large.bin", size: maximum }] };
    expect(await call("begin_upload", manifest)).toEqual({ data: { completed: false, files: [{ name: "large.bin", received: 0 }] } });
    const staged = hub.database.connection.prepare("SELECT file FROM inbox_transfer_files").get()?.["file"];
    expect(typeof staged).toBe("string");
    expect((await owner(`/api/transfer/files/${staged}/upload`)).status).toBe(404);
    expect((await owner("/api/transfer", { text: "", device: "phone", files: [staged] })).status).toBe(409);
    expect(await call("finish_upload", key)).toHaveProperty("error", expect.stringContaining("has not finished"));
    expect(await call("upload_part", { ...key, file_index: 0, offset: 1, content_base64: "AA==" })).toHaveProperty("error", expect.stringContaining("byte offset 0"));
    const hash = createHash("sha256");
    for (let offset = 0; offset < maximum; offset += attachmentPartBytes) {
      const data = Buffer.alloc(Math.min(attachmentPartBytes, maximum - offset), offset / attachmentPartBytes);
      hash.update(data);
      const args = { ...key, file_index: 0, offset, content_base64: data.toString("base64") };
      expect(await call("upload_part", args)).toEqual({ data: { received: offset + data.length } });
      if (offset === 0) {
        expect(await call("upload_part", { ...args, content_base64: "AA==" })).toEqual({ data: { received: attachmentPartBytes } });
        expect(await call("upload_part", { ...args, content_base64: "AQ==" })).toHaveProperty("error", expect.stringContaining("identical bytes"));
        expect(await call("begin_upload", manifest)).toEqual({ data: { completed: false, files: [{ name: "large.bin", received: attachmentPartBytes }] } });
      }
    }
    expect((await transfers()).items).toEqual([]);
    expect(await call("upload_part", { ...key, file_index: 0, offset: maximum, content_base64: "AA==" })).toHaveProperty("error", expect.stringContaining("declared file size"));
    const finished = await call("finish_upload", key);
    expect(await call("finish_upload", key)).toEqual(finished);
    expect(await call("begin_upload", manifest)).toEqual({ data: { completed: true, ...finished.data } });
    const { items } = await transfers();
    expect(items).toHaveLength(1);
    expect(items[0]!.files).toMatchObject([{ id: staged, size: maximum }]);
    const response = await owner(`/api/transfer/files/${staged}`);
    expect(response.status).toBe(200);
    const download = createHash("sha256");
    for await (const chunk of response.body!) download.update(chunk);
    expect(download.digest("hex")).toBe(hash.digest("hex"));
  });

  it("validates limits, isolates source keys and bounds abandoned uploads", async () => {
    await create();
    const other = await serviceAssertion((await create("other")).clientId);
    const one = { idempotency_key: "same", files: [{ name: "file", size: 1 }] };
    expect(await call("begin_upload", { ...one, files: Array(31).fill(one.files[0]) })).toHaveProperty("error", expect.stringContaining("at most 30 files"));
    expect(await call("begin_upload", { ...one, files: [{ name: "file", size: 100 * 1024 * 1024 + 1 }] })).toHaveProperty("error", expect.stringContaining("at most 100 MiB"));
    expect(await call("send_files", { ...one, files: [{ name: "file", content_base64: "a?==" }] })).toHaveProperty("error", expect.stringContaining("padded base64"));
    const inline = { name: "file", content_base64: Buffer.alloc(600 * 1024).toString("base64") };
    expect(await call("send_files", { ...one, files: [inline, inline] })).toHaveProperty("error", expect.stringContaining("at most 1 MiB in total"));
    expect(await call("begin_upload", one)).toHaveProperty("data.completed", false);
    expect(await call("finish_upload", { idempotency_key: "same" }, other)).toHaveProperty("error", expect.stringContaining("No active upload"));
    expect(await call("begin_upload", one, other)).toHaveProperty("data.completed", false);
    expect(await call("begin_upload", { ...one, idempotency_key: "second" })).toHaveProperty("data.completed", false);
    expect(await call("begin_upload", { ...one, idempotency_key: "third" })).toHaveProperty("error", expect.stringContaining("two pending uploads"));
    clock.advance(24 * 60 * 60 * 1000);
    inboxAssertion = await serviceAssertion("source.access");
    expect(await call("finish_upload", { idempotency_key: "same" })).toHaveProperty("error", expect.stringContaining("No active upload"));
    expect(await call("begin_upload", { ...one, idempotency_key: "third" })).toHaveProperty("data.completed", false);
    expect(hub.database.connection.prepare("SELECT count(*) AS n FROM transfer_files").get()).toEqual({ n: 1 });
  });

  it("resumes pending parts and replays completed receipts after a hub restart", async () => {
    await create();
    const inline = { idempotency_key: "inline", files: [{ name: "empty.txt", content_base64: "" }] };
    const receipt = await call("send_files", inline);
    const upload = { idempotency_key: "pending", files: [{ name: "pending.bin", size: 2 }] };
    await call("begin_upload", upload);
    const part = { idempotency_key: upload.idempotency_key, file_index: 0, offset: 0, content_base64: "AA==" };
    expect(await call("upload_part", part)).toEqual({ data: { received: 1 } });
    await hub.close();
    hub = await launch();
    expect(await call("send_files", inline)).toEqual(receipt);
    expect(await call("begin_upload", upload)).toEqual({ data: { completed: false, files: [{ name: "pending.bin", received: 1 }] } });
    expect(await call("upload_part", { ...part, offset: 1 })).toEqual({ data: { received: 2 } });
    expect(await call("finish_upload", { idempotency_key: upload.idempotency_key })).toHaveProperty("data.entry_id");
    expect((await transfers()).items).toHaveLength(2);
  });

  it("limits new sends per source without charging retries", async () => {
    await create();
    const other = await serviceAssertion((await create("other")).clientId);
    const args = (i: number) => ({ idempotency_key: String(i), files: [{ name: "empty.txt", content_base64: "" }] });
    const original = await call("send_files", args(0));
    for (let i = 1; i < 60; i++) expect(await call("send_files", args(i))).toHaveProperty("data.entry_id");
    expect(await call("send_files", args(60))).toHaveProperty("error", expect.stringContaining("60 sends per minute"));
    expect(await call("send_files", args(0))).toEqual(original);
    expect(await call("send_files", args(0), other)).toHaveProperty("data.entry_id");
    clock.advance(60_000);
    expect(await call("send_files", args(60))).toHaveProperty("data.entry_id");
  });

  it("gates brain access on an owner turn and copies only the requested file", async () => {
    await create();
    await call("send_files", { idempotency_key: "files", note: "private note", files: [
      { name: "report.txt", content_base64: "aGVsbG8=", media_type: "text/plain" },
      { name: "sibling.txt", content_base64: "d29ybGQ=" },
    ] });
    const { attachment: phone } = await (await owner("/api/transfer/files", { name: "report-phone.txt", size: 0, mediaType: "text/plain" })).json() as { attachment: { id: string } };
    expect((await owner("/api/transfer", { text: "", device: "phone", files: [phone.id] })).status).toBe(201);
    const { items } = await transfers();
    expect(items).toHaveLength(2);
    const { seq, files } = items[0]!;
    const device = items[1]!;
    const file = files[0]!;
    const lookup = { owner_requested: true, name: "REPORT" };
    const read = { owner_requested: true, entry_id: seq, file_id: file.id };
    const brain = attachBrain(hub);
    const conversation = hub.conversations.create().id;
    const background = startToolTurn(brain, conversation);
    const list = async (turn: string) => {
      const response = await fetch(`${base()}${brainToolsPath}`, { method: "POST", headers: {
        authorization: `Bearer ${readFileSync(join(directory, "brain.token"), "utf8").trim()}`, "content-type": "application/json",
        [conversationHeader]: conversation, [turnHeader]: turn,
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const { result } = await response.json() as { result: { tools: { name: string }[] } };
      return result.tools.map(({ name }) => name);
    };
    expect(await list(background.turn)).not.toContain("transfer_read");
    expect(await requestBrainTool(hub, "transfer_lookup", lookup)).toHaveProperty("isError", true);
    expect(await requestBrainTool(hub, "transfer_read", read, background)).toHaveProperty("isError", true);
    brain.receive({ type: "turn.finished", ...background, outcome: "completed", reason: null });
    const entry = hub.conversations.send(conversation, "Read the transferred report.txt.")!;
    const scope = { conversation, turn: randomUUID() };
    brain.receive({ type: "turn.started", ...scope, provider: "gpt", model: "test", inputs: [entry.id] });
    expect(await list(scope.turn)).toEqual(expect.arrayContaining(["transfer_lookup", "transfer_read"]));
    expect(await requestBrainTool(hub, "transfer_lookup", { name: "report" }, scope)).toHaveProperty("isError", true);
    expect(await requestBrainTool(hub, "transfer_read", { ...read, owner_requested: false }, scope)).toHaveProperty("isError", true);
    const match = await requestBrainTool(hub, "transfer_lookup", lookup, scope);
    expect(JSON.parse(match.text)).toEqual({ entries: [
      { entry_id: device.seq, source: "phone", at: expect.any(Number), files: [{ id: phone.id, name: "report-phone.txt", mediaType: "text/plain", size: 0 }] },
      { entry_id: seq, source: "shortcut", at: clock.now(), files: [file] },
    ] });
    const filtered = await requestBrainTool(hub, "transfer_lookup", { ...lookup, source: "SHORTCUT", since: clock.now() }, scope);
    expect(JSON.parse(filtered.text).entries).toHaveLength(1);
    expect(await requestBrainTool(hub, "transfer_read", { ...read, entry_id: device.seq }, scope)).toHaveProperty("isError", true);
    expect(hub.database.connection.prepare("SELECT count(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    const result = await requestBrainTool(hub, "transfer_read", read, scope);
    expect(result.isError).toBe(false);
    const { attachment, path } = JSON.parse(result.text) as { attachment: typeof file; path: string };
    expect(attachment).toEqual({ ...file, id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(attachment.id).not.toBe(file.id);
    expect(hub.attachments.choose([attachment.id])).toEqual({ ok: true, attachments: [attachment] });
    expect(readdirSync(hub.attachments.root)).toEqual([attachment.id]);
    expect(readFileSync(path, "utf8")).toBe("hello");
    brain.receive({ type: "turn.finished", ...scope, outcome: "completed", reason: null });
    expect(await requestBrainTool(hub, "transfer_read", read, scope)).toHaveProperty("isError", true);
  });
});

describe("OAuth MCP transfers", () => {
  const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const oauthAssertion = (claims = personClaims()) => assertion({ key, clock, claims: { ...claims, aud: [mcpAudience] } });

  it("accepts only owner assertions for the MCP application", async () => {
    const source = await create();
    const token = await oauthAssertion();
    const nonOwner = await oauthAssertion(personClaims("other@example.net"));
    const mcpService = await oauthAssertion({ iss: issuer, common_name: source.clientId, sub: "", type: "app" });
    const runner = await assertion({ key, clock, claims: { ...personClaims(), aud: [runnerAudience] } });
    for (const refused of [null, ownerAssertion, inboxAssertion, runner, nonOwner, mcpService]) {
      expect((await mcp(refused, listTools, {}, "/mcp")).status).toBe(403);
    }
    expect((await mcp(null, listTools, { authorization: `Bearer ${token}`, cookie: `CF_Authorization=${token}` }, "/mcp")).status).toBe(403);
    expect((await mcp(token, listTools, { origin: "https://elsewhere.example" }, "/mcp")).status).toBe(403);
    const listed = await mcp(token, listTools, {}, "/mcp");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual(await (await mcp(inboxAssertion, listTools)).json());
    expect((await mcp(token, listTools)).status).toBe(403);
    expect((await post(token)).status).toBe(403);
    expect((await fetch(`${base()}/api/transfer`, { headers: { "cf-access-jwt-assertion": token } })).status).toBe(403);
    expect(await (await owner("/api/inbox/sources")).json()).toEqual({ sources: [{ id: source.id, name: "shortcut" }] });
  });

  it("can be disabled and can be enabled independently of the service-token inbox", async () => {
    await hub.close();
    hub = await launch({ oauth: false });
    const token = await oauthAssertion();
    await create();
    expect((await mcp(token, listTools, {}, "/mcp")).status).toBe(404);
    expect((await mcp(inboxAssertion, listTools)).status).toBe(200);
    await hub.close();
    hub = await launch({ inbox: false });
    expect((await mcp(token, listTools, {}, "/mcp")).status).toBe(200);
    expect((await mcp(inboxAssertion, listTools)).status).toBe(404);
    expect((await owner("/api/inbox/sources")).status).toBe(503);
  });

  it("publishes and pushes inline and multipart transfers once with the OAuth source", async () => {
    const token = await oauthAssertion();
    const send = (name: string, args: unknown) => call(name, args, token, "/mcp");
    const device = createPushDevice();
    expect(hub.push?.subscribe({ endpoint: "https://push.example.net/oauth", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: hub.push.publicKey }, "https://hub.example.com")).toBe("saved");
    const bytes = Buffer.from([0, 200, 255]);
    const inline = { idempotency_key: "inline", note: "Report ready", files: [{ name: "inline.bin", content_base64: bytes.toString("base64") }] };
    const sent = await send("send_files", inline);
    expect(sent).toHaveProperty("data.entry_id");
    expect(await send("send_files", inline)).toEqual(sent);
    const upload = { idempotency_key: "multipart" };
    expect(await send("begin_upload", { ...upload, files: [{ name: "multipart.bin", size: bytes.length }] })).toHaveProperty("data.completed", false);
    expect(await send("upload_part", { ...upload, file_index: 0, offset: 0, content_base64: bytes.toString("base64") })).toEqual({ data: { received: bytes.length } });
    const finished = await send("finish_upload", upload);
    expect(finished).toHaveProperty("data.entry_id");
    expect(await send("finish_upload", upload)).toEqual(finished);
    const { items } = await transfers();
    expect(items).toHaveLength(2);
    for (const [name, note] of [["inline.bin", inline.note], ["multipart.bin", ""]]) {
      const entry = items.find(({ files }) => files[0]?.name === name)!;
      expect(entry).toMatchObject({ title: "OAuth MCP", text: note, files: [{ name, size: bytes.length }] });
      const file = await owner(`/api/transfer/files/${entry.files[0]!.id}`);
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    }
    await hub.push?.idle();
    expect(pushes.map((push) => JSON.parse(receivePush(device, push)))).toEqual([
      expect.objectContaining({ title: "OAuth MCP", body: "inline.bin", url: "/transfer" }),
      expect.objectContaining({ title: "OAuth MCP", body: "multipart.bin", url: "/transfer" }),
    ]);
    for (const table of ["conversation_entries", "turns"]) {
      expect(hub.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it("shares transfer limits across OAuth assertions with a separate budget and keys from service tokens", async () => {
    await create();
    const token = await oauthAssertion();
    const send = (name: string, args: unknown) => call(name, args, token, "/mcp");
    const upload = { idempotency_key: "pending", files: [{ name: "file", size: 1 }] };
    expect(await send("begin_upload", { ...upload, files: Array(31).fill(upload.files[0]) })).toHaveProperty("error", expect.stringContaining("at most 30 files"));
    expect(await send("begin_upload", { ...upload, files: [{ name: "file", size: 100 * 1024 * 1024 + 1 }] })).toHaveProperty("error", expect.stringContaining("at most 100 MiB"));
    expect(await send("begin_upload", upload)).toHaveProperty("data.completed", false);
    expect(await send("begin_upload", { ...upload, idempotency_key: "second" })).toHaveProperty("data.completed", false);
    expect(await send("begin_upload", { ...upload, idempotency_key: "third" })).toHaveProperty("error", expect.stringContaining("two pending uploads"));
    expect(await call("begin_upload", upload)).toHaveProperty("data.completed", false);
    const args = (i: number) => ({ idempotency_key: String(i), files: [{ name: "empty.txt", content_base64: "" }] });
    const first = await send("send_files", args(0));
    for (let i = 1; i < 58; i++) expect(await send("send_files", args(i))).toHaveProperty("data.entry_id");
    const anotherToken = await oauthAssertion({ ...personClaims(), identity_nonce: "another" });
    expect(await call("send_files", args(58), anotherToken, "/mcp")).toHaveProperty("error", expect.stringContaining("60 sends per minute"));
    expect(await call("send_files", args(0), anotherToken, "/mcp")).toEqual(first);
    const service = await call("send_files", args(0));
    expect(service).toHaveProperty("data.entry_id");
    expect(service).not.toEqual(first);
  });
});
