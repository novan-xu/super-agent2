import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPushDevice, receivePush } from "./push-device.js";
import { generateVapidKeys } from "./push.js";
import type { Hub } from "./hub.js";
import { assertion, issuer, keySet, personClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

const inboxAudience = "c".repeat(64);
const runnerAudience = "b".repeat(64);
let directory: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub;
let removed: string[];
let failRemoval: boolean;
let pushes: Buffer[];
let ownerAssertion: string;
let inboxAssertion: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hub-inbox-"));
  clock = new TestClock();
  key = await signingKey("inbox-key");
  removed = []; pushes = []; failRemoval = false;
  const vapid = generateVapidKeys();
  hub = await startTestHub({
    config: { ...testConfig(directory), accessInboxAudience: inboxAudience, accessRunnerAudience: runnerAudience, vapid },
    keySource: staticKeySource(keySet(key)), clock, targets: [fakeTarget("hub")], credentials: testCredentials,
    gate: () => ({ kind: "allow" }), report: () => undefined,
    inboxServiceTokens: { create: async () => ({ id: "token-1", clientId: "source.access", clientSecret: "secret", expiresAt: null }), remove: async (id) => { if (failRemoval) throw new Error("offline"); removed.push(id); } },
    pushFetch: async (_url, init) => { pushes.push(Buffer.from(init?.body as Uint8Array)); return new Response(null, { status: 201 }); },
  });
  ownerAssertion = await assertion({ key, clock });
  inboxAssertion = await assertion({ key, clock, claims: { iss: issuer, aud: [inboxAudience], common_name: "source.access", sub: "", type: "app" } });
});
afterEach(async () => { await hub.close(); rmSync(directory, { recursive: true, force: true }); });

const base = () => `http://127.0.0.1:${hub.address.port}`;
async function owner(path: string, body?: unknown) {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: base(), "content-type": "application/json", "cf-access-jwt-assertion": ownerAssertion }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function post(token: string | undefined, body: unknown = { text: "hello" }, headers: Record<string, string> = {}) {
  return fetch(`${base()}/inbox/message`, { method: "POST", headers: { ...(token === undefined ? {} : { "cf-access-jwt-assertion": token }), ...headers }, body: JSON.stringify(body) });
}
async function create() {
  const result = await owner("/api/inbox/sources", { name: "shortcut" });
  expect(result.status).toBe(201);
  return await result.json() as { id: string; clientId: string; clientSecret: string };
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
