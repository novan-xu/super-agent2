import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushPayload, SettingsSnapshot, TodoSnapshot, todoReminderSettingsPath, todosPath, type TodoFields } from "@super-agent2/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Hub } from "./hub.js";
import { createPushDevice, receivePush } from "./push-device.js";
import { generateVapidKeys } from "./push.js";
import { TestClock } from "./testing/access.js";
import { startTestHub } from "./testing/http.js";

const keys = generateVapidKeys();
const device = createPushDevice();
let directory: string;
let clock: TestClock;
let hub: Hub | undefined;
let tick: () => void;
let messages: PushPayload[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "todo-reminders-"));
  clock = new TestClock(Date.parse("2026-11-27T12:00:00Z"));
  messages = [];
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function setClock(at: string) {
  clock.advance(Date.parse(at) - clock.now());
}

async function start(enabled = true) {
  const running = await startTestHub({
    config: {
      ownerEmail: "owner@local.invalid", host: "127.0.0.1", port: 0, dataDir: directory,
      brainTokenFile: join(directory, "brain.token"), projectFolders: [], ticketTimeZone: "America/New_York",
      ...(enabled ? { vapid: keys } : {}),
    },
    clock,
    todoReminderTicker: (next) => { tick = next; return () => undefined; },
    pushFetch: async (_url, init) => {
      messages.push(PushPayload.parse(JSON.parse(receivePush(device, init?.body as Uint8Array))));
      return new Response(null, { status: 201 });
    },
  });
  hub = running;
  if (enabled) expect(running.push?.subscribe({
    endpoint: "http://127.0.0.1:9/device",
    keys: { p256dh: device.p256dh, auth: device.auth },
    applicationServerKey: keys.publicKey,
  }, "http://localhost")).toBe("saved");
  return running;
}

function task(title: string, date: string | null, time: string | null = null): TodoFields {
  return { title, date, time, notes: "", list: null };
}

async function at(time: string) {
  setClock(time);
  tick();
  await hub?.push?.idle();
}

async function restart(time: string) {
  await hub?.close();
  hub = undefined;
  setClock(time);
  const running = await start();
  await running.push?.idle();
  return running;
}

function settings(running: Hub, change: unknown) {
  const origin = `http://127.0.0.1:${running.address.port}`;
  return fetch(origin + todoReminderSettingsPath, {
    method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(change),
  });
}

it("sends a timed reminder at the right local time, once per scheduled slot", async () => {
  let running = await start();
  const due = running.todos.add(task("Water seedlings", "2026-11-27", "09:15"));
  const completed = running.todos.add(task("Already done", "2026-11-27", "09:15"));
  const handedOff = running.todos.add(task("Handed off", "2026-11-27", "09:15"));
  const deleted = running.todos.add(task("Deleted task", "2026-11-27", "09:15"));
  const rescheduled = running.todos.add(task("Rescheduled", "2026-11-27", "09:15"));
  running.todos.edit(completed.id, { done: true });
  running.todos.handoff(handedOff.id);
  running.todos.remove(deleted.id);
  running.todos.edit(rescheduled.id, { time: "10:00" });
  await at("2026-11-27T14:14:59.999Z");
  expect(messages).toEqual([]);
  await at("2026-11-27T14:15:00.000Z");
  expect(messages).toEqual([{ title: "待办到期", body: "Water seedlings", url: `/todos?todo=${due.id}`, tag: `todo:${due.id}` }]);
  await at("2026-11-27T14:16:00Z");
  running = await restart("2026-11-27T14:17:00Z");
  expect(messages).toHaveLength(1);
  await at("2026-11-27T15:00:00Z");
  expect(messages.map(({ body }) => body)).toEqual(["Water seedlings", "Rescheduled"]);
  running.todos.edit(rescheduled.id, { time: "10:01" });
  await at("2026-11-27T15:01:00Z");
  expect(messages.map(({ tag }) => tag)).toEqual([`todo:${due.id}`, `todo:${rescheduled.id}`, `todo:${rescheduled.id}`]);
});

it("catches up on restart across midnight and skips expired timed reminders", async () => {
  const running = await start();
  const due = running.todos.add(task("Missed last night", "2026-11-27", "23:30"));
  running.todos.add(task("Expired last night", "2026-11-27", "20:00"));
  running.todos.add(task("Not due yet", "2026-11-28", "01:00"));
  await restart("2026-11-28T05:20:00Z");
  expect(messages.map(({ url }) => url)).toEqual([`/todos?todo=${due.id}`]);
  await restart("2026-11-28T05:30:00Z");
  expect(messages).toHaveLength(1);
});

it("summarizes only the due and overdue all-day tasks at the configured time, once per day", async () => {
  let running = await start();
  expect(running.settings.snapshot().todoReminders).toEqual({ enabled: true, summaryTime: "09:00", timeZone: "America/New_York" });
  const changed = await settings(running, { summaryTime: "07:45" });
  expect(changed.status).toBe(200);
  expect(SettingsSnapshot.parse(await changed.json()).todoReminders).toMatchObject({ enabled: true, summaryTime: "07:45" });
  expect((await settings(running, { summaryTime: "99:99" })).status).toBe(400);
  const overdue = running.todos.add(task("Overdue", "2026-11-26"));
  const today = running.todos.add(task("Today", "2026-11-27"));
  running.todos.add(task("Timed", "2026-11-27", "22:00"));
  const future = running.todos.add(task("Future", "2026-11-28"));
  const done = running.todos.add(task("Done", "2026-11-27"));
  const handedOff = running.todos.add(task("Handed off", "2026-11-27"));
  const deleted = running.todos.add(task("Deleted", "2026-11-27"));
  running.todos.edit(done.id, { done: true });
  running.todos.handoff(handedOff.id);
  running.todos.remove(deleted.id);
  await at("2026-11-27T12:44:59Z");
  expect(messages).toHaveLength(0);
  await at("2026-11-27T12:45:00Z");
  expect(messages).toEqual([{ title: "待办", body: "2 项全天待办到期或逾期：Overdue、Today", url: "/todos", tag: "todo:2026-11-27" }]);
  running = await restart("2026-11-27T13:00:00Z");
  running.todos.edit(overdue.id, { done: true });
  running.todos.edit(today.id, { done: true });
  running.todos.remove(future.id);
  await at("2026-11-28T12:45:00Z");
  running.todos.add(task("Added after the summary", "2026-11-28"));
  await at("2026-11-28T13:00:00Z");
  expect(messages).toHaveLength(1);
});

it("preserves separate preference changes, and turning notifications off suppresses every reminder across restart", async () => {
  let running = await start();
  const results = await Promise.all([settings(running, { enabled: false }), settings(running, { summaryTime: "08:00" })]);
  expect(results.map(({ status }) => status)).toEqual([200, 200]);
  running.todos.add(task("All-day", "2026-11-27"));
  running.todos.add(task("Timed", "2026-11-27", "08:00"));
  running = await restart("2026-11-27T13:05:00Z");
  expect(running.settings.todoReminders()).toEqual({ enabled: false, summaryTime: "08:00" });
  await at("2026-11-27T13:06:00Z");
  expect(messages).toHaveLength(0);
  expect((await settings(running, { enabled: true })).status).toBe(200);
  await at("2026-11-27T13:07:00Z");
  expect(messages).toHaveLength(2);
});

it("handles shifted and repeated clock times during daylight-saving changes", async () => {
  setClock("2026-03-08T06:00:00Z");
  const running = await start();
  running.todos.add(task("Shifted", "2026-03-08", "02:30"));
  await at("2026-03-08T07:29:59Z");
  expect(messages).toEqual([]);
  await at("2026-03-08T07:30:00Z");
  expect(messages.map(({ body }) => body)).toEqual(["Shifted"]);
  running.todos.add(task("Repeated", "2026-11-01", "01:30"));
  await at("2026-11-01T05:30:00Z");
  expect(messages.map(({ body }) => body)).toEqual(["Shifted", "Repeated"]);
  await at("2026-11-01T06:30:00Z");
  expect(messages).toHaveLength(2);
});

it("loads the task from a reminder even after it leaves Today or the recent completion list", async () => {
  const running = await start();
  const open = running.todos.add(task("Rescheduled", "2026-12-01", "10:00"));
  const old = running.todos.add(task("Completed earlier", "2026-11-27"));
  running.todos.edit(old.id, { done: true });
  clock.advance(1);
  for (let index = 0; index < 100; index++) {
    running.todos.edit(running.todos.add(task(`New completion ${index}`, null)).id, { done: true });
  }
  const address = `http://127.0.0.1:${running.address.port}${todosPath}`;
  const load = async (id: string) => TodoSnapshot.parse(await (await fetch(`${address}?todo=${id}`)).json());
  expect((await load(open.id)).selected).toMatchObject({ id: open.id, date: "2026-12-01" });
  const formerly = await load(old.id);
  expect(formerly.todos.some(({ id }) => id === old.id)).toBe(false);
  expect(formerly.selected?.id).toBe(old.id);
  running.todos.remove(old.id);
  expect((await load(old.id)).selected).toBeUndefined();
});

it("omits reminder settings without configured push", async () => {
  const running = await start(false);
  expect(running.settings.snapshot().todoReminders).toBeUndefined();
  expect((await settings(running, { enabled: true })).status).toBe(404);
});
