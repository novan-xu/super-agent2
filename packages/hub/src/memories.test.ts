import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainLinkPath, brainToolsPath, type HubToBrain, MemoryList, ServerMessage } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { holdsCredential, secretValues } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import type { Hub } from "./hub.js";
import { createMemoryService, type MemoryService } from "./memories.js";
import { recallText, refusalText } from "./memory-tools.js";
import { migrations } from "./migrations.js";
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

const short = "你希望回答简短。";
const pnpm = "你的仓库一律用 pnpm，不用 npm。";

function suggested(memories: MemoryService, text: string, conversation: string | null = "c1", replaces: readonly number[] = []): number {
  const outcome = memories.remember({ text, replaces, conversation });
  if (!outcome.ok) {
    throw new Error(refusalText(outcome.refusal));
  }
  return outcome.suggestion.id;
}

function kept(memories: MemoryService, text: string): number {
  const outcome = memories.add(text);
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return Math.max(...outcome.list.memories.map((memory) => memory.id));
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

describe("the owner's memory", () => {
  it("stores exactly what the owner wrote: line breaks, spaces, any length, any language, copies and credentials alike", () => {
    const memories = service(["held-secret-value"]);
    const texts = [
      "  先说结论\n\n再列细节  ",
      "长".repeat(5000),
      "Answer in English when I write in English.",
      "  先说结论\n\n再列细节  ",
      `GitHub 令牌是 ghp_${"a".repeat(36)}`,
      "NAS 的口令 held-secret-value",
      "。",
    ];
    for (const text of texts) {
      kept(memories, text);
    }
    expect(memories.list().map((memory) => memory.text)).toEqual(texts);
    expect(memories.list().every((memory) => memory.by === "owner")).toBe(true);
  });

  it("is not given a blank text, by adding or by editing", () => {
    const memories = service();
    const id = kept(memories, short);
    expect(memories.add("")).toEqual({ ok: false, error: "bad_request" });
    expect(memories.add(" \n　")).toEqual({ ok: false, error: "bad_request" });
    expect(memories.edit(id, "  ")).toEqual({ ok: false, error: "bad_request" });
    expect(memories.list().map((memory) => memory.text)).toEqual([short]);
  });

  it("is edited to exactly the new text, by the owner, whoever wrote it before", () => {
    const memories = service();
    const suggestion = suggested(memories, short);
    memories.confirm(suggestion);
    const id = memories.list()[0]?.id ?? 0;
    expect(memories.list()[0]).toMatchObject({ text: short, by: "brain" });
    clock.advance(5000);
    expect(memories.edit(id, " 你希望先说结论，\n再说细节。 ")).toMatchObject({ ok: true });
    expect(memories.list()[0]).toMatchObject({ id, text: " 你希望先说结论，\n再说细节。 ", by: "owner", changedAt: clock.now() });
    expect(memories.edit(id, pnpm)).toMatchObject({ ok: true });
    expect(memories.list()[0]?.text).toBe(pnpm);
  });

  it("changes nothing when an edit is the same text, and refuses only a memory that is gone", () => {
    const memories = service();
    const id = kept(memories, short);
    const before = memories.list()[0];
    const revision = memories.revision();
    expect(memories.edit(id, short)).toMatchObject({ ok: true });
    expect(memories.list()[0]).toEqual(before);
    expect(memories.revision()).toBe(revision);
    expect(memories.edit(id, ` ${short}`)).toMatchObject({ ok: true });
    expect(memories.list()[0]?.text).toBe(` ${short}`);
    expect(memories.remove(id)).toMatchObject({ ok: true });
    expect(memories.edit(id, "随便")).toEqual({ ok: false, error: "not_found" });
    expect(memories.remove(id)).toEqual({ ok: false, error: "not_found" });
  });

  it("never gives a deleted memory's id to a new one", () => {
    const memories = service();
    const first = kept(memories, short);
    memories.remove(first);
    expect(kept(memories, pnpm)).toBe(first + 1);
  });
});

describe("the brain's suggestions", () => {
  it("change nothing until the owner confirms, and then the suggestion becomes a memory", () => {
    const memories = service();
    const id = suggested(memories, `  ${short}\n`);
    expect(memories.list()).toEqual([]);
    expect(memories.suggestions()).toMatchObject([{ id, kind: "remember", text: short, memory: null, replaces: [] }]);
    clock.advance(1000);
    expect(memories.confirm(id)).toMatchObject({ ok: true, list: { memories: [{ text: short, by: "brain", changedAt: clock.now() }], suggestions: [] } });
    expect(memories.confirm(id)).toEqual({ ok: false, error: "not_found" });
    expect(memories.decline(id)).toEqual({ ok: false, error: "not_found" });
  });

  it("replace the memories they name once confirmed, and leave alone those already gone", () => {
    const memories = service();
    const first = kept(memories, "super-agent 的 PR 在 CI 失败时可以手动合并");
    const second = kept(memories, "PR 可以跳过检查");
    const third = kept(memories, short);
    const id = suggested(memories, "super-agent 的 PR 必须等 CI 全绿才能合并", "c1", [first, second, first]);
    expect(memories.suggestions()[0]?.replaces).toEqual([first, second]);
    memories.remove(second);
    memories.confirm(id);
    expect(memories.list().map((memory) => memory.id)).toEqual([third, third + 1]);
    expect(memories.list().map((memory) => memory.text)).toEqual([short, "super-agent 的 PR 必须等 CI 全绿才能合并"]);
  });

  it("suggest forgetting a memory, which goes only when the owner confirms", () => {
    const memories = service();
    const id = kept(memories, short);
    const forget = memories.forget({ id, conversation: "c1" });
    expect(forget).toMatchObject({ ok: true, suggestion: { kind: "forget", memory: id, text: short } });
    expect(memories.list()).toHaveLength(1);
    expect(memories.forget({ id, conversation: "c1" })).toMatchObject({ ok: false, refusal: { kind: "pending" } });
    memories.confirm(forget.ok ? forget.suggestion.id : 0);
    expect(memories.list()).toEqual([]);
    expect(memories.forget({ id, conversation: "c1" })).toMatchObject({ ok: false, refusal: { kind: "unknown", memory: id } });
  });

  it("to forget a memory are settled when the owner deletes it first", () => {
    const memories = service();
    const id = kept(memories, short);
    memories.forget({ id, conversation: "c1" });
    memories.remove(id);
    expect(memories.suggestions()).toEqual([]);
  });

  it("have no count and no length limit", () => {
    const memories = service();
    for (let index = 0; index < 120; index += 1) {
      suggested(memories, `第 ${index} 条建议`);
    }
    suggested(memories, "长".repeat(5000));
    expect(memories.suggestions()).toHaveLength(121);
  });

  it("are refused when empty, without Chinese, holding a credential, or naming a memory that does not exist", () => {
    const memories = service(["held-secret-value"]);
    expect(memories.remember({ text: " \n", conversation: null })).toEqual({ ok: false, refusal: { kind: "empty" } });
    expect(memories.remember({ text: "。！", conversation: null })).toEqual({ ok: false, refusal: { kind: "empty" } });
    expect(memories.remember({ text: "Answers short", conversation: null })).toEqual({ ok: false, refusal: { kind: "chinese" } });
    expect(memories.remember({ text: `用这个令牌 ghp_${"a".repeat(36)}`, conversation: null })).toEqual({ ok: false, refusal: { kind: "credential" } });
    expect(memories.remember({ text: "NAS 的口令是 held-secret-value", conversation: null })).toEqual({ ok: false, refusal: { kind: "credential" } });
    expect(memories.remember({ text: short, replaces: [7], conversation: null })).toEqual({ ok: false, refusal: { kind: "unknown", memory: 7 } });
    expect(memories.suggestions()).toEqual([]);
  });
});

describe("a repeated suggestion", () => {
  it("is refused when a memory already says the same text, after white space, punctuation and case", () => {
    const memories = service();
    const id = kept(memories, "你的仓库一律用 pnpm，不用 npm。");
    const refused = memories.remember({ text: "你的仓库一律用PNPM,不用npm", conversation: "c1" });
    expect(refused).toMatchObject({ ok: false, refusal: { kind: "memory", memory: { id } } });
    expect(refusalText(refused.ok ? { kind: "empty" } : refused.refusal)).toContain(`memory #${id} already says this`);
    expect(memories.remember({ text: "你的仓库一律用 PNPM，不用 npm", ownerAsked: true, conversation: "c1" })).toMatchObject({ ok: false, refusal: { kind: "memory" } });
  });

  it("is refused while the same suggestion waits for the owner", () => {
    const memories = service();
    const id = suggested(memories, short, "c1");
    expect(memories.remember({ text: "你希望回答简短", conversation: "c2" })).toMatchObject({ ok: false, refusal: { kind: "pending", suggestion: { id } } });
    expect(memories.remember({ text: "你希望回答简短", ownerAsked: true, conversation: "c2" })).toMatchObject({ ok: false, refusal: { kind: "pending" } });
  });

  it("is refused after the owner declined it, unless the owner asks for it", () => {
    const memories = service();
    const id = suggested(memories, short);
    clock.advance(1000);
    memories.decline(id);
    const refused = memories.remember({ text: ` ${short}`, conversation: "c2" });
    expect(refused).toMatchObject({ ok: false, refusal: { kind: "declined", text: short, at: clock.now() } });
    expect(refusalText(refused.ok ? { kind: "empty" } : refused.refusal)).toContain("ownerAsked");
    expect(memories.remember({ text: short, ownerAsked: true, conversation: "c2" })).toMatchObject({ ok: true });
  });

  it("is refused after the owner deleted that memory, by the button, by confirming a forget, or by confirming a replacement", () => {
    const memories = service();
    const deleted = kept(memories, "周报用中文写");
    memories.remove(deleted);
    const forgotten = kept(memories, "Rhino 的工作放在 pc 上");
    const forget = memories.forget({ id: forgotten, conversation: "c1" });
    memories.confirm(forget.ok ? forget.suggestion.id : 0);
    const replaced = kept(memories, "PR 失败时可以手动合并");
    memories.confirm(suggested(memories, "PR 必须等 CI 全绿", "c1", [replaced]));
    expect(memories.remember({ text: "周报用中文写。", conversation: "c1" })).toMatchObject({ ok: false, refusal: { kind: "deleted", memory: deleted } });
    expect(memories.remember({ text: "Rhino 的工作放在 PC 上", conversation: "c1" })).toMatchObject({ ok: false, refusal: { kind: "deleted", memory: forgotten } });
    expect(memories.remember({ text: "PR 失败时可以手动合并", conversation: "c1" })).toMatchObject({ ok: false, refusal: { kind: "deleted", memory: replaced } });
    expect(memories.remember({ text: "周报用中文写", ownerAsked: true, conversation: "c1" })).toMatchObject({ ok: true });
  });

  it("to forget is refused after the owner kept that memory, until its text changes or the owner asks", () => {
    const memories = service();
    const id = kept(memories, short);
    const first = memories.forget({ id, conversation: "c1" });
    memories.decline(first.ok ? first.suggestion.id : 0);
    expect(memories.forget({ id, conversation: "c2" })).toMatchObject({ ok: false, refusal: { kind: "kept", memory: { id } } });
    expect(memories.forget({ id, ownerAsked: true, conversation: "c2" })).toMatchObject({ ok: true });
    const other = kept(memories, pnpm);
    const second = memories.forget({ id: other, conversation: "c1" });
    memories.decline(second.ok ? second.suggestion.id : 0);
    memories.edit(other, "你的仓库用 pnpm");
    expect(memories.forget({ id: other, conversation: "c1" })).toMatchObject({ ok: true });
  });
});

describe("what the brain is told", () => {
  it("is nothing for a new session while there is nothing at all", () => {
    const memories = service();
    expect(memories.brief("c1", null)).toBeNull();
    expect(memories.brief("c1", 0)).toBeNull();
  });

  it("is the memory, the waiting suggestions and what the owner set aside, for a new session", () => {
    const memories = service();
    const first = kept(memories, short);
    const declined = suggested(memories, "每天早上汇报进度");
    memories.decline(declined);
    const removed = kept(memories, "周报用中文写");
    memories.remove(removed);
    const keep = memories.forget({ id: first, conversation: "c1" });
    memories.decline(keep.ok ? keep.suggestion.id : 0);
    const waiting = suggested(memories, pnpm, "c1", [first]);
    const forgetting = memories.forget({ id: first, ownerAsked: true, conversation: "c1" });
    const brief = memories.brief("c1", null);
    expect(brief).toEqual({
      first: true,
      memories: [{ id: first, text: short }],
      pending: [
        { id: waiting, kind: "remember", text: pnpm, memory: null, replaces: [first] },
        { id: forgetting.ok ? forgetting.suggestion.id : 0, kind: "forget", text: short, memory: first, replaces: [] },
      ],
      setAside: [
        { reason: "declined", memory: null, text: "每天早上汇报进度", at: clock.now() },
        { reason: "deleted", memory: removed, text: "周报用中文写", at: clock.now() },
        { reason: "kept", memory: first, text: short, at: clock.now() },
      ],
      changes: [],
    });
    const day = new Date(clock.now()).toISOString().slice(0, 10);
    expect(recallText(memories)).toBe(
      [
        "Your memory (1), exactly as the owner keeps it in 记忆:",
        `- #${first} "${short}"`,
        "Suggestions waiting for the owner in 记忆 (already made; do not suggest them again):",
        `- suggestion ${waiting}: remember "${pnpm}", replacing #${first}`,
        `- suggestion ${forgetting.ok ? forgetting.suggestion.id : 0}: forget #${first} "${short}"`,
        "Set aside by the owner (do not suggest these again unless the owner asks for them):",
        `- declined by the owner on ${day}: "每天早上汇报进度"`,
        `- deleted by the owner on ${day} (was #${removed}): "周报用中文写"`,
        `- kept by the owner on ${day} when you suggested forgetting it: #${first} "${short}"`,
      ].join("\n"),
    );
  });

  it("lists a text set aside once, and not while a memory says it again", () => {
    const memories = service();
    const id = kept(memories, "周报用中文写");
    memories.remove(id);
    expect(memories.state().setAside).toMatchObject([{ reason: "deleted", text: "周报用中文写" }]);
    clock.advance(1000);
    const again = memories.remember({ text: "周报用中文写。", ownerAsked: true, conversation: "c1" });
    memories.decline(again.ok ? again.suggestion.id : 0);
    expect(memories.state().setAside).toEqual([{ reason: "declined", memory: null, text: "周报用中文写。", at: clock.now() }]);
    kept(memories, "周报 用中文写");
    expect(memories.state().setAside).toEqual([]);
  });

  it("gives a line kept by the owner its line breaks, exactly", () => {
    const memories = service();
    kept(memories, "先说结论\n再列细节");
    expect(recallText(memories)).toContain('"先说结论\\n再列细节"');
  });

  it("is nothing for a session that has seen the latest, or only its own conversation's suggestions", () => {
    const memories = service();
    kept(memories, short);
    const seen = memories.revision();
    expect(memories.brief("c1", seen)).toBeNull();
    suggested(memories, pnpm, "c1");
    expect(memories.brief("c1", seen)).toBeNull();
  });

  it("is what changed, and the whole memory again, when the owner or another conversation changed it", () => {
    const memories = service();
    const first = kept(memories, short);
    const second = kept(memories, pnpm);
    const seen = memories.revision();
    const other = suggested(memories, "iOS 应用在 Mac mini 上构建", "c2");
    memories.remove(second);
    memories.edit(first, "你希望先说结论");
    memories.decline(other);
    const added = kept(memories, "周报用中文写");
    expect(memories.brief("c1", seen)).toEqual({
      first: false,
      memories: [
        { id: first, text: "你希望先说结论" },
        { id: added, text: "周报用中文写" },
      ],
      pending: [],
      setAside: [
        { reason: "declined", memory: null, text: "iOS 应用在 Mac mini 上构建", at: clock.now() },
        { reason: "deleted", memory: second, text: pnpm, at: clock.now() },
      ],
      changes: [
        { action: "suggested", by: "brain", memory: null, suggestion: other, text: "iOS 应用在 Mac mini 上构建" },
        { action: "deleted", by: "owner", memory: second, suggestion: null, text: pnpm },
        { action: "edited", by: "owner", memory: first, suggestion: null, text: "你希望先说结论" },
        { action: "declined", by: "owner", memory: null, suggestion: other, text: "iOS 应用在 Mac mini 上构建" },
        { action: "added", by: "owner", memory: added, suggestion: null, text: "周报用中文写" },
      ],
    });
  });
});

describe("the move to one Chinese text", () => {
  it("keeps each memory's Chinese, renames the log's old actions, and gives every session the whole memory again", () => {
    const earlier = migrations.filter((migration) => migration.version <= 17);
    const old = openDatabase({ dataDir, clock, migrations: earlier });
    old.connection.exec(`
      INSERT INTO conversations (id, title, state, provider, created_at, updated_at) VALUES ('c1', 't', 'idle', NULL, 0, 0);
      INSERT INTO program_sessions (conversation_id, provider, session, through, updated_at, memory_offered, memory_seen) VALUES ('c1', 'claude', 's', 0, 0, 4, 4);
      INSERT INTO memory_changes (memory_id, action, author, conversation_id, text, at) VALUES (1, 'remembered', 'brain', 'c1', 'Short answers.', 0);
      INSERT INTO memory_changes (memory_id, action, author, conversation_id, text, at) VALUES (2, 'remembered', 'brain', 'c1', 'Use pnpm.', 0);
      INSERT INTO memory_changes (memory_id, action, author, conversation_id, text, at) VALUES (1, 'edited', 'owner', NULL, '先说结论', 0);
      INSERT INTO memory_changes (memory_id, action, author, conversation_id, text, at) VALUES (2, 'rewritten', 'brain', 'c1', 'Use pnpm always.', 0);
      INSERT INTO memories (id, text_en, text_zh, author, stale, revision, created_at, changed_at) VALUES (1, 'Short answers.', '先说结论', 'owner', 1, 3, 0, 0);
      INSERT INTO memories (id, text_en, text_zh, author, stale, revision, created_at, changed_at) VALUES (2, 'Use pnpm always.', '一律用 pnpm', 'brain', 0, 4, 0, 0);
    `);
    old.close();
    database = openDatabase({ dataDir, clock });
    const memories = createMemoryService({ database, clock });
    expect(memories.list()).toEqual([
      { id: 1, text: "先说结论", by: "owner", revision: 3, createdAt: 0, changedAt: 0 },
      { id: 2, text: "一律用 pnpm", by: "brain", revision: 4, createdAt: 0, changedAt: 0 },
    ]);
    expect(database.connection.prepare("SELECT memory_seen, memory_offered FROM program_sessions").all()).toEqual([{ memory_seen: 0, memory_offered: 0 }]);
    expect(memories.brief("c1", 0)).toMatchObject({ first: true, memories: [{ id: 1 }, { id: 2 }] });
    expect(kept(memories, short)).toBe(3);
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

async function owner(running: Hub, path: string, method: "POST" | "PUT" | "DELETE", body: unknown, headers: Record<string, string> = {}): Promise<Response> {
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
  it("takes the brain's tools as suggestions, sends them live to the page, and the owner confirms or declines them", async () => {
    const running = await start();
    const page = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    sockets.push(page);
    const received: ServerMessage[] = [];
    page.on("message", (data) => received.push(ServerMessage.parse(JSON.parse(String(data)))));
    const updates = () => received.filter((message) => message.type === "memories");
    await waitFor(page, () => updates().length >= 1);
    expect(updates()[0]).toEqual({ type: "memories", memories: [], suggestions: [] });
    const remembered = await tool(running, "remember", { text: short });
    expect(remembered).toEqual({ isError: false, text: expect.stringContaining("Suggested (suggestion 1)") });
    expect(remembered.text).toContain(`- suggestion 1: remember "${short}"`);
    await waitFor(page, () => updates().length >= 2);
    expect(updates().at(-1)).toMatchObject({ memories: [], suggestions: [{ id: 1, kind: "remember", text: short }] });
    const again = await tool(running, "remember", { text: "你希望回答简短" });
    expect(again).toMatchObject({ isError: true, text: expect.stringContaining("suggestion 1, still waiting for the owner") });
    expect(await tool(running, "remember", { text: "woodpecker-value-77 是 CI 的令牌" })).toMatchObject({ isError: true });
    const confirmed = await owner(running, "/api/memories/suggestions/1/confirm", "POST", {});
    expect(confirmed.status).toBe(200);
    expect(MemoryList.parse(await confirmed.json())).toMatchObject({ memories: [{ id: 1, text: short, by: "brain" }], suggestions: [] });
    expect(await tool(running, "recall", {})).toEqual({ isError: false, text: `Your memory (1), exactly as the owner keeps it in 记忆:\n- #1 "${short}"` });
    expect(await tool(running, "forget", { id: 1 })).toMatchObject({ isError: false, text: expect.stringContaining("Suggested forgetting #1 (suggestion 2)") });
    expect((await owner(running, "/api/memories/suggestions/2/decline", "POST", {})).status).toBe(200);
    expect((await owner(running, "/api/memories/suggestions/2/decline", "POST", {})).status).toBe(404);
    expect(await tool(running, "forget", { id: 1 })).toMatchObject({ isError: true, text: expect.stringContaining("the owner kept #1") });
    const list = MemoryList.parse(await (await fetch(`${base(running)}/api/memories`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } })).json());
    expect(list).toMatchObject({ memories: [{ id: 1 }], suggestions: [] });
  });

  it("is added, edited and deleted only by the owner, from the page's own origin, as JSON, exactly as written", async () => {
    const running = await start();
    const added = await owner(running, "/api/memories", "POST", { text: " 先说结论\n再列细节 " });
    expect(added.status).toBe(200);
    expect(MemoryList.parse(await added.json()).memories).toMatchObject([{ id: 1, text: " 先说结论\n再列细节 ", by: "owner" }]);
    expect((await owner(running, "/api/memories", "POST", { text: "  " })).status).toBe(400);
    const path = "/api/memories/1";
    expect((await fetch(`${base(running)}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await owner(running, path, "PUT", { text: "先说结论" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await owner(running, path, "PUT", { text: "先说结论" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await owner(running, path, "PUT", { text: "先说结论" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await owner(running, path, "PUT", { text: "先说结论", revision: 1 })).status).toBe(400);
    const brainEdit = await fetch(`${base(running)}${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${brainToken()}`, origin: base(running), "content-type": "application/json" },
      body: JSON.stringify({ text: "先说结论" }),
    });
    expect(brainEdit.status).toBe(403);
    const edited = await owner(running, path, "PUT", { text: "CI 的令牌是 woodpecker-value-77" });
    expect(edited.status).toBe(200);
    expect(MemoryList.parse(await edited.json()).memories).toMatchObject([{ id: 1, text: "CI 的令牌是 woodpecker-value-77", by: "owner" }]);
    expect((await owner(running, path, "DELETE", { revision: 1 })).status).toBe(400);
    const removed = await owner(running, path, "DELETE", {});
    expect(removed.status).toBe(200);
    expect(MemoryList.parse(await removed.json()).memories).toEqual([]);
    expect((await owner(running, path, "DELETE", {})).status).toBe(404);
    expect((await owner(running, "/api/memories/suggestions/9/confirm", "POST", {})).status).toBe(404);
  });

  it("reaches each provider's session at the start of a turn, and again after the owner changes it", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    running.memories.add(short);
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
    expect(await prepare("r1", "claude")).toMatchObject({ first: true, memories: [{ id: 1, text: short }] });
    await turn("t1", "claude");
    expect(await prepare("r2", "claude")).toBeNull();
    await turn("t2", "claude");
    running.memories.edit(1, "先说结论");
    expect(await prepare("r3", "claude")).toMatchObject({ first: false, changes: [{ action: "edited", by: "owner", memory: 1, text: "先说结论" }] });
    expect(await prepare("r4", "gpt")).toMatchObject({ first: true, memories: [{ id: 1, text: "先说结论" }] });
    expect(await prepare("r5", "claude", true)).toMatchObject({ first: true });
  });
});
