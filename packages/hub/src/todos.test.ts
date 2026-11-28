import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HubToBrain, protocolVersion, ServerMessage, Todo, TodoHandoff, TodoList, TodoSnapshot, todosPath } from "@super-agent2/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Hub } from "./hub.js";
import { startTestHub } from "./testing/http.js";

let dataDir: string;
let hub: Hub;
let at: number;
const sockets = new Set<WebSocket>();

function start() {
  return startTestHub({
    config: {
      dataDir, brainTokenFile: join(dataDir, "brain.token"), host: "127.0.0.1", port: 0,
      ownerEmail: "owner@local.invalid", ticketTimeZone: "America/New_York", projectFolders: [],
    },
    clock: { now: () => at },
  });
}

beforeEach(async () => {
  at = Date.UTC(2026, 10, 27, 14);
  dataDir = mkdtempSync(join(tmpdir(), "hub-todos-"));
  hub = await start();
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function url() {
  return `http://127.0.0.1:${hub.address.port}`;
}

function call(path = "", method = "GET", body?: unknown) {
  return fetch(url() + todosPath + path, body === undefined ? { method } : {
    method, headers: { "content-type": "application/json", origin: url() }, body: JSON.stringify(body),
  });
}

async function snapshot() {
  return TodoSnapshot.parse(await (await call()).json());
}

function fields(title: string) {
  return { title, notes: "", list: null, date: null, time: null };
}

function watch(socket: WebSocket, type: ServerMessage["type"]): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const receive = (data: Buffer) => {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      if (message.type === type) {
        socket.off("message", receive);
        resolve(message);
      }
    };
    socket.on("message", receive);
  });
}

it("stores, orders, completes, reopens and deletes to-dos with no brain or worker call", async () => {
  const socket = new WebSocket(url().replace("http", "ws") + "/ws");
  sockets.add(socket);
  await watch(socket, "hello");
  const events: HubToBrain[] = [];
  const brain = hub.conversations.attach({ send: (message) => events.push(message), close: () => undefined });
  brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
  const changed = watch(socket, "todos.changed");
  const id = randomUUID();
  const input = { ...fields("  Water the seedlings  "), id };
  const response = await call("", "POST", input);
  expect(response.status).toBe(201);
  expect(Todo.parse(await response.json())).toMatchObject({ id, title: "Water the seedlings", doneAt: null, updatedAt: at });
  await changed;
  const duplicate = await call("", "POST", input);
  expect(Todo.parse(await duplicate.json()).id).toBe(id);
  expect((await call("", "POST", { ...input, title: "Another task" })).status).toBe(409);
  const second = Todo.parse(await (await call("", "POST", fields("Check the label"))).json());
  expect((await snapshot()).todos.map((todo) => todo.id)).toEqual([second.id, id]);
  expect((await call(`/${id}/reorder`, "POST", { anchor: second.id, side: "before" })).status).toBe(200);
  expect((await snapshot()).todos.map((todo) => todo.id)).toEqual([id, second.id]);
  expect((await call(`/${id}`, "PUT", { time: "08:30" })).status).toBe(400);
  expect((await call(`/${id}`, "PUT", { date: "2026-02-30" })).status).toBe(400);
  at += 1_000;
  const timed = Todo.parse(await (await call(`/${id}`, "PUT", { date: "2026-11-27", time: "08:30", notes: "Read the meter" })).json());
  expect(timed).toMatchObject({ title: "Water the seedlings", date: "2026-11-27", time: "08:30", notes: "Read the meter", updatedAt: at });
  expect(Todo.parse(await (await call(`/${id}`, "PUT", { done: true })).json()).doneAt).toBe(at);
  const third = Todo.parse(await (await call("", "POST", fields("Buy a watering can"))).json());
  expect((await snapshot()).todos.map((todo) => todo.id)).toEqual([third.id, second.id, id]);
  expect(Todo.parse(await (await call(`/${id}`, "PUT", { done: false })).json()).doneAt).toBeNull();
  expect((await snapshot()).todos.map((todo) => todo.id)).toEqual([third.id, id, second.id]);
  expect((await call(`/${id}`, "DELETE", {})).status).toBe(200);
  expect((await call(`/${id}`, "DELETE", {})).status).toBe(200);
  expect((await call(`/${id}`, "PUT", { title: "Gone" })).status).toBe(404);
  expect((await snapshot()).todos.map((todo) => todo.id)).toEqual([third.id, second.id]);
  expect(hub.database.connection.prepare("SELECT deleted, updated_at FROM todos WHERE id = ?").get(id)).toEqual({ deleted: 1, updated_at: at });
  expect(events.filter(({ type }) => type === "input")).toEqual([]);
  expect(hub.tickets.list()).toEqual([]);
});

it("manages list order, names and archival without dropping tasks", async () => {
  const garden = TodoList.parse(await (await call("/lists", "POST", { name: "Garden" })).json());
  const home = TodoList.parse(await (await call("/lists", "POST", { name: "Home" })).json());
  expect((await call("/lists", "POST", { name: "garden" })).status).toBe(409);
  expect((await call(`/lists/${home.id}/reorder`, "POST", { anchor: garden.id, side: "before" })).status).toBe(200);
  expect((await snapshot()).lists.map(({ name }) => name)).toEqual(["Home", "Garden"]);
  const todo = Todo.parse(await (await call("", "POST", { ...fields("Plant bulbs"), list: garden.id })).json());
  at += 1_000;
  const archived = TodoList.parse(await (await call(`/lists/${garden.id}`, "PUT", { name: "Plants", archived: true })).json());
  expect(archived).toMatchObject({ name: "Plants", archived: true, updatedAt: at });
  expect((await call("", "POST", { ...fields("Trim roses"), list: garden.id })).status).toBe(409);
  expect(Todo.parse(await (await call(`/${todo.id}`, "PUT", { notes: "Before frost" })).json()).list).toBe(garden.id);
  expect(TodoList.parse(await (await call(`/lists/${garden.id}`, "PUT", { archived: false })).json()).archived).toBe(false);
  expect(await snapshot()).toMatchObject({ timeZone: "America/New_York", todos: [{ id: todo.id, list: garden.id }] });
});

it("completes the to-do on hand-off and keeps its topic when the to-do is reopened", async () => {
  const inputs: Extract<HubToBrain, { type: "input" }>[] = [];
  const link = hub.conversations.attach({ send: (event) => { if (event.type === "input") inputs.push(event); }, close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, running: [] });
  const list = hub.todos.addList("Garden");
  const todo = hub.todos.add({ title: "Plan this greenhouse", notes: "Review the cap", list: list.id, date: "2026-11-27", time: "14:00" });
  const before = hub.conversations.list().length;
  expect(inputs).toHaveLength(0);
  const path = `/${todo.id}/handoff`;
  at += 1_000;
  const handedOffAt = at;
  const receipts = await Promise.all([call(path, "POST", {}), call(path, "POST", {})].map(async (pending) => {
    const response = await pending;
    expect(response.status).toBe(200);
    return TodoHandoff.parse(await response.json());
  }));
  const topic = receipts[0]!.topic;
  expect(receipts.map((receipt) => receipt.topic)).toEqual([topic, topic]);
  expect(hub.conversations.list()).toHaveLength(before + 1);
  expect(hub.conversations.detail(topic)).toMatchObject({ conversation: { repository: null }, entries: [{ kind: "owner", text: "Plan this greenhouse\n\n清单：Garden\n\n日期：2026-11-27 14:00\n\n备注：Review the cap" }] });
  const message = "Plan this greenhouse\n\n清单：Garden\n\n日期：2026-11-27 14:00\n\n备注：Review the cap";
  expect(inputs).toEqual([expect.objectContaining({ conversation: topic, input: expect.objectContaining({ source: "owner", text: expect.stringContaining(`${message}\n[hub] This message was handed off from a to-do.`) }) })]);
  expect(hub.database.connection.prepare("SELECT prompt, json_extract(body, '$.origin') AS origin FROM conversation_entries WHERE conversation_id = ? AND kind = 'owner'").get(topic)).toEqual({ prompt: inputs[0]!.input.text, origin: "todo" });
  hub.conversations.send(topic, "Here is an ordinary follow-up");
  expect(inputs[1]?.input.text).toBe("Here is an ordinary follow-up");
  expect((await snapshot()).todos).toMatchObject([{ id: todo.id, topic, doneAt: handedOffAt, updatedAt: handedOffAt }]);
  link.detach();
  await hub.close();
  at += 1_000;
  hub = await start();
  expect(TodoHandoff.parse(await (await call(path, "POST", {})).json())).toEqual({ topic });
  expect(hub.todos.get(todo.id)).toMatchObject({ topic, doneAt: handedOffAt, updatedAt: handedOffAt });
  expect(Todo.parse(await (await call(`/${todo.id}`, "PUT", { done: false })).json())).toMatchObject({ topic, doneAt: null, updatedAt: at });
  expect(TodoHandoff.parse(await (await call(path, "POST", {})).json())).toEqual({ topic });
  expect(hub.conversations.list()).toHaveLength(before + 1);
  expect((await snapshot()).todos).toMatchObject([{ id: todo.id, topic, doneAt: null }]);
});

it.each([
  "BEFORE INSERT ON conversations",
  "AFTER UPDATE OF topic ON todos",
])("leaves the to-do open and returns an error if hand-off fails at %s", async (operation) => {
  const todo = hub.todos.add(fields("Plan this greenhouse"));
  const before = hub.conversations.list().length;
  const link = hub.conversations.attach({ send: (event) => { expect(event.type).not.toBe("input"); }, close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, running: [] });
  hub.database.connection.exec(`CREATE TRIGGER fail_handoff ${operation} BEGIN SELECT RAISE(ABORT, 'hand-off failed'); END;`);
  at += 1_000;
  expect((await call(`/${todo.id}/handoff`, "POST", {})).ok).toBe(false);
  expect(hub.conversations.list()).toHaveLength(before);
  expect((await snapshot()).todos).toEqual([todo]);
  link.detach();
});

it("rejects mutations from another origin on the local edition", async () => {
  const response = await fetch(url() + todosPath, {
    method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify(fields("Unexpected")),
  });
  expect(response.status).toBe(403);
  expect((await snapshot()).todos).toEqual([]);
});
