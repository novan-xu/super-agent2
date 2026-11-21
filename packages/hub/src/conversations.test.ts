import { ticketReference } from "@super-agent2/protocol";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "@super-agent2/catalog";
import { brainLinkPath, brainToolsPath, ConversationResponse, ConversationState, EntryResponse, type HubToBrain, largestMessageBytes, MachineReport, protocolVersion, ServerMessage, StreamEntry, StreamPage, StreamPreview, TurnState } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { brainTokenCheck, ensureBrainToken } from "./brain-token.js";
import { openDatabase } from "./database.js";
import type { Hub } from "./hub.js";
import { migrations } from "./migrations.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-conversations-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(topicArchiveMilliseconds?: number): Promise<Hub> {
  hub = await startTestHub({
    config: { ...testConfig(dataDir), ...(topicArchiveMilliseconds === undefined ? {} : { topicArchiveMilliseconds }) },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [fakeTarget("hub")],
    credentials: testCredentials,
  });
  return hub;
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function streamRequest(running: Hub, query = "", body?: unknown): Promise<Response> {
  return fetch(`${base(running)}/api/stream${query}`, {
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
}

function openTicket(running: Hub, conversation?: string, repository: string | null = null) {
  const title = { en: "Translate a notice", zh: "翻译一则通知" };
  return running.tickets.open({
    form: "task",
    kind: "writing",
    repository,
    issues: [],
    title,
    summary: title,
    conversation,
    task: { task: title.en, materials: [] },
  });
}

function brainToken(): string {
  return readFileSync(join(dataDir, "brain.token"), "utf8").trim();
}

async function mcp(running: Hub, body: unknown, method = "POST"): Promise<Response> {
  return fetch(`${base(running)}${brainToolsPath}`, {
    method,
    headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function collect(socket: WebSocket): ServerMessage[] {
  const received: ServerMessage[] = [];
  socket.on("message", (data) => received.push(ServerMessage.parse(JSON.parse(String(data)))));
  return received;
}

function until(check: () => boolean, socket: WebSocket): Promise<void> {
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

async function pageSocket(running: Hub): Promise<{ socket: WebSocket; received: ServerMessage[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, {
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) },
  });
  sockets.push(socket);
  const received = collect(socket);
  await until(() => received.some((message) => message.type === "hello"), socket);
  return { socket, received };
}

async function brainSocket(running: Hub): Promise<{ socket: WebSocket; received: HubToBrain[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}${brainLinkPath}`, {
    headers: { authorization: `Bearer ${brainToken()}` },
  });
  sockets.push(socket);
  const received: HubToBrain[] = [];
  socket.on("message", (data) => received.push(JSON.parse(String(data)) as HubToBrain));
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  return { socket, received };
}

function connect(running: Hub) {
  const messages: HubToBrain[] = [];
  const link = running.conversations.attach({ send: (message) => messages.push(message), close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, running: [] });
  return { link, messages };
}

describe("workbench rearrangement", () => {
  it("authenticates, scopes, delivers and serializes rearrangement turns", async () => {
    const running = await start();
    const project = openTicket(running, undefined, "org/one");
    const daily = openTicket(running);
    const other = openTicket(running, undefined, "org/two");
    const brain = connect(running);
    const url = `${base(running)}/api/workbench/rearrange`;
    const headers = { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json", origin: base(running) };
    const post = (body: unknown, extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await post({}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ repository: "invalid" })).status).toBe(400);
    const first = await post({ repository: "ORG/ONE" });
    expect(first.status).toBe(201);
    const topic = ConversationResponse.parse(await first.json()).conversation;
    expect(topic.repository).toBe("ORG/ONE");
    const input = brain.messages.find((message) => message.type === "input" && message.conversation === topic.id);
    expect(input?.type).toBe("input");
    if (input?.type !== "input") throw new Error("Missing rearrangement input");
    expect(input.input.text).toContain(`"ticket":"ticket ${ticketReference(project)}"`);
    expect(input.input.text).not.toContain(`"ticket":"ticket ${ticketReference(daily)}"`);
    expect(input.input.text).not.toContain(`"ticket":"ticket ${ticketReference(other)}"`);
    for (const rule of ["list_tickets", "read_ticket", "arrange_chains", "choose_defaults", "stop_ticket", "record_decision", "Never touch a ticket whose worker is running", "Never start anything", "Reply in Chinese"]) expect(input.input.text).toContain(rule);
    expect((await post({})).status).toBe(409);
    brain.link.receive({ type: "turn.started", conversation: topic.id, turn: "rearrange-turn", provider: "gpt", model: "test", inputs: [input.input.id] });
    expect((await post({ repository: null })).status).toBe(409);
    brain.link.receive({ type: "turn.finished", conversation: topic.id, turn: "rearrange-turn", outcome: "completed", reason: null });
    const second = await post({ repository: null });
    expect(second.status).toBe(201);
    const dailyTopic = ConversationResponse.parse(await second.json()).conversation;
    expect(dailyTopic.repository).toBeNull();
    const dailyInput = brain.messages.find((message) => message.type === "input" && message.conversation === dailyTopic.id);
    if (dailyInput?.type !== "input") throw new Error("Missing daily input");
    expect(dailyInput.input.text).toContain(`"ticket":"ticket ${ticketReference(daily)}"`);
    expect(dailyInput.input.text).not.toContain(`"ticket":"ticket ${ticketReference(project)}"`);
    brain.link.receive({ type: "turn.started", conversation: dailyTopic.id, turn: "daily-turn", provider: "gpt", model: "test", inputs: [dailyInput.input.id] });
    brain.link.receive({ type: "turn.finished", conversation: dailyTopic.id, turn: "daily-turn", outcome: "completed", reason: null });
    const all = await post({});
    expect(all.status).toBe(201);
    const allTopic = ConversationResponse.parse(await all.json()).conversation;
    const allInput = brain.messages.find((message) => message.type === "input" && message.conversation === allTopic.id);
    if (allInput?.type !== "input") throw new Error("Missing all-scope input");
    for (const item of [project, daily, other]) expect(allInput.input.text).toContain(`"ticket":"ticket ${ticketReference(item)}"`);
  });
});

describe("the brain's token", () => {
  it("is made once, kept in a file, and accepted only as a bearer token", () => {
    const path = join(dataDir, "secrets", "brain.token");
    const token = ensureBrainToken(path);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureBrainToken(path)).toBe(token);
    const check = brainTokenCheck(token);
    expect(check(`Bearer ${token}`)).toBe(true);
    expect(check(token)).toBe(false);
    expect(check(`Bearer ${token}x`)).toBe(false);
    expect(check(undefined)).toBe(false);
  });
});

describe("the hub's tools for the brain", () => {
  it("speaks MCP over HTTP: initialize, the tool list, notifications and nothing else", async () => {
    const running = await start();
    const initialize = await mcp(running, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(await initialize.json()).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    const unknownVersion = await mcp(running, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(await unknownVersion.json()).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    expect((await mcp(running, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = (await (await mcp(running, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["run_command", "read_command", "stop_command", "read_quote", "set_topic_repository", "set_topic_title", "archive_topics", "handover", "file_issue", "open_ticket", "open_task_ticket", "propose_light_task", "start_light_task", "answer_light_task", "list_tickets", "read_ticket", "message_worker", "record_decision", "stop_ticket", "open_repair_ticket", "propose_schedule", "create_schedule", "list_schedules", "pause_schedule", "resume_schedule", "delete_schedule", "run_scheduled_light_task", "arrange_chains", "report_deployment", "proceed_ticket", "set_engine_row", "read_allowance", "choose_defaults", "merge_ticket", "guide_ticket", "describe_stuck", "remember", "recall", "forget", "ask_owner", "read_topic_board", "read_topic_history", "search_topic_history", "read_seed_material"]);
    expect(list.result.tools[0]?.description).toContain("nothing on a work machine");
    expect(await (await mcp(running, { jsonrpc: "2.0", id: 4, method: "resources/list" })).json()).toMatchObject({ error: { code: -32601 } });
    expect((await mcp(running, undefined, "GET")).status).toBe(405);
  });

  it("answers a bad tool call as an error the model can read", async () => {
    const running = await start();
    const reply = (await (
      await mcp(running, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_command", arguments: { target: "hub" } } })
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain("The arguments are not valid");
  });
});

describe("conversations for the page", () => {
  it("refuses a message that is empty, not JSON, or for a conversation that does not exist", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    const headers = { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json" };
    const path = `${base(running)}/api/conversations/${conversation.id}/messages`;
    expect((await fetch(path, { method: "POST", headers, body: JSON.stringify({ text: "  " }) })).status).toBe(400);
    expect((await fetch(path, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "hi" })).status).toBe(415);
    const missing = `${base(running)}/api/conversations/nope/messages`;
    expect((await fetch(missing, { method: "POST", headers, body: JSON.stringify({ text: "hi" }) })).status).toBe(404);
  });

  it("takes a message of any length, and says plainly when a request is past what the system can carry at once", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    const headers = { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json" };
    const path = `${base(running)}/api/conversations/${conversation.id}/messages`;
    const long = "很长的一段话。".repeat(300_000);
    expect((await fetch(path, { method: "POST", headers, body: JSON.stringify({ text: long }) })).status).toBe(202);
    expect(running.conversations.detail(conversation.id)?.entries.some((entry) => entry.kind === "owner" && entry.text === long)).toBe(true);
    const refused = await new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
      const sent = httpRequest(path, { method: "POST", headers: { ...headers, "content-length": String(largestMessageBytes + 1) } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          sent.destroy();
          resolve({ status: response.statusCode ?? 0, body });
        });
      });
      sent.on("error", reject);
      sent.flushHeaders();
    });
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body)).toEqual({ error: "too_large" });
    expect(messages["refusal.too_large"]).toContain("物理上限");
  });

  it("streams a watched conversation to the page as the brain works, and nothing of an unwatched one", async () => {
    const running = await start();
    const watched = running.conversations.create();
    const other = running.conversations.create();
    const { socket, received } = await pageSocket(running);
    const brain = await brainSocket(running);
    brain.socket.send(JSON.stringify({ type: "hello", protocol: 1, running: [] }));
    socket.send(JSON.stringify({ type: "watch", conversation: watched.id }));
    await until(() => received.some((message) => message.type === "brain"), socket);
    running.conversations.send(watched.id, "你好");
    running.conversations.send(other.id, "别处");
    await new Promise<void>((resolve) => {
      const check = () => brain.received.filter((message) => message.type === "input").length >= 2;
      if (check()) {
        resolve();
        return;
      }
      brain.socket.on("message", () => check() && resolve());
    });
    const inputs = brain.received.filter((message) => message.type === "input");
    expect(inputs.map((message) => message.type === "input" && message.input.text)).toEqual(["你好", "别处"]);
    const first = inputs[0];
    const turn = { conversation: watched.id, turn: "t1" };
    brain.socket.send(
      JSON.stringify({ type: "turn.started", ...turn, provider: "claude", model: "claude-opus-5-5", inputs: [first?.type === "input" ? first.input.id : ""] }),
    );
    await until(() => received.some((message) => message.type === "turn" && message.turn.id === turn.turn), socket);
    const title = "Morning greeting";
    expect(running.conversations.proposeTitle(watched.id, turn.turn, title)).toBe(true);
    expect(running.conversations.get(watched.id)?.title).toBe("你好");
    brain.socket.send(JSON.stringify({ type: "text", ...turn, block: "b", delta: "你" }));
    brain.socket.send(JSON.stringify({ type: "text", ...turn, block: "b", delta: "好！" }));
    brain.socket.send(JSON.stringify({ type: "turn.finished", ...turn, outcome: "completed", reason: null }));
    await until(() => received.some((message) => message.type === "turn" && message.turn.state === "completed"), socket);
    await until(() => received.some((message) => message.type === "conversation" && message.conversation.id === watched.id && message.conversation.title === title), socket);
    const deltas = received.filter((message) => message.type === "delta").map((message) => (message.type === "delta" ? message.text : ""));
    expect(deltas).toEqual(["好！"]);
    const entries = received.filter((message) => message.type === "entry").map((message) => (message.type === "entry" ? message.entry : undefined));
    expect(entries.every((entry) => entry?.conversation === watched.id)).toBe(true);
    expect(entries.some((entry) => entry?.kind === "text" && entry.text === "你")).toBe(true);
    expect(running.conversations.detail(watched.id)?.entries.map((entry) => [entry.kind, entry.kind === "owner" ? entry.taken : null])).toEqual([
      ["owner", true],
      ["text", null],
    ]);
    expect(running.conversations.detail(watched.id)?.entries[1]).toMatchObject({ text: "你好！" });
  });

  it("delivers a result as an entry the page watches and an input for the brain, and keeps it in the history for another model", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    const ticket = openTicket(running, conversation.id);
    const { socket, received } = await pageSocket(running);
    const brain = await brainSocket(running);
    brain.socket.send(JSON.stringify({ type: "hello", protocol: 1, running: [] }));
    socket.send(JSON.stringify({ type: "watch", conversation: conversation.id }));
    await until(() => received.some((message) => message.type === "brain"), socket);
    const id = running.conversations.deliver({
      ticket: ticket.id,
      title: { en: "Translate a notice", zh: "翻译一则通知" },
      text: "Hello, world.\n",
      files: [{ name: "notes.pdf", size: 4 }],
      prompt: `[hub] The result of writing ticket ${ticket.id} was delivered.`,
    });
    expect(id).toBe(conversation.id);
    await until(() => received.some((message) => message.type === "entry" && message.entry.kind === "delivery"), socket);
    const entry = running.conversations.entries(conversation.id).find((candidate) => candidate.kind === "delivery");
    expect(entry).toMatchObject({
      kind: "delivery",
      turn: null,
      ticket: ticket.id,
      title: { en: "Translate a notice", zh: "翻译一则通知" },
      text: "Hello, world.\n",
      files: [{ name: "notes.pdf", size: 4 }],
    });
    await new Promise<void>((resolve) => {
      const check = () => brain.received.some((message) => message.type === "input");
      if (check()) {
        resolve();
        return;
      }
      brain.socket.on("message", () => check() && resolve());
    });
    expect(brain.received.find((message) => message.type === "input")).toMatchObject({
      type: "input",
      conversation: conversation.id,
      input: { source: "hub", text: `[hub] The result of writing ticket ${ticket.id} was delivered.` },
    });
    brain.socket.send(JSON.stringify({ type: "prepare", request: "r-1", conversation: conversation.id, provider: "claude", fresh: false, exclude: [] }));
    await new Promise<void>((resolve) => {
      const check = () => brain.received.some((message) => message.type === "prepared");
      if (check()) {
        resolve();
        return;
      }
      brain.socket.on("message", () => check() && resolve());
    });
    const prepared = brain.received.find((message) => message.type === "prepared");
    expect(prepared?.type === "prepared" && prepared.history).toEqual([
      { kind: "notice", text: "任务：翻译一则通知" },
      { kind: "notice", text: expect.stringContaining(`The result of task ticket ${ticketReference(ticket)} (Translate a notice) was delivered`) },
    ]);
  });

  it("has a label for every state of a conversation and a turn", () => {
    for (const state of ConversationState.options) {
      expect(Object.hasOwn(messages, `conversation.state.${state}`), state).toBe(true);
    }
    for (const state of TurnState.options) {
      expect(Object.hasOwn(messages, `turn.state.${state}`), state).toBe(true);
    }
  });
});

describe("the topic stream", () => {
  it("migrates saved topics, histories and provider sessions with their original IDs and per-topic sequences", async () => {
    const earlier = openDatabase({ dataDir, clock, migrations: migrations.filter(({ version }) => version < 29) });
    earlier.connection.exec(`
      INSERT INTO conversations (id, title, state, created_at, updated_at) VALUES
        ('first', 'First', 'idle', 100, 101), ('second', 'Second', 'idle', 100, 100), ('mixed', 'Mixed', 'idle', 100, 100);
      INSERT INTO turns (id, conversation_id, provider, model, state, started_at, ended_at)
        VALUES ('turn-1', 'first', 'claude', 'model', 'completed', 100, 101);
      INSERT INTO conversation_entries (id, conversation_id, seq, kind, turn_id, body, taken, created_at) VALUES
        ('one', 'first', 1, 'owner', 'turn-1', '{"text":"one"}', 1, 100),
        ('two', 'second', 1, 'owner', NULL, '{"text":"two"}', 1, 100),
        ('three', 'first', 2, 'text', 'turn-1', '{"text":"three"}', NULL, 101);
      INSERT INTO program_sessions (conversation_id, provider, session, through, updated_at)
        VALUES ('first', 'claude', 'saved-session', 2, 101);
      INSERT INTO tickets (id, form, repository, kind, title_en, title_zh, summary_en, summary_zh, state, conversation_id, created_at, updated_at) VALUES
        (1, 'task', 'owner/project', 'writing', 'Copy', '文案', 'Copy', '文案', 'pending', 'first', 100, 100),
        (2, 'task', 'Owner/Project', 'writing', 'Copy', '文案', 'Copy', '文案', 'pending', 'first', 100, 100),
        (3, 'task', 'owner/project', 'writing', 'Copy', '文案', 'Copy', '文案', 'pending', 'mixed', 100, 100),
        (4, 'task', NULL, 'writing', 'Copy', '文案', 'Copy', '文案', 'pending', 'mixed', 100, 100);
    `);
    earlier.close();
    const running = await start();
    expect(running.conversations.get("first")).toMatchObject({ title: "First", topicState: "active", repository: "Owner/Project" });
    expect(running.conversations.get("second")).toMatchObject({ repository: null });
    expect(running.conversations.get("mixed")).toMatchObject({ repository: null });
    expect(running.tickets.get(1)?.conversation).toBe("first");
    expect(running.conversations.detail("first")?.entries.map((entry) => entry.id)).toEqual(["one", "three"]);
    expect(running.conversations.stream().entries.map(({ position, entry }) => [position, entry.id, entry.seq])).toEqual([[1, "one", 1], [2, "two", 1], [3, "three", 2]]);
    const sent: HubToBrain[] = [];
    const brain = running.conversations.attach({ send: (message) => sent.push(message), close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    const next = running.conversations.send("first", "four");
    expect(next?.seq).toBe(3);
    brain.receive({ type: "prepare", request: "resume", conversation: "first", provider: "claude", fresh: false, exclude: [next?.id ?? ""] });
    expect(sent.at(-1)).toMatchObject({ type: "prepared", session: "saved-session", history: [] });
    expect(running.conversations.stream().entries.at(-1)).toMatchObject({ position: 4, entry: { id: next?.id } });
  });

  it("pages by stream position, filters by repository and creates a fresh topic when the brain is offline", async () => {
    const running = await start();
    const firstResponse = await streamRequest(running, "", { text: "First" });
    expect(firstResponse.status).toBe(202);
    const first = StreamEntry.parse(await firstResponse.json());
    expect(first.topic).toMatchObject({ title: "First", repository: null });
    const second = running.conversations.create();
    expect(openTicket(running, second.id, "owner/project").conversation).toBe(second.id);
    const secondEntry = StreamEntry.parse(await (await streamRequest(running, "", { text: "Second", topic: second.id })).json());
    expect(secondEntry.topic).toEqual({ id: second.id, title: "Second", repository: "owner/project" });
    clock.advance(-10);
    const explicit = StreamEntry.parse(await (await streamRequest(running, "", { text: "Back to first", topic: first.topic.id })).json());
    expect(explicit.topic.id).toBe(first.topic.id);
    clock.advance(10);
    const implicit = StreamEntry.parse(await (await streamRequest(running, "", {
      text: "A separate project topic", scope: { kind: "repository", repository: "owner/project" },
    })).json());
    expect(implicit.topic).toMatchObject({ title: "A separate project topic", repository: "owner/project" });
    expect(implicit.topic.id).not.toBe(second.id);

    const latest = StreamPage.parse(await (await streamRequest(running, "?limit=2")).json());
    expect(latest.entries.map(({ position }) => position)).toEqual([3, 4]);
    expect(latest.before).toBe(3);
    const older = StreamPage.parse(await (await streamRequest(running, `?limit=2&before=${latest.before}`)).json());
    expect(older.entries.map(({ position }) => position)).toEqual([1, 2]);
    expect(older.before).toBeNull();
    const project = StreamPage.parse(await (await streamRequest(running, "?repository=OWNER%2FProject&limit=1")).json());
    expect(project.entries).toEqual([implicit]);
    expect(project.before).toBe(implicit.position);
    const olderProject = StreamPage.parse(await (await streamRequest(running, `?repository=owner%2Fproject&before=${project.before}`)).json());
    expect(olderProject.entries).toEqual([secondEntry]);
    const daily = StreamPage.parse(await (await streamRequest(running, "?repository=")).json());
    expect(daily.entries).toEqual([first, explicit]);
    expect((await streamRequest(running, "?repository=missing-owner")).status).toBe(400);
    expect((await streamRequest(running, "", { text: "Unknown", topic: "missing" })).status).toBe(404);

    running.database.connection.prepare("UPDATE conversations SET topic_state = 'archived' WHERE id = ?").run(second.id);
    expect((await streamRequest(running, "", { text: "Reopen", topic: second.id })).status).toBe(202);
    expect(running.conversations.get(second.id)?.topicState).toBe("active");
  });

  it("routes among active topics within scope and names a repository from active topics and open tickets", async () => {
    const running = await start();
    const daily = running.conversations.create().id;
    running.conversations.send(daily, "Daily context");
    const project = openTicket(running, undefined, "owner/project").conversation!;
    const archived = openTicket(running, undefined, "owner/archive").conversation!;
    const ticketWithoutTopic = openTicket(running, undefined, "owner/tickets");
    running.database.connection.prepare("UPDATE tickets SET conversation_id = NULL WHERE id = ?").run(ticketWithoutTopic.id);
    running.database.connection.prepare("DELETE FROM conversations WHERE id = ?").run(ticketWithoutTopic.conversation);
    running.database.connection.prepare("UPDATE conversations SET topic_state = 'archived' WHERE id = ?").run(archived);
    const decisions = () => running.database.connection.prepare("SELECT scope, candidates, rule, topic, placed_in FROM routing_decisions ORDER BY rowid").all();

    const dailyReply = await running.conversations.sendToStream(undefined, "Another daily message", [], { scope: { kind: "daily" } });
    expect(dailyReply?.topic.id).toBe(daily);
    const projectReply = await running.conversations.sendToStream(undefined, "Continue", [], { scope: { kind: "repository", repository: "OWNER/Project" } });
    expect(projectReply?.topic.id).toBe(project);

    const codeReply = await running.conversations.sendToStream(undefined, "Work for owner/tickets", [], { scope: { kind: "code" } });
    expect(codeReply).toMatchObject({
      topic: { title: "Work for owner/tickets", repository: "owner/tickets" },
      entry: { text: "Work for owner/tickets" },
    });
    expect(codeReply?.entry).not.toHaveProperty("possibleMatch");
    const pending = await running.conversations.sendToStream(undefined, "Something unrelated", [], { scope: { kind: "code" } });
    expect(pending?.topic).toMatchObject({ title: "Something unrelated", repository: null, needsRepository: true });
    expect(decisions()).toEqual([
      { scope: "daily", candidates: 1, rule: "c", topic: daily, placed_in: daily },
      { scope: "repository", candidates: 1, rule: "b", topic: project, placed_in: project },
      { scope: "code", candidates: 0, rule: "d", topic: null, placed_in: codeReply?.topic.id },
      { scope: "code", candidates: 2, rule: "d", topic: null, placed_in: pending?.topic.id },
    ]);
    expect(running.conversations.stream(undefined, undefined, null).entries.map(({ topic }) => topic.id)).not.toContain(pending?.topic.id);
    expect(openTicket(running, pending?.topic.id).conversation).toBe(pending?.topic.id);
    expect(openTicket(running, daily, "owner/project").conversation).toBe(daily);
    expect(running.conversations.get(daily)?.repository).toBe("owner/project");
  });

  it("previews the fallback route for empty and attachment drafts without changing the database", async () => {
    const running = await start();
    const service = running.conversations;
    const topic = openTicket(running, undefined, "owner/project").conversation!;
    service.rename(topic, "Project planning");
    service.create();
    const scope = { kind: "repository", repository: "OWNER/Project" } as const;
    const changes = () => running.database.connection.prepare("SELECT total_changes() AS count").get();
    const before = changes();
    const preview = async (attachmentNames: string[]) => {
      const response = await streamRequest(running, "/preview", { scope, text: "", attachmentNames });
      expect(response.status).toBe(200);
      return StreamPreview.parse(await response.json());
    };

    expect(await preview([])).toMatchObject({
      title: "Project planning", proposal: { candidates: 1, decided: { configuration: "bigram", rule: "b", topic }, fallback: "model not configured" },
    });
    expect(await preview(["notes.txt"])).toMatchObject({
      title: null, proposal: { candidates: 1, decided: { configuration: "bigram", rule: "d", topic: null } },
    });
    expect(changes()).toEqual(before);
    expect((await streamRequest(running, "/preview", { scope, text: "", attachmentNames: [1] })).status).toBe(400);
  });

  it("sends the shown destination without rerouting and records both kinds of owner override", async () => {
    const running = await start();
    const service = running.conversations;
    const { messages } = connect(running);
    const scope = { kind: "repository", repository: "owner/project" } as const;
    const shown = openTicket(running, undefined, scope.repository).conversation!;
    const { proposal } = StreamPreview.parse(await (await streamRequest(running, "/preview", { text: "Yes", attachmentNames: [], scope })).json());
    expect(proposal.decided.topic).toBe(shown);
    clock.advance(1);
    const newer = openTicket(running, undefined, scope.repository).conversation!;
    const send = async (body: object) => {
      const response = await streamRequest(running, "", { text: "Yes\nNow", scope, ...body });
      expect(response.status).toBe(202);
      return StreamEntry.parse(await response.json());
    };
    const accepted = await send({ topic: shown, proposal });
    const changed = await send({ topic: newer, proposal });
    const opened = await send({ newTopic: true, proposal });
    const routed = await send({});
    expect(accepted).toMatchObject({ topic: { id: shown }, entry: { placement: "owner" } });
    expect(changed).toMatchObject({ topic: { id: newer }, entry: { placement: "owner" } });
    expect(opened).toMatchObject({ topic: { title: "Yes", repository: scope.repository }, entry: { placement: "owner" } });
    expect(opened.entry).not.toHaveProperty("possibleMatch");
    expect(routed).toMatchObject({ topic: { id: opened.topic.id }, entry: { placement: "router-joined" } });
    const inputs = messages.flatMap((message) => message.type === "input" ? [message.input] : []);
    expect(inputs.map(({ id }) => id)).toEqual([accepted.entry.id, changed.entry.id, opened.entry.id, routed.entry.id]);
    for (const input of inputs.slice(0, 3)) expect(input).not.toHaveProperty("routing");
    expect(inputs[3]?.routing).toEqual({ placement: "existing", rule: "b" });
    expect(running.database.connection.prepare("SELECT topic, placed_in, owner_changed, owner_placed, rule FROM routing_decisions ORDER BY rowid").all()).toEqual([
      { topic: shown, placed_in: shown, owner_changed: 0, owner_placed: 1, rule: "b" },
      { topic: shown, placed_in: newer, owner_changed: 1, owner_placed: 1, rule: "b" },
      { topic: shown, placed_in: opened.topic.id, owner_changed: 1, owner_placed: 1, rule: "b" },
      { topic: opened.topic.id, placed_in: opened.topic.id, owner_changed: 0, owner_placed: 0, rule: "b" },
    ]);
  });

  it("opens a new topic as previewed even when a matching topic becomes available before sending", async () => {
    const running = await start();
    const service = running.conversations;
    const { messages } = connect(running);
    const scope = { kind: "code" } as const;
    const { proposal } = await service.previewStream({ text: "Continue", attachmentNames: [], scope });
    expect(proposal.decided.topic).toBeNull();
    const existing = openTicket(running, undefined, "owner/project").conversation!;
    const response = await streamRequest(running, "", { text: "Continue", newTopic: true, proposal, scope });
    expect(response.status).toBe(202);
    const opened = StreamEntry.parse(await response.json());
    expect(opened.topic.id).not.toBe(existing);
    expect(opened).toMatchObject({ topic: { title: "Continue", repository: null, needsRepository: true }, entry: { placement: "owner" } });
    expect(messages.at(-1)).toMatchObject({ type: "input", input: { id: opened.entry.id } });
    expect(messages.at(-1)).not.toHaveProperty("input.routing");
    expect(running.database.connection.prepare("SELECT topic, placed_in, owner_changed, owner_placed FROM routing_decisions").get())
      .toEqual({ topic: null, placed_in: opened.topic.id, owner_changed: 0, owner_placed: 1 });
  });

  it.each(["archived", "merged"] as const)("refuses a shown destination that was %s without recording or placing the message", async (state) => {
    const running = await start();
    const service = running.conversations;
    const replacement = service.create().id;
    const shown = service.create().id;
    const scope = { kind: "daily" } as const;
    const request = { text: "Yes", attachmentNames: [], scope };
    const { proposal } = await service.previewStream(request);
    expect(proposal.decided.topic).toBe(shown);
    expect(state === "archived" ? service.archive(shown).ok : service.merge(shown, replacement).ok).toBe(true);
    const response = await streamRequest(running, "", { text: request.text, topic: shown, proposal, scope });
    expect(response.status).toBe(404);
    expect(service.stream().entries).toEqual([]);
    expect(running.database.connection.prepare("SELECT * FROM routing_decisions").all()).toEqual([]);
    expect((await service.previewStream(request)).proposal.decided.topic).toBe(replacement);
  });

  it("recovers a message recorded before routing completed", async () => {
    const first = await start();
    first.database.connection.prepare("INSERT INTO pending_topic_inputs (id, body, created_at) VALUES (?, ?, ?)").run(
      "pending", JSON.stringify({ message: "Saved before restart", attachments: [], scope: { kind: "code" } }), clock.now(),
    );
    await first.close();
    const running = await start();
    expect(running.conversations.stream().entries).toMatchObject([
      { topic: { title: "Saved before restart", needsRepository: true }, entry: { id: "pending", text: "Saved before restart", taken: false } },
    ]);
    expect(running.database.connection.prepare("SELECT * FROM pending_topic_inputs").all()).toEqual([]);
  });

  it("places a repeated send once, answers each repeat with the same entry, and refuses its id with other content", async () => {
    const running = await start();
    const service = running.conversations;
    const { messages } = connect(running);
    const topic = service.create().id;
    const other = service.create().id;
    const headers = { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json" };
    const post = (path: string, body: object) => fetch(`${base(running)}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const twice = async (path: string, body: object) => {
      const answers = [await post(path, body), await post(path, body)];
      expect(answers.map(({ status }) => status)).toEqual([202, 202]);
      const [first, second] = await Promise.all(answers.map((answer) => answer.json()));
      expect(second).toEqual(first);
      return first as unknown;
    };
    const routed = randomUUID();
    const direct = randomUUID();
    const messagePath = `/api/conversations/${topic}/messages`;
    expect(StreamEntry.parse(await twice("/api/stream", { id: routed, text: "Hello" })).entry).toMatchObject({ id: routed, text: "Hello" });
    expect(EntryResponse.parse(await twice(messagePath, { id: direct, text: "Direct" })).entry)
      .toMatchObject({ id: direct, conversation: topic, text: "Direct" });
    const quoted = randomUUID();
    expect(StreamEntry.parse(await twice("/api/stream", { id: quoted, text: "Quoting", quotedMessage: direct })).entry).toMatchObject({ id: quoted, conversation: topic, quotedMessage: direct });
    service.tell(null, "A notice", "prompt");
    const notice = String(running.database.connection.prepare("SELECT id FROM conversation_entries WHERE kind = 'notice'").get()?.["id"]);
    for (const [path, body] of [
      [messagePath, { id: direct, text: "Changed" }],
      [messagePath, { id: direct, text: "Direct", quotedMessage: routed }],
      [`/api/conversations/${other}/messages`, { id: direct, text: "Direct" }],
      ["/api/stream", { id: direct, text: "Direct", topic: other }],
      ["/api/stream", { id: quoted, text: "Quoting" }],
      ["/api/stream", { id: routed, text: "Hello", quotedMessage: direct }],
      ["/api/stream", { id: notice, text: "A notice" }],
    ] as const) {
      expect((await post(path, body)).status).toBe(409);
    }
    for (const id of ["pending", routed.toUpperCase(), "00000000-0000-0000-0000-000000000000"]) {
      expect((await post("/api/stream", { id, text: "Hello" })).status).toBe(400);
    }
    const placed: string[] = [routed, direct, quoted];
    expect(running.database.connection.prepare(`SELECT id FROM conversation_entries WHERE kind = 'owner' ORDER BY stream_seq`).all().map(({ id }) => id)).toEqual(placed);
    expect(messages.flatMap((message) => message.type === "input" && placed.includes(message.input.id) ? [message.input.id] : [])).toEqual(placed);
  });

  it("answers a send repeated after a restart with the entry placed from its pending input", async () => {
    const first = await start();
    const id = randomUUID();
    first.database.connection.prepare("INSERT INTO pending_topic_inputs (id, body, created_at) VALUES (?, ?, ?)").run(
      id, JSON.stringify({ message: "Saved before restart", attachments: [], scope: { kind: "daily" } }), clock.now(),
    );
    await first.close();
    const running = await start();
    const again = await streamRequest(running, "", { id, text: "Saved before restart" });
    expect(again.status).toBe(202);
    expect(StreamEntry.parse(await again.json()).entry).toMatchObject({ id, text: "Saved before restart" });
    expect(running.conversations.stream().entries.map(({ entry }) => entry.id)).toEqual([id]);
    expect((await streamRequest(running, "", { id, text: "Something else" })).status).toBe(409);
  });

  it("watches all topics together, replays by global cursor and continues with deltas", async () => {
    const running = await start();
    const first = running.conversations.create().id;
    const second = running.conversations.create().id;
    running.conversations.send(first, "First");
    running.conversations.send(second, "Second");
    const { socket, received } = await pageSocket(running);
    socket.send(JSON.stringify({ type: "watch.stream" }));
    await until(() => received.some(({ type }) => type === "stream.page"), socket);
    expect(received.find(({ type }) => type === "stream.page")).toMatchObject({
      entries: [{ position: 1, topic: { id: first, title: "First" } }, { position: 2, topic: { id: second, title: "Second" } }],
    });
    const brain = running.conversations.attach({ send: () => undefined, close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    for (const conversation of [second, first]) {
      const turn = `turn-${conversation}`;
      brain.receive({ type: "turn.started", conversation, turn, provider: "claude", model: "model", inputs: [] });
      brain.receive({ type: "text", conversation, turn, block: "reply", delta: "Part one. " });
      brain.receive({ type: "text", conversation, turn, block: "reply", delta: "Part two." });
    }
    await until(() => received.filter(({ type }) => type === "delta").length === 2, socket);
    const live = received.filter((message) => message.type === "stream.entry");
    expect(live.map(({ position, topic }) => [position, topic.id])).toEqual([[3, second], [4, first]]);
    expect(received.filter((message) => message.type === "delta").map(({ conversation }) => conversation)).toEqual([second, first]);

    const resumed = await pageSocket(running);
    resumed.socket.send(JSON.stringify({ type: "watch.stream", after: 3 }));
    await until(() => resumed.received.some(({ type }) => type === "stream.entry"), resumed.socket);
    expect(resumed.received.filter((message) => message.type === "stream.entry")).toMatchObject([
      { position: 4, topic: { id: first }, entry: { text: "Part one. Part two." } },
    ]);
    expect(resumed.received.find(({ type }) => type === "turn")).toMatchObject({ turn: { conversation: first } });
  });

  it("pages and replays each subscription in its own scope, including a turn with no visible text yet", async () => {
    const running = await start();
    const daily = running.conversations.create().id;
    const project = openTicket(running, undefined, "owner/project").conversation!;
    const other = openTicket(running, undefined, "owner/other").conversation!;
    running.conversations.send(daily, "Earlier daily message");
    for (let index = 0; index < 52; index += 1) {
      running.conversations.send(project, `Repository message ${index}`);
    }
    running.conversations.send(other, "Other repository");
    const pending = await running.conversations.sendToStream(undefined, "Choose a repository", [], { scope: { kind: "code" } });
    const brain = running.conversations.attach({ send: () => undefined, close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    brain.receive({ type: "turn.started", conversation: project, turn: "working", provider: "claude", model: "model", inputs: [] });

    const { socket, received } = await pageSocket(running);
    socket.send(JSON.stringify({ type: "watch.stream", scope: { kind: "daily" }, subscription: 1 }));
    await until(() => received.some(({ type }) => type === "stream.page"), socket);
    expect(received.at(-1)).toMatchObject({
      type: "stream.page", subscription: 1, before: null, turns: [], entries: [{ topic: { id: daily } }],
    });
    socket.send(JSON.stringify({ type: "watch.stream", scope: { kind: "repository", repository: "OWNER/Project" }, subscription: 2 }));
    await until(() => received.some((message) => message.type === "stream.page" && message.subscription === 2), socket);
    const projectPage = received.find((message) => message.type === "stream.page" && message.subscription === 2);
    expect(projectPage?.type === "stream.page" && projectPage.entries).toHaveLength(50);
    expect(projectPage).toMatchObject({ before: 4, turns: [{ id: "working", conversation: project }] });

    socket.send(JSON.stringify({ type: "read.stream", before: 4 }));
    await until(() => received.filter((message) => message.type === "stream.page" && message.subscription === 2).length === 2, socket);
    expect(received.at(-1)).toMatchObject({
      type: "stream.page", subscription: 2, before: null, entries: [{ position: 2, topic: { id: project } }, { position: 3, topic: { id: project } }],
    });

    socket.send(JSON.stringify({ type: "watch.stream", after: 53, scope: { kind: "code" }, subscription: 3 }));
    await until(() => received.some((message) => message.type === "stream.page" && message.subscription === 3), socket);
    expect(received.at(-1)).toMatchObject({
      type: "stream.page", subscription: 3, resumed: true, entries: [{ topic: { id: other } }, { topic: { id: pending?.topic.id } }],
    });
    running.conversations.send(daily, "New daily message");
    running.conversations.send(project, "New project message");
    await until(() => received.some((message) => message.type === "stream.entry" && message.subscription === 3), socket);
    expect(received.flatMap((message) => message.type === "stream.entry" && message.subscription === 3 ? [message.topic.id] : []))
      .toEqual([project]);
  });

  it("persists topic ownership for old tickets and repairs, and routes new-model notices into one System topic", async () => {
    const running = await start();
    const topic = running.conversations.create();
    const original = openTicket(running, topic.id, "owner/project");
    const unrelated = running.conversations.create();
    const conflicting = openTicket(running, topic.id, "owner/other");
    expect(original.conversation).toBe(topic.id);
    expect(conflicting).toMatchObject({ conversation: topic.id, repository: "owner/other" });
    expect(running.conversations.get(topic.id)?.repository).toBe("owner/project");
    running.conversations.tell(conflicting.id, "Cross-repository notice", "[hub] Cross-repository notice");
    const stream = (repository: string) => running.conversations.stream(undefined, undefined, repository).entries;
    expect(stream("owner/project")).toContainEqual(expect.objectContaining({ topic: expect.objectContaining({ id: topic.id }), entry: expect.objectContaining({ text: "Cross-repository notice" }) }));
    expect(stream("owner/other")).toEqual([]);
    expect(running.conversations.tell(original.id, "Ticket notice", "[hub] Ticket notice")).toBe(topic.id);
    expect(running.conversations.entries(unrelated.id)).toEqual([]);

    running.database.connection.prepare("UPDATE tickets SET conversation_id = NULL WHERE id = ?").run(original.id);
    const assigned = running.conversations.tell(original.id, "Legacy notice", "[hub] Legacy notice");
    expect(running.tickets.get(original.id)?.conversation).toBe(assigned);
    expect(running.conversations.get(assigned)).toMatchObject({ title: original.title.zh, repository: original.repository });
    expect(running.conversations.tell(original.id, "Another notice", "[hub] Another notice")).toBe(assigned);
    running.tickets.stop(original.id, { en: "Stopped", zh: "停止" });
    expect(running.tickets.repair(original.id, "owner", "Carry on")).toMatchObject({ ok: true, ticket: { conversation: assigned } });

    const report = (model: string) => MachineReport.parse({
      hostname: "pc", platform: "darwin", release: "", arch: "", user: "", slots: { total: 1, free: 1 },
      programs: [{ id: "codex", installed: true, path: null, version: null, models: [{ id: model, efforts: ["high"] }], source: "program", problem: null }],
    });
    const runnerFor = (name: string, model: string) => {
      running.machines.add({ name, accessClientId: `${name}.access` });
      const machine = running.machines.get(name);
      if (machine === undefined) {
        throw new Error("Missing test machine");
      }
      running.runners.attach(machine, { send: () => undefined, close: () => undefined }).receive({
        type: "hello", protocol: protocolVersion, machine: report(model), works: [],
      });
    };
    runnerFor("pc", "old");
    expect(running.conversations.list().some(({ title }) => title === "System")).toBe(false);
    runnerFor("mac", "new");
    runnerFor("studio", "newer");
    const systems = running.conversations.list().filter(({ title }) => title === "System");
    expect(systems).toMatchObject([{ repository: null }]);
    expect(systems).toHaveLength(1);
    expect(running.conversations.entries(systems[0]?.id ?? "")).toMatchObject([
      { kind: "notice", text: expect.stringContaining("new") },
      { kind: "notice", text: expect.stringContaining("newer") },
    ]);
  });
});

describe("topic titles", () => {
  it("protects existing titles even when they match the opening message of a routed topic", async () => {
    const earlier = openDatabase({ dataDir, clock, migrations: migrations.filter(({ version }) => version <= 38) });
    earlier.connection.exec(`
      INSERT INTO conversations (id, title, state, created_at, updated_at) VALUES
        ('existing', 'Opening line', 'idle', 100, 100), ('empty', '', 'idle', 100, 100);
      INSERT INTO conversation_entries (id, conversation_id, seq, kind, body, prompt, taken, created_at, stream_seq) VALUES
        ('opening', 'existing', 1, 'owner', '{"text":"Opening line"}', 'Opening line', 0, 100, 1);
      INSERT INTO routing_decisions (entry, decided_at, scope, candidates, configuration, rule, placed_in, owner_placed) VALUES
        ('opening', 100, 'daily', 0, 'bigram', 'd', 'existing', 0);
    `);
    earlier.close();
    const running = await start();
    const { conversations, database } = running;
    expect(database.connection.prepare("SELECT id, title_origin FROM conversations ORDER BY id").all()).toEqual([
      { id: "empty", title_origin: "automatic" }, { id: "existing", title_origin: "owner" },
    ]);
    const { link, messages } = connect(running);
    link.receive({ type: "turn.started", conversation: "existing", turn: "legacy", inputs: ["opening"], provider: "gpt", model: "model" });
    link.receive({ type: "prepare", request: "legacy", conversation: "existing", provider: "gpt", exclude: ["opening"], fresh: false });
    expect(messages.at(-1)).toMatchObject({ type: "prepared" });
    expect(messages.at(-1)).not.toHaveProperty("automaticTitle");
    expect(conversations.proposeTitle("existing", "legacy", "Other title")).toBe(false);
    expect(conversations.get("existing")?.title).toBe("Opening line");
  });

  it("tracks the origin of titles across topic creation paths", async () => {
    const running = await start();
    const service = running.conversations;
    const origin = (id: string) => running.database.connection.prepare("SELECT title_origin FROM conversations WHERE id = ?").get(id)?.["title_origin"];
    const routed = (await service.sendToStream(undefined, "Opening line\nSecond line", []))!;
    expect(routed.topic.title).toBe("Opening line");
    expect(origin(routed.topic.id)).toBe("automatic");
    const explicit = (await service.sendToStream(undefined, "Explicit topic", [], { newTopic: true }))!;
    expect(origin(explicit.topic.id)).toBe("automatic");
    const split = service.move(routed.entry.id, null);
    expect(split.ok && origin(split.value)).toBe("automatic");
    const direct = service.create();
    service.send(direct.id, "Direct message");
    expect(origin(direct.id)).toBe("automatic");
    const ticket = openTicket(running);
    expect(origin(running.tickets.topic(ticket.id))).toBe("owner");
    expect(origin(service.tell(null, "System notice", "System prompt"))).toBe("owner");
  });

  it.each(["failed", "interrupted"] as const)("discards the proposed title when the turn is %s and asks in the next turn", async (outcome) => {
    const running = await start();
    const { link, messages } = connect(running);
    const service = running.conversations;
    const first = (await service.sendToStream(undefined, "Opening line", []))!;
    const conversation = first.topic.id;
    link.receive({ type: "turn.started", conversation, turn: "first", inputs: [first.entry.id], provider: "gpt", model: "model" });
    expect(service.proposeTitle(conversation, "first", "Discard this title")).toBe(true);
    link.receive({ type: "turn.finished", conversation, turn: "first", outcome, reason: null });
    const next = service.send(conversation, "Try again")!;
    link.receive({ type: "turn.started", conversation, turn: "second", inputs: [next.id], provider: "gpt", model: "model" });
    link.receive({ type: "prepare", request: "second", conversation, provider: "gpt", exclude: [next.id], fresh: false });
    expect(messages.at(-1)).toMatchObject({ type: "prepared", automaticTitle: true });
    link.receive({ type: "turn.finished", conversation, turn: "second", outcome: "completed", reason: null });
    expect(service.get(conversation)?.title).toBe("Opening line");
  });
});

describe("topic context", () => {
  function connected(running: Hub) {
    const sent: HubToBrain[] = [];
    const link = running.conversations.attach({ send: (message) => sent.push(message), close: () => undefined });
    link.receive({ type: "hello", protocol: protocolVersion, running: [] });
    const prepare = (conversation: string, snapshot: boolean, exclude: string[] = []) => {
      link.receive({ type: "prepare", request: "seed", conversation, provider: "gpt", exclude, fresh: false, seed: snapshot });
      const result = sent.at(-1);
      if (result?.type !== "prepared") {
        throw new Error("The hub did not prepare the topic.");
      }
      return result;
    };
    const finish = (conversation: string, turn: string, input: string, answer: string) => {
      link.receive({ type: "turn.started", conversation, turn, inputs: [input], provider: "gpt", model: "model" });
      link.receive({ type: "text", conversation, turn, block: "answer", delta: answer });
      link.receive({ type: "turn.finished", conversation, turn, outcome: "completed", reason: null });
    };
    return { link, prepare, finish };
  }

  it("replays legacy placements without allowing an automatic handover of ambiguous input", async () => {
    const earlier = openDatabase({ dataDir, clock, migrations: migrations.filter(({ version }) => version <= 37) });
    earlier.connection.exec(`
      INSERT INTO conversations (id, title, state, created_at, updated_at) VALUES
        ('source', 'Source', 'idle', 100, 100), ('target', 'Target', 'idle', 100, 100);
      INSERT INTO conversation_entries (id, conversation_id, seq, kind, body, prompt, taken, created_at, stream_seq) VALUES
        ('ambiguous', 'source', 1, 'owner', '{"text":"Pending request"}', 'Pending request', 0, 100, 1),
        ('changed', 'source', 2, 'owner', '{"text":"Explicit override"}', 'Explicit override', 0, 100, 2);
      INSERT INTO routing_decisions (entry, decided_at, scope, candidates, configuration, rule, topic, placed_in, owner_changed) VALUES
        ('ambiguous', 100, 'daily', 2, 'bigram', 'b', 'source', 'source', 0),
        ('changed', 100, 'daily', 2, 'bigram', 'b', 'target', 'source', 1);
    `);
    earlier.close();
    const running = await start();
    const { link, messages } = connect(running);
    const inputs = messages.flatMap((message) => message.type === "input" ? [message.input] : []);
    expect(inputs.map(({ id }) => id)).toEqual(["ambiguous", "changed"]);
    for (const input of inputs) expect(input).not.toHaveProperty("routing");
    expect(running.conversations.entries("source")).toMatchObject([
      { id: "ambiguous", placement: "router-joined" }, { id: "changed", placement: "owner" },
    ]);
    link.receive({ type: "turn.started", conversation: "source", turn: "legacy", inputs: ["ambiguous"], provider: "gpt", model: "model" });
    expect(running.conversations.handover("source", "legacy", "target")).toEqual({ ok: false, error: "conflict" });
    expect(running.database.connection.prepare("SELECT owner_placed FROM routing_decisions ORDER BY rowid").all())
      .toEqual([{ owner_placed: null }, { owner_placed: 1 }]);
  });

  it("sends the routing rule and a clipped candidate summary on first delivery and reconnect", async () => {
    const running = await start();
    const service = running.conversations;
    const { link, messages } = connect(running);
    const opened = (await service.sendToStream(undefined, "Initial topic", []))!;
    expect(messages.at(-1)).toMatchObject({ type: "input", input: { routing: { placement: "new", rule: "d" } } });
    expect(messages.at(-1)).not.toHaveProperty("input.routing.candidate");

    const topic = opened.topic.id;
    const first = service.send(topic, "Planning the release " + "🚀".repeat(170))!;
    const turn = { conversation: topic, turn: "summary-turn" };
    link.receive({ type: "turn.started", ...turn, inputs: [opened.entry.id, first.id], provider: "gpt", model: "model" });
    link.receive({ type: "text", ...turn, block: "answer", delta: "Confirmed " + "🌱".repeat(175) });
    link.receive({ type: "turn.finished", ...turn, outcome: "completed", reason: null });
    const second = service.send(topic, "Continue the release planning " + "🚀".repeat(170))!;
    const next = { conversation: topic, turn: "second-summary-turn" };
    link.receive({ type: "turn.started", ...next, inputs: [second.id], provider: "gpt", model: "model" });
    link.receive({ type: "text", ...next, block: "answer", delta: "Checklist " + "🌱".repeat(175) });
    link.receive({ type: "turn.finished", ...next, outcome: "completed", reason: null });

    const split = (await service.sendToStream(undefined, "Something entirely different", []))!;
    expect(split.entry).toMatchObject({ possibleMatch: topic });
    const delivered = messages.at(-1);
    expect(delivered).toMatchObject({
      type: "input", conversation: split.topic.id,
      input: { id: split.entry.id, routing: { placement: "new", rule: "d", candidate: { id: topic, title: "Initial topic" } } },
    });
    const routing = delivered?.type === "input" ? delivered.input.routing : undefined;
    const summary = routing?.placement === "new" ? routing.candidate?.summary ?? "" : "";
    const full = service.topics.summary(topic).replace(/\s+/gu, " ").trim();
    expect(summary).toBe([...full].slice(0, 319).join("") + "…");
    expect([...summary]).toHaveLength(320);
    const reconnected = connect(running);
    expect(reconnected.messages).toContainEqual(delivered);
    const splitTurn = { conversation: split.topic.id, turn: "split" };
    reconnected.link.receive({ type: "turn.started", ...splitTurn, inputs: [split.entry.id], provider: "gpt", model: "model" });
    expect(service.handover(split.topic.id, splitTurn.turn, topic)).toEqual({ ok: true, value: split.entry.id });
    expect(reconnected.messages.at(-1)).toEqual({ type: "input.withdraw", conversation: split.topic.id, input: split.entry.id });
    reconnected.link.receive({ type: "turn.finished", ...splitTurn, outcome: "interrupted", reason: null });
    reconnected.link.receive({ type: "input.withdrawn", conversation: split.topic.id, input: split.entry.id });
    expect(reconnected.messages.at(-1)).toMatchObject({ type: "input", conversation: topic, input: { entry: split.entry.id } });
    expect(reconnected.messages.at(-1)).not.toHaveProperty("input.routing");
  });

  it("seeds complete turns through 50, then the older summary and the newest 50 turns", async () => {
    const running = await start();
    const topic = running.conversations.create().id;
    const other = running.conversations.create().id;
    const own = openTicket(running, topic);
    const foreign = openTicket(running, other);
    const { link, prepare, finish } = connected(running);
    for (let index = 1; index <= 51; index += 1) {
      const entry = running.conversations.send(topic, `Request ${index}`);
      finish(topic, `turn-${index}`, entry?.id ?? "", `Result ${index}`);
      if (index === 50) {
        const result = prepare(topic, true).seed;
        expect(result).toMatchObject({ summary: "", olderTurns: 0 });
        expect(result?.turns).toHaveLength(50);
        expect(result?.turns[0]).toMatchObject([{ text: "任务：翻译一则通知" }, { text: "Request 1" }, { text: "Result 1" }]);
      }
    }
    const current = running.conversations.send(topic, "Current request");
    running.conversations.send(topic, "Still waiting");
    link.receive({ type: "turn.started", conversation: topic, turn: "current", provider: "gpt", model: "model", inputs: [current?.id ?? ""] });
    const result = prepare(topic, true, [current?.id ?? ""]).seed;
    expect(result?.olderTurns).toBe(1);
    expect(result?.summary).toContain("Request 1 — Result 1");
    expect(result?.turns).toHaveLength(50);
    expect(result?.turns[0]).toMatchObject([{ text: "Request 2" }, { text: "Result 2" }]);
    expect(result?.turns.at(-1)).toMatchObject([{ text: "Request 51" }, { text: "Result 51" }]);
    expect(result?.tickets).toEqual([{ own: true, line: expect.stringContaining(`ticket ${ticketReference(own)} `) }, { own: false, line: expect.stringContaining(`ticket ${ticketReference(foreign)} `) }]);
  });

  it("tracks board changes by revision and resets the saved destination session on merge", async () => {
    const running = await start();
    const reader = running.conversations.create().id;
    const writer = running.conversations.create().id;
    const { link, prepare, finish } = connected(running);
    const read = running.conversations.send(reader, "Read the board");
    expect(prepare(reader, true).board?.map(({ id }) => id)).toEqual([writer, reader]);
    link.receive({ type: "session", conversation: reader, provider: "gpt", session: "saved" });
    finish(reader, "reader-1", read?.id ?? "", "");
    expect(prepare(reader, false).board).toEqual([expect.objectContaining({ id: reader, status: "Turn completed" })]);

    const write = running.conversations.send(writer, "Other topic");
    finish(writer, "writer-1", write?.id ?? "", "Completed the release.\nSupporting details.");
    expect(prepare(reader, false).board).toContainEqual(expect.objectContaining({ id: writer, status: "Completed the release." }));
    finish(reader, "reader-2", "", "");
    expect(prepare(reader, false).board).toEqual([]);

    const db = running.database.connection;
    db.prepare("UPDATE conversations SET title = ?, topic_state = 'archived' WHERE id = ?").run("Renamed", writer);
    expect(prepare(reader, false).board).toEqual([expect.objectContaining({ id: writer, state: "archived", title: "Renamed" })]);
    db.prepare("UPDATE turns SET conversation_id = ? WHERE conversation_id = ?").run(reader, writer);
    db.prepare("UPDATE conversation_entries SET conversation_id = ?, seq = seq + 100 WHERE conversation_id = ?").run(reader, writer);
    db.prepare("UPDATE conversations SET merged_into = ? WHERE id = ?").run(reader, writer);
    const merged = prepare(reader, false);
    expect(merged.session).toBeNull();
    expect(merged.board).toContainEqual(expect.objectContaining({ id: writer, mergedInto: reader }));
    expect(merged.seed?.turns.flat()).toContainEqual(expect.objectContaining({ text: "Completed the release.\nSupporting details." }));
    expect(running.conversations.topics.summary(reader)).toContain("Completed the release.");
  });

  it("exposes board, archived history, search and complete omitted records through MCP", async () => {
    const running = await start();
    const topic = running.conversations.create().id;
    const { finish } = connected(running);
    const body = "Launch details 🚀 with the full numbered checklist.";
    const entry = running.conversations.send(topic, body);
    finish(topic, "launch", entry?.id ?? "", "The owner approved the launch.");
    running.database.connection.prepare("UPDATE conversations SET topic_state = 'archived' WHERE id = ?").run(topic);
    const ticket = openTicket(running);
    running.memories.add("你希望记录每次发布的时间。");

    const call = async (name: string, args: object) => {
      const response = await mcp(running, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      expect(response.status).toBe(200);
      const payload = await response.json() as { result: { isError: boolean; content: { text: string }[] } };
      expect(payload.result.isError).toBe(false);
      return JSON.parse(payload.result.content[0]?.text ?? "");
    };

    expect(JSON.parse((await call("read_topic_board", {})).text)).toContainEqual(expect.objectContaining({ id: topic, state: "archived" }));
    const matching = await call("search_topic_history", { query: "LAUNCH", limit: 1 });
    expect(matching.messages).toEqual([expect.objectContaining({ topic, kind: "text" })]);
    expect((await call("search_topic_history", { query: "launch", before: matching.before })).messages[0]?.id).toBe(entry?.id);
    const recent = await call("read_topic_history", { topic, limit: 1 });
    expect(recent.messages).toEqual([expect.objectContaining({ preview: "The owner approved the launch." })]);
    expect((await call("read_topic_history", { topic, summary: true })).text).toContain("The owner approved the launch.");
    const firstPart = await call("read_topic_history", { message: entry?.id, length: 70 });
    const secondPart = await call("read_topic_history", { message: entry?.id, offset: firstPart.nextOffset });
    expect(JSON.parse(firstPart.text + secondPart.text).item.text).toBe(body);
    expect(secondPart.nextOffset).toBeNull();
    expect((await call("read_seed_material", { section: "tickets" })).text).toContain(`ticket ${ticketReference(ticket)} `);
    expect((await call("read_seed_material", { section: "memory" })).text).toContain("你希望记录每次发布的时间。");
  });
});

describe("topic corrections and archive policy", () => {
  it("keeps repository-less tasks and their repairs in the filing topic", async () => {
    const hub = await start();
    const daily = hub.conversations.create().id;
    const first = openTicket(hub, daily);
    const second = openTicket(hub, daily);
    expect([first.conversation, second.conversation]).toEqual([daily, daily]);
    expect(hub.conversations.entries(daily).filter((entry) => entry.kind === "notice" && entry.start === true)).toHaveLength(2);
    hub.tickets.stop(first.id, { en: "Stopped", zh: "停止" });
    const repair = hub.tickets.repair(first.id, "owner", "Continue");
    expect(repair).toMatchObject({ ok: true, ticket: { conversation: daily, repository: null } });
    const pending = (await hub.conversations.sendToStream(undefined, "A code request", [], { scope: { kind: "code" }, newTopic: true }))!.topic.id;
    const task = openTicket(hub, pending);
    expect(task.conversation).toBe(pending);
    expect(hub.conversations.get(pending)).toMatchObject({ repository: null, needsRepository: true });
    expect(hub.conversations.entries(pending).filter((entry) => entry.kind === "notice"))
      .toMatchObject([{ ticket: task.id, start: true }]);
    const project = hub.conversations.create().id;
    const repositoryTask = openTicket(hub, project, "owner/project");
    expect(repositoryTask.conversation).toBe(project);
    expect(hub.conversations.entries(project)).toEqual([]);
  });

  it("claims daily conversations for repository tickets unless existing tickets conflict", async () => {
    const hub = await start();
    const service = hub.conversations;
    const topic = service.create().id;
    const entry = service.send(topic, "Repository discussion")!;
    const conflict = service.create().id;
    service.send(conflict, "Personal task");
    openTicket(hub, conflict);
    const { socket, received } = await pageSocket(hub);
    const revision = service.historyRevision();
    const ticket = openTicket(hub, topic, "owner/project");
    const other = openTicket(hub, conflict, "owner/project");
    expect(ticket.conversation).toBe(topic);
    expect(other.conversation).toBe(conflict);
    expect(service.get(conflict)?.repository).toBeNull();
    expect(service.historyRevision()).toBeGreaterThan(revision);
    expect(service.stream(undefined, undefined, { kind: "repository", repository: "owner/project" }).entries).toContainEqual(expect.objectContaining({ entry: expect.objectContaining({ id: entry.id }) }));
    expect(service.stream(undefined, undefined, { kind: "daily" }).entries).not.toContainEqual(expect.objectContaining({ entry: expect.objectContaining({ id: entry.id }) }));
    await until(() => received.some((message) => message.type === "conversation" && message.conversation.id === topic && message.conversation.repository === "owner/project"), socket);
  });

  it("moves topics through the brain tool and rejects conflicting and protected topics", async () => {
    const hub = await start();
    const service = hub.conversations;
    const { link } = connect(hub);
    const current = service.create().id;
    const input = service.send(current, "Move these topics")!;
    link.receive({ type: "turn.started", conversation: current, turn: "move-turn", provider: "gpt", model: "model", inputs: [input.id] });
    const topic = service.create().id;
    const entry = service.send(topic, "Project discussion")!;
    const conflict = service.create().id;
    openTicket(hub, conflict);
    const repositoryTopic = openTicket(hub, undefined, "owner/project").conversation!;
    const merged = service.create().id;
    hub.database.connection.prepare("UPDATE conversations SET merged_into = ? WHERE id = ?").run(topic, merged);
    const system = service.tell(null, "System notice", "System prompt");
    const { socket, received } = await pageSocket(hub);
    const call = async (target: string, repository: string | null) => {
      const response = await fetch(`${base(hub)}${brainToolsPath}`, {
        method: "POST",
        headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json", "x-super-agent-conversation": current, "x-super-agent-turn": "move-turn" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_topic_repository", arguments: { topic: target, repository } } }),
      });
      return (await response.json() as { result: { isError: boolean; content: { text: string }[] } }).result;
    };
    expect(await call(topic, "owner/project")).toMatchObject({ isError: false });
    expect(service.get(topic)?.repository).toBe("owner/project");
    expect(service.stream(undefined, undefined, { kind: "repository", repository: "owner/project" }).entries).toContainEqual(expect.objectContaining({ entry: expect.objectContaining({ id: entry.id }) }));
    await until(() => received.some((message) => message.type === "conversation" && message.conversation.id === topic && message.conversation.repository === "owner/project"), socket);
    expect((await call(conflict, "owner/project")).content[0]?.text).toContain("tickets");
    expect((await call(merged, "owner/project")).content[0]?.text).toContain("Merged");
    expect((await call(system, "owner/project")).content[0]?.text).toContain("System");
    expect((await call(repositoryTopic, null)).content[0]?.text).toContain("tickets");
    expect(await call(topic, null)).toMatchObject({ isError: false });
    expect(service.get(topic)?.repository).toBeNull();
  });

  it("archives eligible topics through the brain tool and reports each guarded topic", async () => {
    const hub = await start();
    const service = hub.conversations;
    const { link } = connect(hub);
    const current = service.create().id;
    const first = service.create().id;
    const second = service.create().id;
    const busy = service.create().id;
    const waiting = service.create().id;
    const archived = service.create().id;
    const merged = service.create().id;
    const system = service.tell(null, "System notice", "System prompt");
    const input = service.send(first, "Completed request")!;
    link.receive({ type: "turn.started", conversation: first, turn: "finished", provider: "gpt", model: "model", inputs: [input.id] });
    link.receive({ type: "text", conversation: first, turn: "finished", block: "answer", delta: "Saved answer" });
    link.receive({ type: "turn.finished", conversation: first, turn: "finished", outcome: "completed", reason: null });
    const busyInput = service.send(busy, "Working")!;
    link.receive({ type: "turn.started", conversation: busy, turn: "busy", provider: "gpt", model: "model", inputs: [busyInput.id] });
    service.send(waiting, "Waiting");
    service.archive(archived);
    hub.database.connection.prepare("UPDATE conversations SET merged_into = ? WHERE id = ?").run(second, merged);
    hub.database.connection.prepare("UPDATE turns SET topic_summary = NULL WHERE id = ?").run("finished");
    const { socket, received } = await pageSocket(hub);
    const topics = [first, second, current, busy, waiting, "unknown", archived, merged, system];
    const response = await fetch(`${base(hub)}${brainToolsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json", "x-super-agent-conversation": current, "x-super-agent-turn": "current-turn" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "archive_topics", arguments: { topics } } }),
    });
    const payload = await response.json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(payload.result.content[0]!.text)).toEqual(topics.map((topic, index) => ({ topic, result: ["archived", "archived", "current topic", "turn running", "untaken entries", "not found", "already archived", "merged", "system topic"][index] })));
    expect(service.get(first)?.topicState).toBe("archived");
    expect(service.get(second)?.topicState).toBe("archived");
    expect(service.get(busy)?.topicState).toBe("active");
    expect(service.get(waiting)?.topicState).toBe("active");
    expect(hub.database.connection.prepare("SELECT topic_summary FROM turns WHERE id = ?").get("finished")?.["topic_summary"]).toContain("Saved answer");
    await until(() => received.some((message) => JSON.stringify(message).includes(first) && JSON.stringify(message).includes("archived")), socket);
  });

  async function topicRequest(running: Hub, id: string, action = "", body?: object) {
    return fetch(`${base(running)}/api/conversations/${id}${action}`, {
      headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json", origin: base(running) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  }

  it("archives idle topics with open tickets, saves a missing summary and wakes on each form of direct activity", async () => {
    const running = await start();
    const service = running.conversations;
    const { link, messages } = connect(running);
    const idle = service.create().id;
    const ticket = openTicket(running, idle);
    const owner = service.send(idle, "A searchable request")!;
    const inProgress = service.create().id;
    const inProgressInput = service.send(inProgress, "Still working")!;
    const pending = service.create().id;
    service.send(pending, "Waiting in the queue");
    const system = service.tell(null, "A system notice", "System prompt");
    const systemInput = service.entries(system)[0]!;
    for (const [topic, turn, input] of [[idle, "idle-turn", owner.id], [inProgress, "working-turn", inProgressInput.id], [system, "system-turn", systemInput.id]] as const) {
      link.receive({ type: "turn.started", conversation: topic, turn, provider: "gpt", model: "model", inputs: [input] });
      if (topic !== inProgress) {
        link.receive({ type: "text", conversation: topic, turn, block: "answer", delta: "Saved reply" });
        link.receive({ type: "turn.finished", conversation: topic, turn, outcome: "completed", reason: null });
      }
    }
    const db = running.database.connection;
    db.prepare("UPDATE turns SET topic_summary = NULL WHERE id = ?").run("idle-turn");
    clock.advance(86_399_999);
    service.archiveIdle();
    expect(service.get(idle)?.topicState).toBe("active");
    clock.advance(1);
    service.archiveIdle();
    expect(service.get(idle)?.topicState).toBe("archived");
    expect(service.get(pending)?.topicState).toBe("active");
    expect(service.get(inProgress)?.topicState).toBe("active");
    expect(service.get(system)).toMatchObject({ system: true, topicState: "active" });
    expect(service.list()).toContainEqual(expect.objectContaining({ id: idle, topicState: "archived" }));
    expect(running.tickets.get(ticket.id)?.conversation).toBe(idle);
    expect(service.topics.search("searchable", idle, Number.MAX_SAFE_INTEGER, 5).messages[0]?.id).toBe(owner.id);
    expect(db.prepare("SELECT topic_summary FROM turns WHERE id = ?").get("idle-turn")?.["topic_summary"]).toContain("Saved reply");

    const routed = await service.sendToStream(undefined, "Something new", []);
    expect(routed?.topic.id).not.toBe(idle);
    expect(db.prepare("SELECT candidates, rule FROM routing_decisions WHERE entry = ?").get(routed!.entry.id)).toEqual({ candidates: 2, rule: "d" });

    expect((await topicRequest(running, idle, "/rename", { title: "  New title  " })).status).toBe(200);
    expect(service.get(idle)).toMatchObject({ title: "New title", topicState: "archived" });
    service.send(idle, "A direct message");
    expect(service.get(idle)?.topicState).toBe("active");
    expect((await topicRequest(running, idle, "/archive", {})).status).toBe(200);
    expect(service.get(idle)?.topicState).toBe("archived");
    const quoted = await service.sendToStream(undefined, "Follow-up", [], { quotedMessage: owner.id });
    expect(quoted?.topic.id).toBe(idle);
    expect(service.get(idle)?.topicState).toBe("active");
    service.archive(idle);
    expect(service.tell(ticket.id, "Ticket notice", "Notice prompt")).toBe(idle);
    expect(service.get(idle)?.topicState).toBe("active");
  });

  it("sweeps automatically at a configured archive age", async () => {
    const running = await start(25);
    const topic = running.conversations.create().id;
    clock.advance(25);
    await expect.poll(() => running.conversations.get(topic)?.topicState, { interval: 10 }).toBe("archived");
  });

  it("moves an idle input to a new topic atomically and rejects a repeated move from the old topic", async () => {
    const running = await start();
    const service = running.conversations;
    const { link, messages } = connect(running);
    const source = openTicket(running, undefined, "owner/project").conversation!;
    const attachment = { id: "a".repeat(32), name: "Planning.md", size: 1, mediaType: "text/markdown" };
    const owner = service.send(source, "", [attachment])!;
    const db = running.database.connection;
    db.exec("CREATE TEMP TRIGGER reject_move BEFORE UPDATE OF conversation_id ON conversation_entries BEGIN SELECT RAISE(ABORT, 'move failed'); END");
    expect(() => service.move(owner.id, null, source)).toThrow("move failed");
    expect(service.list().map(({ id }) => id)).toEqual([source]);
    expect(service.entries(source).at(-1)).toMatchObject({ id: owner.id });
    expect(db.prepare("SELECT * FROM topic_transfers").all()).toEqual([]);
    db.exec("DROP TRIGGER reject_move");

    const request = () => topicRequest(running, source, "/move", { message: owner.id, destination: null });
    const response = await request();
    expect(response.status).toBe(200);
    const { conversation: destination } = ConversationResponse.parse(await response.json());
    expect(destination).toMatchObject({ title: "Planning.md", repository: "owner/project", topicState: "active" });
    expect(service.entries(source).some(({ id }) => id === owner.id)).toBe(false);
    expect(service.entries(destination.id)).toMatchObject([{ id: owner.id, placement: "owner", attachments: [attachment] }]);
    expect((await request()).status).toBe(409);
    expect(service.list()).toHaveLength(2);
    expect(messages).toContainEqual({ type: "input.withdraw", conversation: source, input: owner.id });
    expect(messages.some((message) => message.type === "input" && message.conversation === destination.id)).toBe(false);
    link.receive({ type: "input.withdrawn", conversation: source, input: owner.id });
    expect(messages.at(-1)).toMatchObject({ type: "input", conversation: destination.id, input: { entry: owner.id, attachments: [attachment] } });
  });

  it("withdraws a running routed input before the new topic can answer and records the correction", async () => {
    const running = await start();
    const service = running.conversations;
    const { link, messages } = connect(running);
    const source = service.create().id;
    const routed = (await service.sendToStream(undefined, "New work\nNow", []))!;
    const oldTurn = { conversation: source, turn: "old-turn" };
    link.receive({ type: "turn.started", ...oldTurn, inputs: [routed.entry.id], provider: "gpt", model: "model" });
    link.receive({ type: "text", ...oldTurn, block: "old", delta: "Earlier reply" });
    expect(routed).toMatchObject({ topic: { id: source }, entry: { placement: "router-joined" }, latestOwner: true });

    clock.advance(1);
    const moved = service.move(routed.entry.id, null, source);
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) throw new Error("The hub did not move the input.");
    const destination = moved.value;
    const db = running.database.connection;
    expect(service.get(destination)).toMatchObject({ title: "New work", repository: null });
    expect(service.entries(source)).toMatchObject([{ text: "Earlier reply" }]);
    expect(service.stream().entries.find(({ entry }) => entry.id === routed.entry.id)).toMatchObject({
      position: routed.position, topic: { id: destination }, entry: { placement: "owner", taken: false },
    });
    expect(db.prepare("SELECT placed_in, moved_to, moved_at FROM routing_decisions WHERE entry = ?").get(routed.entry.id))
      .toEqual({ placed_in: source, moved_to: destination, moved_at: clock.now() });
    expect(db.prepare("SELECT ticket_writes_revoked FROM turns WHERE id = ?").get(oldTurn.turn)).toEqual({ ticket_writes_revoked: 1 });
    expect(messages.at(-1)).toEqual({ type: "input.withdraw", conversation: source, input: routed.entry.id });
    expect(messages.some((message) => message.type === "input" && message.conversation === destination)).toBe(false);

    link.receive({ type: "turn.finished", ...oldTurn, outcome: "interrupted", reason: null });
    link.receive({ type: "input.withdrawn", conversation: source, input: routed.entry.id });
    const delivered = messages.at(-1);
    expect(delivered).toMatchObject({ type: "input", conversation: destination, input: { entry: routed.entry.id, text: "New work\nNow" } });
    if (delivered?.type !== "input") throw new Error("The hub did not deliver the input.");
    expect(delivered.input.id).not.toBe(routed.entry.id);
    const newTurn = { conversation: destination, turn: "new-turn" };
    link.receive({ type: "turn.started", ...newTurn, inputs: [delivered.input.id], provider: "gpt", model: "model" });
    link.receive({ type: "text", ...newTurn, block: "answer", delta: "New topic reply" });
    link.receive({ type: "turn.finished", ...newTurn, outcome: "completed", reason: null });
    expect(service.detail(source)?.turns).toMatchObject([{ state: "interrupted" }]);
    expect(service.detail(destination)).toMatchObject({ turns: [{ state: "completed" }], entries: [{ id: routed.entry.id, taken: true }, { text: "New topic reply" }] });
  });

  it("uses the original routing scope to choose a repository for a split", async () => {
    const running = await start();
    const service = running.conversations;
    const other = openTicket(running, undefined, "team/other").conversation!;
    const source = openTicket(running, undefined, "team/alpha").conversation!;
    const code = { kind: "code" } as const;
    const repository = { kind: "repository", repository: "team/alpha" } as const;
    for (const [text, scope, from, target] of [
      ["Check other", code, other, { repository: "team/other" }],
      ["Review", code, source, { repository: null, needsRepository: true }],
      ["Check other", repository, source, { repository: "team/alpha" }],
    ] as const) {
      service.send(source, "Keep the source recent");
      const routed = (await service.sendToStream(undefined, text, [], { scope }))!;
      expect(routed).toMatchObject({ topic: { id: from }, entry: { placement: "router-joined" } });
      const moved = service.move(routed.entry.id, null, from);
      expect(moved.ok && service.get(moved.value)).toMatchObject(target);
      clock.advance(1);
    }
    expect(service.get(other)?.repository).toBe("team/other");
  });

  it("marks only the latest joined owner entry in a stream page even when a moved older entry is outside the page", async () => {
    const running = await start();
    const service = running.conversations;
    const first = (await service.sendToStream(undefined, "Open the topic", []))!;
    expect(first.entry).toMatchObject({ placement: "router-opened" });
    const other = service.create().id;
    const older = service.send(other, "Older owner message")!;
    clock.advance(1);
    service.send(first.topic.id, "Keep this topic active");
    const joined = (await service.sendToStream(undefined, "Continue", []))!;
    expect(joined).toMatchObject({ topic: { id: first.topic.id }, entry: { placement: "router-joined" }, latestOwner: true });
    expect(service.detail(other)?.entries).toMatchObject([{ placement: "owner" }]);
    expect(service.move(older.id, first.topic.id).ok).toBe(true);
    expect(service.stream(Number.MAX_SAFE_INTEGER, 1).entries).toMatchObject([{ entry: { id: joined.entry.id }, latestOwner: false }]);
  });

  it("replays a queued withdrawal after restart and refreshes old history for scoped stream clients", async () => {
    const first = await start();
    const { messages: before } = connect(first);
    const source = first.conversations.create().id;
    const destination = openTicket(first, undefined, "owner/project").conversation!;
    const entry = first.conversations.send(source, "Move to code")!;
    const position = first.conversations.stream().entries[0]?.position;
    expect(first.conversations.move(entry.id, destination)).toEqual({ ok: true, value: destination });
    first.conversations.send(destination, "Later message");
    expect(before.filter((message) => message.type === "input")).toHaveLength(1);
    await first.close();

    const second = await start();
    const { link, messages } = connect(second);
    expect(messages).toContainEqual({ type: "input.withdraw", conversation: source, input: entry.id });
    expect(messages.some((message) => message.type === "input")).toBe(false);
    link.receive({ type: "input.withdrawn", conversation: source, input: entry.id });
    const queued = messages.filter((message) => message.type === "input");
    expect(queued).toMatchObject([
      { conversation: destination, input: { entry: entry.id, text: "Move to code" } },
      { conversation: destination, input: { text: "Later message" } },
    ]);
    expect(queued[0]?.input.id).not.toBe(entry.id);
    expect(second.conversations.stream().entries.find((item) => item.entry.id === entry.id)?.position).toBe(position);

    const { socket, received } = await pageSocket(second);
    socket.send(JSON.stringify({ type: "watch.stream", scope: { kind: "daily" }, after: position, revision: 0, subscription: 3 }));
    await until(() => received.some((message) => message.type === "stream.page"), socket);
    expect(received.find((message) => message.type === "stream.page")).toMatchObject({ reset: true, revision: 1, entries: [], subscription: 3 });
  });

  it("redirects a watched topic and transfers ticket links while preserving the selected project", async () => {
    const running = await start();
    const service = running.conversations;
    const sourceTicket = openTicket(running, undefined, "owner/old");
    const source = sourceTicket.conversation!;
    const destination = openTicket(running, undefined, "owner/new").conversation!;
    const { socket, received } = await pageSocket(running);
    socket.send(JSON.stringify({ type: "watch", conversation: source, after: 0, snapshot: true }));
    await until(() => received.some((message) => message.type === "topic.detail"), socket);
    expect((await topicRequest(running, source, "/merge", { destination })).status).toBe(200);
    await until(() => received.some((message) => message.type === "topic.detail" && message.conversation.id === destination), socket);
    expect(received).toContainEqual(expect.objectContaining({ type: "topic.detail", requested: source, conversation: expect.objectContaining({ id: destination, repository: "owner/new" }) }));
    expect(service.list().map(({ id }) => id)).not.toContain(source);
    expect(running.tickets.get(sourceTicket.id)).toMatchObject({ conversation: destination, repository: "owner/old" });
    expect(service.tell(sourceTicket.id, "A notice after merging", "Notice prompt")).toBe(destination);

    const oldLink = await topicRequest(running, source);
    expect(await oldLink.json()).toMatchObject({ conversation: { id: destination, repository: "owner/new" } });
    const notice = service.entries(destination)[0]!;
    expect(service.send(source, "Reply using the old address", [], notice.id)).toMatchObject({ conversation: destination, quotedMessage: notice.id });
  });
});

describe("question cards", () => {
  const questions = [
    { id: "scope", prompt: "选择范围", required: true, multiple: false, options: [{ id: "a", label: "甲", recommended: true }, { id: "b", label: "乙" }] },
    { id: "extras", prompt: "选择附加项", required: false, multiple: true, options: [{ id: "x", label: "一" }, { id: "y", label: "二" }] },
  ];
  it("sends structured answers in the same topic, with text overriding options, and rejects a second submission", async () => {
    const running = await start();
    const topic = running.conversations.create();
    const sent: HubToBrain[] = [];
    const brain = running.conversations.attach({ send: (message) => sent.push(message), close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    const turn = { conversation: topic.id, turn: "question-turn" };
    brain.receive({ type: "turn.started", ...turn, provider: "gpt", model: "test", inputs: [] });
    const response = await fetch(`${base(running)}${brainToolsPath}`, { method: "POST", headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json", "x-super-agent-conversation": topic.id, "x-super-agent-turn": turn.turn }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_owner", arguments: { questions } } }) });
    expect(await response.json()).toMatchObject({ result: { isError: false } });
    const card = running.conversations.entries(topic.id).find((entry) => entry.kind === "question");
    expect(card?.kind === "question" && card.questions).toHaveLength(2);
    const headers = { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json" };
    const incomplete = await fetch(`${base(running)}/api/conversations/${topic.id}/questions`, { method: "POST", headers, body: JSON.stringify({ id: card!.id, answers: [] }) });
    expect(incomplete.status).toBe(409);
    const request = () => fetch(`${base(running)}/api/conversations/${topic.id}/questions`, { method: "POST", headers, body: JSON.stringify({ id: card!.id, answers: [{ question: "scope", options: ["a"], text: "自己写" }, { question: "extras", options: ["x", "y"], text: "" }] }) });
    expect((await request()).status).toBe(202);
    expect((await request()).status).toBe(409);
    expect(running.conversations.entries(topic.id).find((entry) => entry.id === card?.id)).toMatchObject({ answer: { kind: "card", answers: [{ question: "scope", options: [], text: "自己写" }, { question: "extras", options: ["x", "y"] }] } });
    expect(sent).toContainEqual(expect.objectContaining({ type: "input", conversation: topic.id, input: expect.objectContaining({ text: expect.stringContaining('"question":"scope"'), questionResponse: { card: card!.id, answers: [{ question: "scope", options: [], text: "自己写" }, { question: "extras", options: ["x", "y"], text: "" }] } }) }));
    expect(running.conversations.entries(topic.id).at(-1)).toMatchObject({ kind: "owner", text: "1. 自己写；2. 一、二" });
  });

  it("keeps earlier cards open when a later card is answered", async () => {
    const running = await start();
    const topic = running.conversations.create();
    const brain = running.conversations.attach({ send: () => undefined, close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    brain.receive({ type: "turn.started", conversation: topic.id, turn: "t", provider: "gpt", model: "test", inputs: [] });
    const first = running.conversations.askOwner(topic.id, "t", questions)!;
    const second = running.conversations.askOwner(topic.id, "t", questions)!;
    expect(running.conversations.answerQuestions(topic.id, second, [{ question: "scope", options: ["a"], text: "" }])).toBeDefined();
    expect(running.conversations.entries(topic.id).find((entry) => entry.id === first)).toMatchObject({ answer: null });
    running.conversations.send(topic.id, "回复第一张");
    expect(running.conversations.entries(topic.id).find((entry) => entry.id === first)).toMatchObject({ answer: { kind: "message", text: "回复第一张" } });
  });

  it("marks the card answered when the owner replies in the composer", async () => {
    const running = await start();
    const topic = running.conversations.create();
    const brain = running.conversations.attach({ send: () => undefined, close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    brain.receive({ type: "turn.started", conversation: topic.id, turn: "t", provider: "gpt", model: "test", inputs: [] });
    const id = running.conversations.askOwner(topic.id, "t", questions)!;
    running.conversations.send(topic.id, "我想换一个方案");
    expect(running.conversations.entries(topic.id).find((entry) => entry.id === id)).toMatchObject({ answer: { kind: "message", text: "我想换一个方案" } });
    expect(running.conversations.answerQuestions(topic.id, id, [])).toBeUndefined();
  });
});
