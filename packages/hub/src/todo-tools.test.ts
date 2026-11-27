import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, conversationHeader, type Provider, type RunningTurn, ServerMessage, todosPath, TodoSnapshot, todoTools, turnHeader } from "@super-agent2/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { BrainLink } from "./conversations.js";
import type { Hub } from "./hub.js";
import { TestClock } from "./testing/access.js";
import { attachBrain, requestBrainTool, startToolTurn } from "./testing/brain-tools.js";
import { startTestHub } from "./testing/http.js";

let directory: string;
let hub: Hub;
let brain: BrainLink;
let clock: TestClock;
const sockets = new Set<WebSocket>();

async function start() {
  hub = await startTestHub({
    config: {
      ownerEmail: "owner@local.invalid", host: "127.0.0.1", port: 0, dataDir: directory,
      brainTokenFile: join(directory, "brain.token"), projectFolders: [], ticketTimeZone: "America/New_York",
    },
    environment: {},
    clock,
  });
  brain = attachBrain(hub);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "brain-todos-"));
  clock = new TestClock(Date.parse("2026-11-27T14:00:00Z"));
  await start();
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await hub.close();
  rmSync(directory, { recursive: true, force: true });
});

function origin() {
  return `http://127.0.0.1:${hub.address.port}`;
}

async function names(scope?: RunningTurn): Promise<string[]> {
  const response = await fetch(origin() + brainToolsPath, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readFileSync(join(directory, "brain.token"), "utf8").trim()}`,
      "content-type": "application/json",
      ...(scope === undefined ? {} : { [conversationHeader]: scope.conversation, [turnHeader]: scope.turn }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const { result } = await response.json() as { result: { tools: { name: string }[] } };
  return result.tools.map(({ name }) => name);
}

function ownerTurn(words: string, conversation = hub.conversations.create().id, provider: Provider = "gpt"): RunningTurn {
  const turn = randomUUID();
  const owner = hub.conversations.send(conversation, words);
  expect(owner).toBeDefined();
  brain.receive({ type: "turn.started", conversation, turn, provider, model: "test", inputs: [owner!.id] });
  return { conversation, turn };
}

function finish(scope: RunningTurn) {
  brain.receive({ type: "turn.finished", ...scope, outcome: "completed", reason: null });
}

async function taskCall(name: string, args: Record<string, unknown>, scope: RunningTurn) {
  const reply = await requestBrainTool(hub, name, args, scope);
  expect(reply.isError, reply.text).toBe(false);
  return JSON.parse(reply.text).untrustedAppData;
}

function watch(socket: WebSocket, type: ServerMessage["type"]) {
  return new Promise<void>((resolve) => {
    const receive = (data: Buffer) => {
      if (ServerMessage.parse(JSON.parse(data.toString())).type === type) {
        socket.off("message", receive);
        resolve();
      }
    };
    socket.on("message", receive);
  });
}

it("adds to the requested list and date without a gateway and publishes the result live", async () => {
  const list = hub.todos.addList("Garden");
  const archived = hub.todos.addList("Archived");
  hub.todos.editList(archived.id, { archived: true });
  const scope = ownerTurn("Remind me to water the greenhouse tomorrow at nine in Garden.", undefined, "deepseek");
  expect(hub.settings.snapshot().appGateway).toBeUndefined();
  expect(await names(scope)).toEqual(expect.arrayContaining([...todoTools]));
  expect(await names()).not.toContain("todo_lookup");
  for (const name of ["Missing", "Archived"]) {
    const failure = await requestBrainTool(hub, "add_todo", { owner_requested: true, title: "Task", list: name }, scope);
    expect(failure).toMatchObject({ isError: true, text: expect.stringContaining("Available lists: 收件箱, Garden") });
  }
  expect(await requestBrainTool(hub, "add_todo", { owner_requested: true, title: "Task", due: "2026-11-28", remind: true }, scope))
    .toMatchObject({ isError: true, text: expect.stringContaining("needs both a date and a time") });
  expect(await requestBrainTool(hub, "add_todo", { owner_requested: true, title: "Task", due: "2026-03-08T02:30" }, scope))
    .toMatchObject({ isError: true, text: expect.stringContaining("does not exist") });

  const socket = new WebSocket(origin().replace("http", "ws") + "/ws");
  sockets.add(socket);
  await watch(socket, "hello");
  const changed = watch(socket, "todos.changed");
  const created = await taskCall("add_todo", {
    owner_requested: true, title: "Water the greenhouse", list: "garden", due: "2026-11-28T15:00:00+01:00", notes: "Use the rain barrel", remind: true,
  }, scope);
  expect(created).toMatchObject({ list: "Garden", date: "2026-11-28", time: "09:00", receipt: created.taskId, url: `/todos?todo=${created.taskId}` });
  await changed;
  const snapshot = TodoSnapshot.parse(await (await fetch(origin() + todosPath)).json());
  expect(snapshot.todos).toMatchObject([{ id: created.taskId, title: "Water the greenhouse", list: list.id, date: "2026-11-28", time: "09:00", notes: "Use the rain barrel", sourceTopic: scope.conversation, topic: null }]);
  expect(await taskCall("todo_lookup", { limit: 1 }, scope)).toEqual({ lists: [{ id: null, name: "收件箱" }], nextOffset: 1 });
  expect(await taskCall("todo_lookup", { offset: 1 }, scope)).toEqual({ lists: [{ id: list.id, name: "Garden" }], nextOffset: null });
  expect(await taskCall("todo_lookup", { query: "RAIN BARREL" }, scope)).toMatchObject({ tasks: [{ taskId: created.taskId, done: false, date: "2026-11-28", list: "Garden" }], nextOffset: null });
  const removed = watch(socket, "todos.changed");
  expect(await taskCall("undo_created", { owner_requested: true, receipt: created.receipt }, scope)).toMatchObject({ undone: true });
  await removed;
  expect(await taskCall("todo_lookup", { query: "greenhouse" }, scope)).toEqual({ tasks: [], nextOffset: null });
});

it("updates, completes, and reopens an existing task on the owner's request", async () => {
  const todo = hub.todos.add({ title: "Check the mail", notes: "", list: null, date: "2026-11-27", time: "10:00" });
  const scope = ownerTurn("Reschedule the mail check and mark it done.");
  const updated = await taskCall("update_todo", { owner_requested: true, task_id: todo.id, due: "2026-11-28", done: true }, scope);
  expect(updated).toMatchObject({ date: "2026-11-28", time: null, done: true });
  expect(hub.todos.get(todo.id)?.doneAt).toBe(clock.now());
  expect(await taskCall("todo_lookup", { query: "check the mail" }, scope)).toMatchObject({ tasks: [{ taskId: todo.id, done: true, list: "收件箱" }] });
  expect(await taskCall("update_todo", { owner_requested: true, task_id: todo.id, due: null, done: false }, scope))
    .toMatchObject({ date: null, time: null, done: false });
  expect(await requestBrainTool(hub, "update_todo", { owner_requested: true, task_id: randomUUID(), done: true }, scope))
    .toMatchObject({ isError: true, text: expect.stringContaining("could not be found") });
});

it("checks the active owner turn and the explicit flag for each write", async () => {
  const me = hub.todos.add({ title: "Owner's task", notes: "", list: null, date: null, time: null });
  const owner = ownerTurn("Look up my tasks.");
  const changes = [
    ["add_todo", { title: "Unauthorized" }],
    ["update_todo", { task_id: me.id, done: true }],
    ["undo_created", { receipt: me.id }],
  ] as const;
  for (const [name, args] of changes) {
    expect((await requestBrainTool(hub, name, { ...args }, owner)).isError).toBe(true);
  }
  finish(owner);
  const background = startToolTurn(brain, owner.conversation);
  expect(await names(background)).toContain("todo_lookup");
  for (const [name, args] of changes) {
    expect(await names(background)).not.toContain(name);
    for (const scope of [owner, background, undefined]) {
      expect(await requestBrainTool(hub, name, { ...args, owner_requested: true }, scope))
        .toMatchObject({ isError: true, text: expect.stringContaining("owner's request") });
    }
  }
  expect(hub.todos.snapshot().todos).toMatchObject([{ id: me.id, doneAt: null }]);
});

it("persists receipts, undoes the latest creation in the topic, and leaves owner and legacy tasks alone", async () => {
  const topic = hub.conversations.create().id;
  let scope = ownerTurn("Add two tasks.", topic);
  const first = await taskCall("add_todo", { owner_requested: true, title: "First" }, scope);
  const second = await taskCall("add_todo", { owner_requested: true, title: "Second" }, scope);
  const ownerTask = hub.todos.add({ title: "Owner task", notes: "", list: null, date: null, time: null });
  const legacy = randomUUID();
  hub.database.connection.prepare("INSERT INTO ticktick_receipts (id, topic, connection, task, project, created_at) VALUES (?, ?, 'old-connection', 'old-task', 'old-project', ?)").run(legacy, topic, clock.now());
  finish(scope);
  await hub.close();
  await start();
  scope = ownerTurn("Undo the latest task you added.", topic);
  expect(await taskCall("undo_created", { owner_requested: true }, scope)).toEqual({ receipt: second.receipt, undone: true });
  expect(await taskCall("undo_created", { owner_requested: true }, scope)).toEqual({ receipt: second.receipt, undone: true, alreadyUndone: true });
  expect(await requestBrainTool(hub, "undo_created", { owner_requested: true, receipt: ownerTask.id }, scope))
    .toMatchObject({ isError: true, text: expect.stringContaining("no matching") });
  expect(await requestBrainTool(hub, "undo_created", { owner_requested: true, receipt: legacy }, scope))
    .toMatchObject({ isError: true, text: expect.stringContaining("created in TickTick") });
  expect(await taskCall("undo_created", { owner_requested: true, receipt: first.receipt }, scope)).toEqual({ receipt: first.receipt, undone: true });
  expect(hub.todos.snapshot().todos).toMatchObject([{ id: ownerTask.id }]);
});
