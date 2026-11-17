import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "@super-agent2/catalog";
import { brainLinkPath, brainToolsPath, ConversationState, type HubToBrain, ServerMessage, TurnState } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { brainTokenCheck, ensureBrainToken } from "./brain-token.js";
import type { Hub } from "./hub.js";
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

async function start(): Promise<Hub> {
  hub = await startTestHub({
    config: testConfig(dataDir),
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
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["run_command", "read_command", "stop_command", "file_issue", "open_ticket", "open_writing_ticket", "list_tickets", "read_ticket", "message_worker", "stop_ticket", "arrange_chains", "report_deployment", "proceed_ticket", "read_allowance", "choose_defaults", "merge_ticket", "guide_ticket", "describe_stuck", "deploy_repository", "read_deployment"]);
    expect(list.result.tools[0]?.description).toContain("Targets now: hub.");
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
    const { socket, received } = await pageSocket(running);
    const brain = await brainSocket(running);
    brain.socket.send(JSON.stringify({ type: "hello", protocol: 1, running: [] }));
    socket.send(JSON.stringify({ type: "watch", conversation: conversation.id }));
    await until(() => received.some((message) => message.type === "brain"), socket);
    const id = running.conversations.deliver(conversation.id, {
      ticket: 4,
      title: { en: "Translate a notice", zh: "翻译一则通知" },
      text: "Hello, world.\n",
      files: [{ name: "notes.pdf", size: 4 }],
      prompt: "[hub] The result of writing ticket 4 was delivered.",
    });
    expect(id).toBe(conversation.id);
    await until(() => received.some((message) => message.type === "entry" && message.entry.kind === "delivery"), socket);
    const entry = running.conversations.entries(conversation.id).find((candidate) => candidate.kind === "delivery");
    expect(entry).toMatchObject({
      kind: "delivery",
      turn: null,
      ticket: 4,
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
      input: { source: "hub", text: "[hub] The result of writing ticket 4 was delivered." },
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
      { kind: "notice", text: expect.stringContaining("The result of writing ticket 4 (Translate a notice) was delivered") },
    ]);
    expect(running.conversations.deliver(null, { ticket: 5, title: { en: "A", zh: "甲" }, text: null, files: [], prompt: "p" })).toBe(conversation.id);
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
