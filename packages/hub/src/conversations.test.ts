import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "@super-agent2/catalog";
import { brainLinkPath, brainToolsPath, ConversationState, type HubToBrain, largestMessageBytes, MachineReport, protocolVersion, ServerMessage, StreamEntry, StreamPage, TurnState } from "@super-agent2/protocol";
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
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["run_command", "read_command", "stop_command", "read_quote", "set_topic_repository", "handover", "file_issue", "open_ticket", "open_task_ticket", "list_tickets", "read_ticket", "message_worker", "record_decision", "stop_ticket", "open_repair_ticket", "arrange_chains", "report_deployment", "proceed_ticket", "set_engine_row", "read_allowance", "choose_defaults", "merge_ticket", "guide_ticket", "describe_stuck", "remember", "recall", "forget", "read_topic_board", "read_topic_history", "search_topic_history", "read_seed_material"]);
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
    brain.socket.send(JSON.stringify({ type: "text", ...turn, block: "b", delta: "你" }));
    brain.socket.send(JSON.stringify({ type: "text", ...turn, block: "b", delta: "好！" }));
    brain.socket.send(JSON.stringify({ type: "turn.finished", ...turn, outcome: "completed", reason: null }));
    await until(() => received.some((message) => message.type === "turn" && message.turn.state === "completed"), socket);
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
      { kind: "notice", text: expect.stringContaining(`The result of task ticket ${ticket.id} (Translate a notice) was delivered`) },
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

  it("offers only active topics within scope and lets all-code routing choose from open ticket repositories", async () => {
    const running = await start();
    const daily = running.conversations.create().id;
    running.conversations.send(daily, "Daily context");
    const project = openTicket(running, undefined, "owner/project").conversation!;
    const archived = openTicket(running, undefined, "owner/archive").conversation!;
    const ticketWithoutTopic = openTicket(running, undefined, "owner/tickets");
    running.database.connection.prepare("UPDATE tickets SET conversation_id = NULL WHERE id = ?").run(ticketWithoutTopic.id);
    running.database.connection.prepare("DELETE FROM conversations WHERE id = ?").run(ticketWithoutTopic.conversation);
    running.database.connection.prepare("UPDATE conversations SET topic_state = 'archived' WHERE id = ?").run(archived);
    const requests: Extract<HubToBrain, { type: "route" }>[] = [];
    const brain = running.conversations.attach({
      close: () => undefined,
      send: (message) => {
        if (message.type !== "route") {
          return;
        }
        requests.push(message);
        const choice = message.scope.kind === "code"
          ? message.text === "Unknown project"
            ? { kind: "new" as const, title: "Which project" }
            : { kind: "new" as const, title: "Work on a ticket", repository: "Owner/Tickets", possibleMatch: project }
          : { kind: "existing" as const, topic: message.scope.kind === "daily" ? daily : project };
        brain.receive({ type: "routed", request: message.request, choice });
      },
    });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });

    const dailyReply = await running.conversations.sendToStream(undefined, "Another daily message", [], { scope: { kind: "daily" } });
    expect(dailyReply?.topic.id).toBe(daily);
    expect(requests[0]?.topics).toEqual([{ id: daily, title: "Daily context", repository: null, recent: [{ speaker: "owner", text: "Daily context" }] }]);
    const projectReply = await running.conversations.sendToStream(undefined, "Continue work", [], { scope: { kind: "repository", repository: "OWNER/Project" } });
    expect(projectReply?.topic.id).toBe(project);
    expect(requests[1]?.topics.map(({ id }) => id)).toEqual([project]);

    const codeReply = await running.conversations.sendToStream(undefined, "Work for owner/tickets", [], { scope: { kind: "code" } });
    expect(requests[2]?.topics.map(({ id }) => id)).toEqual([project]);
    expect(requests[2]?.repositories).toEqual(expect.arrayContaining(["owner/project", "owner/tickets"]));
    expect(codeReply).toMatchObject({
      topic: { title: "Work on a ticket", repository: "owner/tickets" },
      entry: { possibleMatch: project, text: "Work for owner/tickets" },
    });
    const pending = await running.conversations.sendToStream(undefined, "Unknown project", [], { scope: { kind: "code" } });
    expect(pending?.topic).toMatchObject({ title: "Which project", repository: null, needsRepository: true });
    expect(running.conversations.stream(undefined, undefined, null).entries.map(({ topic }) => topic.id)).not.toContain(pending?.topic.id);
    expect(openTicket(running, pending?.topic.id).conversation).not.toBe(pending?.topic.id);
    expect(openTicket(running, daily, "owner/project").conversation).not.toBe(daily);
    expect(running.conversations.get(daily)?.repository).toBeNull();
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
    expect(conflicting.conversation).not.toBe(topic.id);
    expect(running.conversations.get(conflicting.conversation ?? "")?.repository).toBe("owner/other");
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
        expect(result?.turns[0]).toMatchObject([{ text: "Request 1" }, { text: "Result 1" }]);
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
    expect(result?.tickets).toEqual([{ own: true, line: expect.stringContaining(`#${own.id} `) }, { own: false, line: expect.stringContaining(`#${foreign.id} `) }]);
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
    expect((await call("read_seed_material", { section: "tickets" })).text).toContain(`#${ticket.id} `);
    expect((await call("read_seed_material", { section: "memory" })).text).toContain("你希望记录每次发布的时间。");
  });
});

describe("topic corrections and archive policy", () => {
  function connect(running: Hub) {
    const messages: HubToBrain[] = [];
    const link = running.conversations.attach({ send: (message) => messages.push(message), close: () => undefined });
    link.receive({ type: "hello", protocol: protocolVersion, running: [] });
    return { link, messages };
  }

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

    const routed = service.sendToStream(undefined, "Something new", []);
    const route = messages.at(-1);
    expect(route?.type).toBe("route");
    if (route?.type !== "route") {
      throw new Error("Expected a route request");
    }
    expect(route.topics.map(({ id }) => id)).not.toContain(idle);
    link.receive({ type: "routed", request: route.request, choice: null });
    await routed;

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

  it("replays a queued withdrawal after restart and refreshes old history for scoped stream clients", async () => {
    const first = await start();
    const { messages: before } = connect(first);
    const source = first.conversations.create().id;
    const destination = openTicket(first, undefined, "owner/project").conversation!;
    const entry = first.conversations.send(source, "Move to code")!;
    const position = first.conversations.stream().entries[0]?.position;
    expect(first.conversations.move(entry.id, destination)).toEqual({ ok: true, value: entry.id });
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
