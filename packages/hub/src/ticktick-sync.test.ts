import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsSnapshot, tickTickSyncPath } from "@super-agent2/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase, type HubDatabase } from "./database.js";
import { assertion, keySet, signingKey, staticKeySource, testConfig } from "./testing/access.js";
import { startTestHub } from "./testing/http.js";
import type { TickTickFields, TickTickGateway, TickTickProject, TickTickTask } from "./ticktick-gateway.js";
import { createTickTickSync, type TickTickSync } from "./ticktick-sync.js";
import { createTodos, type Todos } from "./todos.js";

let dataDir: string;
let database: HubDatabase;
let todos: Todos;
let sync: TickTickSync;
let at: number;
let account: string | undefined;
let outage: boolean;
let loseReply: boolean;
let interruptedUpdate: boolean;
let reads: number;
let writes: string[];
let projects: Map<string, TickTickProject>;
let tasks: Map<string, TickTickTask>;
const clock = { now: () => at };

function fields(title: string) {
  return { title, notes: "", list: null, date: null, time: null };
}

function putRemote(id: string, input: Partial<TickTickTask> & Pick<TickTickTask, "title">): TickTickTask {
  const task = { id, notes: "", date: null, time: null, done: false, project: "inbox", etag: null, repeating: false, note: false, ...tasks.get(id), modifiedAt: at, ...input };
  tasks.set(id, task);
  return task;
}

const gateway: TickTickGateway = {
  connected: () => account !== undefined,
  account: () => account,
  session: (id, authorized) => {
    const write = (label: string) => {
      if (!authorized() || id !== account) throw new Error("Write denied");
      writes.push(label);
    };
    return {
      projects: async () => {
        reads++;
        if (outage) throw new Error("Gateway is down");
        return [...projects.values()];
      },
      open: async (project) => [...tasks.values()].filter((task) => task.project === project && !task.done),
      task: async (id) => tasks.get(id) ?? null,
      createProject: async (name) => {
        write("project");
        const project = { id: "project-" + projects.size, name };
        projects.set(project.id, project);
        return project;
      },
      create: async (id: string, fields: TickTickFields) => {
        write("create");
        if (tasks.has(id)) throw new Error("Duplicate task");
        const task = putRemote(id, fields);
        if (loseReply) { loseReply = false; throw new Error("Write reply lost"); }
        return task;
      },
      update: async (task, fields, progress) => {
        write("update");
        if (interruptedUpdate) {
          interruptedUpdate = false;
          progress(putRemote(task.id, { title: task.title, project: fields.project }));
          throw new Error("Gateway went down after moving the task");
        }
        return putRemote(task.id, fields);
      },
      remove: async ({ id }) => { write("delete"); tasks.delete(id); },
    };
  },
};

function start() {
  database = openDatabase({ dataDir, clock });
  todos = createTodos(database, clock, {
    get: () => undefined,
    sendToNewDailyTopic: () => { throw new Error("Unexpected brain call"); },
  });
  sync = createTickTickSync({ database, clock, todos, gateway, ticker: () => () => undefined, changed: () => undefined });
}

async function poll(advance = 0) {
  at += advance;
  sync.poll();
  await sync.idle();
}

async function openPage(advance = 15_000) {
  at += advance;
  sync.pageOpened();
  await sync.idle();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(process.env.SUPERAGENT2_ARTIFACTS_DIR || tmpdir(), "hub-ticktick-"));
  at = Date.UTC(2026, 10, 27, 14);
  account = "account-a";
  outage = false;
  loseReply = false;
  interruptedUpdate = false;
  reads = 0;
  writes = [];
  projects = new Map([["inbox", { id: "inbox", name: "Inbox" }], ["home", { id: "home", name: "HOME" }]]);
  tasks = new Map();
  start();
});

afterEach(async () => {
  await sync.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it("imports open tasks and reconciles local and remote task changes across lists", async () => {
  const home = todos.addList("Home");
  const garden = todos.addList("Garden");
  putRemote("recurring", { title: "Refill the feeder", project: "home", repeating: true });
  putRemote("inbox-task", { title: "Check the forecast" });
  putRemote("old", { title: "Completed history", project: "home", done: true });
  const local = todos.add({ ...fields("Plant marigolds"), list: garden.id, date: "2026-12-01", time: "10:30" });
  await poll(120_000);
  expect(reads).toBe(0);
  expect(sync.status()).toMatchObject({ enabled: false, state: "off" });

  expect(sync.setEnabled(true)).toBe(true);
  await sync.idle();
  expect(sync.status()).toMatchObject({ state: "ready", lastSync: at, log: [ { event: "repeating", count: 1 }, { event: "synced", count: 3 } ] });
  const imported = todos.syncRows();
  const recurring = imported.find(({ title }) => title === "Refill the feeder")!;
  expect(recurring.list).toBe(home.id);
  expect(imported.find(({ title }) => title === "Check the forecast")?.list).toBeNull();
  expect(imported.some(({ title }) => title === "Completed history")).toBe(false);
  expect(todos.lists().map(({ name }) => name)).toEqual(["Home", "Garden"]);
  expect(writes).toEqual(["project", "create"]);
  const planted = [...tasks.values()].find(({ title }) => title === local.title)!;
  expect(planted).toMatchObject({ project: "project-2", date: local.date, time: local.time, done: false });

  at++;
  todos.edit(local.id, { notes: "Water after planting", list: home.id, done: true });
  await poll();
  expect(tasks.get(planted.id)).toMatchObject({ project: "home", notes: "Water after planting", done: true });
  at++;
  todos.edit(local.id, { date: null, time: null, done: false });
  await poll();
  expect(tasks.get(planted.id)).toMatchObject({ date: null, time: null, done: false });
  todos.remove(local.id);
  await poll();
  expect(tasks.has(planted.id)).toBe(false);

  putRemote("recurring", { title: "Refill the large feeder", project: "inbox", done: true });
  await openPage();
  expect(todos.syncOne(recurring.id)).toMatchObject({ list: null, notes: "", title: "Refill the large feeder", doneAt: at });
  putRemote("recurring", { title: "Refill the large feeder", done: false });
  await poll(120_000);
  expect(todos.syncOne(recurring.id)?.doneAt).toBeNull();
  tasks.delete("recurring");
  await openPage();
  expect(todos.syncOne(recurring.id)?.deleted).toBe(true);

  account = "account-b";
  expect(sync.status()).toMatchObject({ enabled: true, state: "reconnect" });
  const calls = reads;
  await poll(120_000);
  expect(reads).toBe(calls);
  expect(sync.setEnabled(false)).toBe(true);
  expect(sync.status()).toMatchObject({ enabled: false, state: "off" });
  account = undefined;
  expect(sync.status()).toBeUndefined();
});

it("retries offline work and recovers a committed create with a lost response after restart", async () => {
  outage = true;
  sync.setEnabled(true);
  await sync.idle();
  expect(sync.status()).toMatchObject({ state: "retry", log: [{ event: "retry", count: 1 }] });
  const local = todos.add(fields("Feed the birds"));
  await poll(14_999);
  expect(reads).toBe(1);

  outage = false;
  loseReply = true;
  await poll(1);
  expect(tasks.size).toBe(1);
  expect(writes).toEqual(["create"]);
  expect(sync.status()).toMatchObject({ state: "retry", log: [{ event: "retry", count: 2 }, { event: "retry", count: 1 }] });
  await sync.close();
  database.close();
  start();
  at++;
  todos.edit(local.id, { notes: "Use the sunflower seed" });
  await openPage(29_998);
  expect(tasks.size).toBe(1);
  expect(writes).toEqual(["create"]);
  await openPage(1);
  expect(writes).toEqual(["create", "update"]);
  expect([...tasks.values()][0]).toMatchObject({ title: "Feed the birds", notes: "Use the sunflower seed" });
  expect(todos.syncRows()).toHaveLength(1);
  expect(sync.status()).toMatchObject({ state: "ready", lastSync: at });
});

it("uses the later edit, avoids repeat writes, and leaves tasks alone in unavailable projects", async () => {
  putRemote("task", { title: "Original", project: "home" });
  sync.setEnabled(true);
  await sync.idle();
  const local = todos.syncRows()[0]!;
  at += 1_000;
  todos.edit(local.id, { title: "Earlier local" });
  at += 1_000;
  putRemote("task", { title: "Later remote" });
  await poll();
  expect(todos.syncOne(local.id)?.title).toBe("Later remote");
  expect(writes).toEqual([]);

  at += 1_000;
  putRemote("task", { title: "Earlier remote" });
  at += 1_000;
  todos.edit(local.id, { title: "Later local" });
  await poll();
  expect(tasks.get("task")?.title).toBe("Later local");
  await poll(120_000);
  expect(writes).toEqual(["update"]);

  projects.set("home", { id: "home", name: "Home", closed: true });
  await openPage();
  expect(todos.syncOne(local.id)?.deleted).toBe(false);
  putRemote("task", { title: "Moved to inbox", project: "inbox" });
  await openPage();
  expect(todos.syncOne(local.id)).toMatchObject({ title: "Moved to inbox", list: null, deleted: false });
});

it("resumes the rest of a local edit after a confirmed project move", async () => {
  putRemote("task", { title: "Original", project: "home" });
  sync.setEnabled(true);
  await sync.idle();
  const local = todos.syncRows()[0]!;
  at++;
  todos.edit(local.id, { title: "Moved and renamed", list: null, done: true });
  interruptedUpdate = true;
  await poll();
  expect(tasks.get("task")).toMatchObject({ title: "Original", project: "inbox", done: false });
  expect(sync.status()?.state).toBe("retry");
  await poll(15_000);
  expect(tasks.get("task")).toMatchObject({ title: "Moved and renamed", project: "inbox", done: true });
  expect(writes).toEqual(["update", "update"]);
});

it("requires the authenticated owner to enable sync and omits it from a loopback hub", async () => {
  const key = await signingKey("ticktick-settings");
  const managed = await startTestHub({
    config: testConfig(join(dataDir, "managed")), clock, keySource: staticKeySource(keySet(key)), tickTickGateway: gateway,
  });
  try {
    const url = `http://127.0.0.1:${managed.address.port}`;
    const jwt = await assertion({ key, clock });
    const toggle = (origin: string, token?: string) => fetch(url + tickTickSyncPath, {
      method: "PUT", body: JSON.stringify({ enabled: true }),
      headers: { origin, "content-type": "application/json", ...(token === undefined ? {} : { "cf-access-jwt-assertion": token }) },
    });
    expect((await toggle(url)).status).toBe(403);
    expect((await toggle("https://other.example", jwt)).status).toBe(403);
    expect(managed.settings.snapshot().tickTickSync).toMatchObject({ enabled: false, state: "off" });
    const response = await toggle(url, jwt);
    expect(response.status).toBe(200);
    expect(SettingsSnapshot.parse(await response.json()).tickTickSync?.enabled).toBe(true);
  } finally {
    await managed.close();
  }

  const localDir = join(dataDir, "local");
  const local = await startTestHub({
    config: {
      dataDir: localDir, brainTokenFile: join(localDir, "brain.token"), host: "127.0.0.1", port: 0,
      ownerEmail: "owner@local.invalid", projectFolders: [],
    },
    clock, tickTickGateway: gateway,
  });
  try {
    expect(local.settings.snapshot().tickTickSync).toBeUndefined();
  } finally {
    await local.close();
  }
});

it("syncs hand-off completion and reopening as ordinary to-do changes", async () => {
  const key = await signingKey("ticktick-handoff");
  let tick: () => void = () => { throw new Error("TickTick ticker did not start"); };
  const managed = await startTestHub({
    config: testConfig(join(dataDir, "handoff")), clock, keySource: staticKeySource(keySet(key)), tickTickGateway: gateway,
    tickTickTicker: (poll) => { tick = poll; return () => undefined; },
  });
  try {
    putRemote("task", { title: "Check the forecast" });
    const origin = `http://127.0.0.1:${managed.address.port}`;
    const jwt = await assertion({ key, clock });
    const response = await fetch(origin + tickTickSyncPath, {
      method: "PUT", body: JSON.stringify({ enabled: true }),
      headers: { origin, "content-type": "application/json", "cf-access-jwt-assertion": jwt },
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(managed.settings.snapshot().tickTickSync?.state).toBe("ready"));
    const local = managed.todos.snapshot().todos[0]!;
    at += 1_000;
    const topic = managed.todos.handoff(local.id);
    tick();
    await vi.waitFor(() => expect(managed.settings.snapshot().tickTickSync?.state).toBe("ready"));
    expect(tasks.get("task")?.done).toBe(true);
    expect(managed.todos.get(local.id)).toMatchObject({ topic, doneAt: at });

    at += 1_000;
    managed.todos.edit(local.id, { done: false });
    tick();
    await vi.waitFor(() => expect(managed.settings.snapshot().tickTickSync?.state).toBe("ready"));
    expect(tasks.get("task")?.done).toBe(false);
    expect(managed.todos.get(local.id)).toMatchObject({ topic, doneAt: null });
    expect(writes).toEqual(["update", "update"]);
  } finally {
    await managed.close();
  }
});
