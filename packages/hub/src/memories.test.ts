import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainLinkPath, brainToolsPath, type HubToBrain, MemoryList, memoryLimit, ServerMessage } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { holdsCredential, secretValues } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import type { Hub } from "./hub.js";
import { createMemoryService, type MemoryService } from "./memories.js";
import { recallText } from "./memory-tools.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

let dataDir: string;
let clock: TestClock;
let database: HubDatabase | undefined;
let key: SigningKey;
let hub: Hub | undefined;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-memories-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await hub?.close();
  hub = undefined;
  database?.close();
  database = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

function service(secrets: readonly string[] = []): MemoryService {
  database = openDatabase({ dataDir, clock });
  return createMemoryService({ database, clock, secrets: () => secrets });
}

const short = { en: "The owner wants answers short.", zh: "你希望回答简短。" };
const pnpm = { en: "Use pnpm, never npm, in the owner's repositories.", zh: "你的仓库一律用 pnpm，不用 npm。" };

function added(memories: MemoryService, text: { en: string; zh: string }, conversation: string | null = "c1"): number {
  const outcome = memories.remember({ text, conversation });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.memory.id;
}

describe("what looks like a credential", () => {
  it("is found by the shapes of known tokens and keys, and by a name the hub knows given a value", () => {
    expect(holdsCredential(`The token is ghp_${"a1B2".repeat(9)}`)).toBe(true);
    expect(holdsCredential(`github_pat_${"x".repeat(30)}`)).toBe(true);
    expect(holdsCredential(`key sk-ant-${"z".repeat(30)}`)).toBe(true);
    expect(holdsCredential("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(holdsCredential("WOODPECKER_TOKEN=abcdefgh1234")).toBe(true);
    expect(holdsCredential("password: hunter2hunter2")).toBe(true);
    expect(holdsCredential("NAS 的密码是 Garden-2024!")).toBe(true);
    expect(holdsCredential("https://owner:s3cretpass@example.com/repo.git")).toBe(true);
  });

  it("is not a fact about where a credential is used", () => {
    expect(holdsCredential("GITHUB_TOKEN_NOVAN_XU is used for repositories under novan-xu.")).toBe(false);
    expect(holdsCredential("Deploy the garden site from the Mac mini.")).toBe(false);
    expect(holdsCredential("令牌放在 NAS 的 secrets 文件夹里")).toBe(false);
  });

  it("is any value the hub holds as a credential, however it is written around", () => {
    const values = secretValues({ WOODPECKER_TOKEN: "wp-value-1234", HOME: "/home/owner", GH_TOKEN: "short" }, ["brain-token-value"]);
    expect(values).toEqual(["wp-value-1234", "brain-token-value"]);
    expect(holdsCredential("记住 wp-value-1234 这个", values)).toBe(true);
    expect(holdsCredential("/home/owner is the home folder", values)).toBe(false);
  });
});

describe("the brain's memory", () => {
  it("adds, rewrites and forgets, recording who wrote each and when", () => {
    const memories = service();
    const id = added(memories, short);
    clock.advance(1000);
    const rewritten = memories.remember({ id, text: { en: "The owner wants short answers, conclusion first.", zh: "你希望回答简短，先说结论。" }, conversation: "c1" });
    expect(rewritten).toMatchObject({ ok: true, added: false, count: 1, memory: { id, by: "brain", stale: false, changedAt: clock.now() } });
    expect(memories.list().map((memory) => memory.text.zh)).toEqual(["你希望回答简短，先说结论。"]);
    expect(memories.forget(id, "c1")).toMatchObject({ ok: true, count: 0 });
    expect(memories.list()).toEqual([]);
    expect(memories.forget(id, "c1")).toMatchObject({ ok: false });
  });

  it("never gives a deleted memory's id to a new one", () => {
    const memories = service();
    const first = added(memories, short);
    memories.forget(first, null);
    expect(added(memories, pnpm)).toBe(first + 1);
  });

  it("keeps each memory to one short sentence in both languages", () => {
    const memories = service();
    expect(memories.remember({ text: { en: "x".repeat(301), zh: "短" }, conversation: null })).toMatchObject({ ok: false, reason: expect.stringContaining("English text is too long") });
    expect(memories.remember({ text: { en: "Fine", zh: "短".repeat(201) }, conversation: null })).toMatchObject({ ok: false, reason: expect.stringContaining("Chinese text is too long") });
    expect(added(memories, { en: " Use\npnpm. ", zh: "用  pnpm。" })).toBe(1);
    expect(memories.list()[0]?.text).toEqual({ en: "Use pnpm.", zh: "用 pnpm。" });
  });

  it("refuses a second copy of the same memory", () => {
    const memories = service();
    const id = added(memories, short);
    expect(memories.remember({ text: { en: "Something else", zh: short.zh }, conversation: null })).toMatchObject({ ok: false, reason: expect.stringContaining(`#${id}`) });
  });

  it("refuses to add when full, and says to forget or merge first, but still rewrites", () => {
    const memories = service();
    for (let index = 0; index < memoryLimit; index += 1) {
      added(memories, { en: `Fact number ${index}.`, zh: `第 ${index} 条。` });
    }
    const refused = memories.remember({ text: pnpm, conversation: null });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining(`full (${memoryLimit} of ${memoryLimit})`) });
    expect(refused.ok === false && refused.reason).toContain("forget");
    expect(memories.remember({ id: 1, text: pnpm, conversation: null })).toMatchObject({ ok: true, count: memoryLimit });
    memories.forget(2, null);
    expect(memories.remember({ text: short, conversation: null })).toMatchObject({ ok: true, count: memoryLimit });
  });

  it("refuses what looks like a credential, and a value the hub holds", () => {
    const memories = service(["held-secret-value"]);
    expect(memories.remember({ text: { en: `Use ghp_${"a".repeat(36)}`, zh: "用这个令牌" }, conversation: null })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("never holds a credential"),
    });
    expect(memories.remember({ text: { en: "The NAS answers to held-secret-value", zh: "NAS 的口令" }, conversation: null })).toMatchObject({ ok: false });
    expect(memories.list()).toEqual([]);
  });
});

describe("the owner's edits", () => {
  it("replace the Chinese, leave the English stale, and give the brain the owner's words until it writes the English", () => {
    const memories = service();
    const id = added(memories, short);
    const before = memories.list()[0];
    clock.advance(5000);
    const edited = memories.edit(id, "你希望先说结论，再说细节。", before?.revision ?? 0);
    expect(edited).toMatchObject({ ok: true });
    const memory = memories.list()[0];
    expect(memory).toMatchObject({ text: { en: short.en, zh: "你希望先说结论，再说细节。" }, by: "owner", stale: true, changedAt: clock.now() });
    expect(memories.brief("c2", null)?.memories).toEqual([{ id, text: "你希望先说结论，再说细节。", ownerWords: true }]);
    expect(recallText(memories.list())).toContain("the owner, in Chinese; its English is out of date");
    memories.remember({ id, text: { en: "Conclusion first, then details.", zh: "你希望先说结论，再说细节。" }, conversation: "c2" });
    expect(memories.list()[0]).toMatchObject({ by: "owner", stale: false, text: { en: "Conclusion first, then details." } });
    expect(memories.brief("c3", null)?.memories).toEqual([{ id, text: "Conclusion first, then details.", ownerWords: false }]);
  });

  it("refuse an edit made against an older version, an empty text, a duplicate and a credential", () => {
    const memories = service();
    const id = added(memories, short);
    const other = added(memories, pnpm);
    const stale = memories.list().find((memory) => memory.id === id)?.revision ?? 0;
    memories.remember({ id, text: { en: "Short answers.", zh: "回答要短。" }, conversation: null });
    expect(memories.edit(id, "改一下", stale)).toEqual({ ok: false, error: "conflict" });
    const current = memories.list().find((memory) => memory.id === id)?.revision ?? 0;
    expect(memories.edit(id, "  ", current)).toEqual({ ok: false, error: "bad_request" });
    expect(memories.edit(id, pnpm.zh, current)).toEqual({ ok: false, error: "duplicate" });
    expect(memories.edit(id, `令牌 ghp_${"a".repeat(36)}`, current)).toEqual({ ok: false, error: "credential" });
    expect(memories.edit(99, "随便", 1)).toEqual({ ok: false, error: "not_found" });
    expect(memories.remove(other, 1)).toEqual({ ok: false, error: "conflict" });
  });

  it("an edit that changes nothing changes nothing", () => {
    const memories = service();
    const id = added(memories, short);
    const before = memories.list()[0];
    const revision = memories.revision();
    expect(memories.edit(id, ` ${short.zh} `, before?.revision ?? 0)).toMatchObject({ ok: true });
    expect(memories.list()[0]).toEqual(before);
    expect(memories.revision()).toBe(revision);
  });
});

describe("what the brain is told", () => {
  it("is the whole memory for a new session, and nothing when it is empty", () => {
    const memories = service();
    expect(memories.brief("c1", null)).toBeNull();
    const first = added(memories, short, "c1");
    const second = added(memories, pnpm, "c1");
    expect(memories.brief("c1", null)).toEqual({
      first: true,
      memories: [
        { id: first, text: short.en, ownerWords: false },
        { id: second, text: pnpm.en, ownerWords: false },
      ],
      changes: [],
      limit: memoryLimit,
    });
  });

  it("is nothing for a session that has seen the latest, or only its own conversation's changes", () => {
    const memories = service();
    added(memories, short, "c1");
    const seen = memories.revision();
    expect(memories.brief("c1", seen)).toBeNull();
    added(memories, pnpm, "c1");
    expect(memories.brief("c1", seen)).toBeNull();
  });

  it("is what changed, and the whole memory again, when another conversation or the owner changed it", () => {
    const memories = service();
    const first = added(memories, short, "c1");
    const second = added(memories, pnpm, "c1");
    const seen = memories.revision();
    const third = added(memories, { en: "The Mac mini builds the iOS apps.", zh: "iOS 应用在 Mac mini 上构建。" }, "c2");
    memories.remove(second, memories.list().find((memory) => memory.id === second)?.revision ?? 0);
    memories.edit(first, "你希望先说结论", memories.list().find((memory) => memory.id === first)?.revision ?? 0);
    expect(memories.brief("c1", seen)).toEqual({
      first: false,
      memories: [
        { id: first, text: "你希望先说结论", ownerWords: true },
        { id: third, text: "The Mac mini builds the iOS apps.", ownerWords: false },
      ],
      changes: [
        { id: third, action: "remembered", by: "brain", text: "The Mac mini builds the iOS apps." },
        { id: second, action: "deleted", by: "owner", text: pnpm.en },
        { id: first, action: "edited", by: "owner", text: "你希望先说结论" },
      ],
      limit: memoryLimit,
    });
  });
});

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function start(): Promise<Hub> {
  hub = await startTestHub({
    config: testConfig(dataDir),
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [fakeTarget("hub")],
    credentials: testCredentials,
    environment: { WOODPECKER_TOKEN: "woodpecker-value-77" },
  });
  return hub;
}

async function owner(running: Hub, path: string, method: "PUT" | "DELETE", body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    method,
    headers: { origin: base(running), "content-type": "application/json", "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), ...headers },
    body: JSON.stringify(body),
  });
}

function brainToken(): string {
  return readFileSync(join(dataDir, "brain.token"), "utf8").trim();
}

async function tool(running: Hub, name: string, args: unknown, conversation = "c1"): Promise<{ isError: boolean; text: string }> {
  const response = await fetch(`${base(running)}${brainToolsPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json", "x-super-agent-conversation": conversation },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
  return { isError: body.result.isError, text: body.result.content.map((part) => part.text).join("") };
}

function waitFor(socket: WebSocket, check: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (check()) {
      resolve();
      return;
    }
    const listener = () => {
      if (check()) {
        socket.off("message", listener);
        resolve();
      }
    };
    socket.on("message", listener);
  });
}

describe("memory through the hub", () => {
  it("is read by the page, changed by the brain's tools, and sent live to the page", async () => {
    const running = await start();
    const page = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    sockets.push(page);
    const received: ServerMessage[] = [];
    page.on("message", (data) => received.push(ServerMessage.parse(JSON.parse(String(data)))));
    await waitFor(page, () => received.some((message) => message.type === "memories"));
    expect(received.find((message) => message.type === "memories")).toEqual({ type: "memories", memories: [] });
    const remembered = await tool(running, "remember", { text: short });
    expect(remembered).toEqual({ isError: false, text: expect.stringContaining(`Remembered #1 (1 of ${memoryLimit})`) });
    await waitFor(page, () => received.filter((message) => message.type === "memories").length >= 2);
    expect(received.filter((message) => message.type === "memories").at(-1)).toMatchObject({ memories: [{ id: 1, text: short, by: "brain" }] });
    expect(await tool(running, "recall", {})).toEqual({ isError: false, text: expect.stringContaining(`#1 ${short.en} (last written by you,`) });
    expect(await tool(running, "remember", { text: { en: "woodpecker-value-77 is the CI token", zh: "CI 的令牌" } })).toMatchObject({ isError: true });
    expect(await tool(running, "forget", { id: 1 })).toEqual({ isError: false, text: `Forgot #1 (0 of ${memoryLimit} kept).` });
    const list = MemoryList.parse(await (await fetch(`${base(running)}/api/memories`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } })).json());
    expect(list).toEqual({ memories: [], limit: memoryLimit });
  });

  it("is edited and deleted only by the owner, from the page's own origin, as JSON", async () => {
    const running = await start();
    const id = running.memories.remember({ text: short, conversation: null });
    if (!id.ok) {
      throw new Error(id.reason);
    }
    const path = `/api/memories/${id.memory.id}`;
    const revision = id.memory.revision;
    expect((await fetch(`${base(running)}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await owner(running, path, "PUT", { text: "先说结论", revision }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await owner(running, path, "PUT", { text: "先说结论", revision }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await owner(running, path, "PUT", { text: "先说结论", revision }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await owner(running, path, "PUT", { text: "先说结论", revision, extra: 1 })).status).toBe(400);
    expect((await owner(running, path, "PUT", { text: "CI 的令牌是 woodpecker-value-77", revision })).status).toBe(422);
    const brainEdit = await fetch(`${base(running)}${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${brainToken()}`, origin: base(running), "content-type": "application/json" },
      body: JSON.stringify({ text: "先说结论", revision }),
    });
    expect(brainEdit.status).toBe(403);
    const edited = await owner(running, path, "PUT", { text: "先说结论", revision });
    expect(edited.status).toBe(200);
    const after = MemoryList.parse(await edited.json());
    expect(after.memories).toMatchObject([{ id: id.memory.id, text: { en: short.en, zh: "先说结论" }, by: "owner", stale: true }]);
    expect((await owner(running, path, "DELETE", { revision })).status).toBe(409);
    const removed = await owner(running, path, "DELETE", { revision: after.memories[0]?.revision });
    expect(removed.status).toBe(200);
    expect(MemoryList.parse(await removed.json()).memories).toEqual([]);
    expect((await owner(running, path, "DELETE", { revision: 1 })).status).toBe(404);
  });

  it("reaches each provider's session at the start of a turn, and again after the owner changes it", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    running.memories.remember({ text: short, conversation: null });
    const brain = new WebSocket(`ws://127.0.0.1:${running.address.port}${brainLinkPath}`, { headers: { authorization: `Bearer ${brainToken()}` } });
    sockets.push(brain);
    const received: HubToBrain[] = [];
    brain.on("message", (data) => received.push(JSON.parse(String(data)) as HubToBrain));
    await new Promise<void>((resolve) => brain.once("open", () => resolve()));
    brain.send(JSON.stringify({ type: "hello", protocol: 1, running: [] }));
    const prepare = async (request: string, provider: string, fresh = false) => {
      brain.send(JSON.stringify({ type: "prepare", request, conversation: conversation.id, provider, fresh, exclude: [] }));
      await waitFor(brain, () => received.some((message) => message.type === "prepared" && message.request === request));
      const prepared = received.find((message) => message.type === "prepared" && message.request === request);
      return prepared?.type === "prepared" ? prepared.memory : undefined;
    };
    const turn = async (id: string, provider: string) => {
      brain.send(JSON.stringify({ type: "turn.started", conversation: conversation.id, turn: id, provider, model: "m", inputs: [] }));
      brain.send(JSON.stringify({ type: "session", conversation: conversation.id, provider, session: `${provider}-session` }));
      brain.send(JSON.stringify({ type: "turn.finished", conversation: conversation.id, turn: id, outcome: "completed", reason: null }));
      await new Promise<void>((resolve) => {
        const check = () => running.conversations.detail(conversation.id)?.turns.find((candidate) => candidate.id === id)?.state === "completed";
        if (check()) {
          resolve();
          return;
        }
        const stop = running.conversations.subscribe(() => {
          if (check()) {
            stop();
            resolve();
          }
        });
      });
    };
    expect(await prepare("r1", "claude")).toMatchObject({ first: true, memories: [{ id: 1, text: short.en }] });
    await turn("t1", "claude");
    expect(await prepare("r2", "claude")).toBeNull();
    await turn("t2", "claude");
    const memory = running.memories.list()[0];
    running.memories.edit(1, "先说结论", memory?.revision ?? 0);
    expect(await prepare("r3", "claude")).toMatchObject({ first: false, changes: [{ id: 1, action: "edited", by: "owner", text: "先说结论" }] });
    expect(await prepare("r4", "gpt")).toMatchObject({ first: true, memories: [{ id: 1, text: "先说结论", ownerWords: true }] });
    expect(await prepare("r5", "claude", true)).toMatchObject({ first: true });
  });
});
