import { expect, it } from "vitest";
import { tickTickWrites } from "./app-gateway.js";
import { appRefusal } from "./app-server.js";
import { createTickTickGateway, type TickTickFields } from "./ticktick-gateway.js";

const prefix = "ticktick_to_do_list_calendar.";
const id = "a".repeat(24);
const date = "2026-11-27";
const time = "09:30";
const fields: TickTickFields = { project: "inbox", title: "Plant bulbs", notes: "In the garden", date, time, done: false };

it("uses the recorded account and preserves reminders and unrelated task fields", async () => {
  const writes: unknown[] = [];
  let link = "account";
  let remote: Record<string, unknown> | null = null;
  const adapter = createTickTickGateway({
    status: () => ({ connected: true, ticktick: true, mailboxes: [], teams: false }),
    has: () => true,
    connectionOf: () => link,
    call: async (name, args) => {
      if (name === prefix + "list_projects") return { result: [{ id: "inbox", name: "Inbox" }] };
      if (name === prefix + "get_project_with_undone_tasks") return { project: args["project_id"] === "inbox" ? null : { id: args["project_id"] }, tasks: null };
      if (remote === null) throw appRefusal("TickTick API error [resource_not_found]: missing task");
      return { result: remote };
    },
    writeTickTick: async (name, args, account, allowed) => {
      expect(account).toBe("account");
      if (!allowed()) throw new Error("Write denied");
      writes.push({ name, args });
      switch (name) {
        case tickTickWrites.create:
          remote = { ...(args["tasks"] as Record<string, unknown>[])[0], etag: "1", modifiedTime: "2026-11-27T14:00:00Z" };
          return { id2etag: { [id]: "1" } };
        case tickTickWrites.update:
          remote = { ...remote, ...args["task"] as Record<string, unknown>, etag: "2" };
          return remote;
        case tickTickWrites.complete:
          remote = { ...remote, status: 2 };
          return { result: remote };
        case tickTickWrites.delete:
          remote = null;
          return { result: { deleted: id } };
        default: throw new Error("Unexpected write");
      }
    },
  }, "America/New_York");

  expect(adapter.account()).toBe("account");
  const session = adapter.session("account", () => true);
  expect(await session.projects()).toEqual([{ id: "inbox", name: "Inbox" }]);
  expect(await session.open("inbox")).toEqual([]);
  expect(await session.task(id)).toBeNull();
  const created = await session.create(id, fields);
  expect(created).toMatchObject({ ...fields, id, modifiedAt: Date.UTC(2026, 10, 27, 14) });
  const progress: string[] = [];
  const completed = await session.update(created, { ...fields, title: "Plant tulips", done: true }, (task) => progress.push(task.title));
  expect(completed).toMatchObject({ title: "Plant tulips", done: true, date, time });
  const reopened = await session.update(completed, { ...fields, title: "Plant tulips", date: null, time: null }, () => undefined);
  expect(reopened).toMatchObject({ date: null, time: null, done: false });
  expect(progress).toEqual(["Plant tulips"]);
  expect(writes).toEqual([
    { name: tickTickWrites.create, args: { client_timezone: "America/New_York", tasks: [{
      id, projectId: "inbox", title: fields.title, content: fields.notes, dueDate: "2026-11-27T09:30:00.000-05:00",
      isAllDay: false, timeZone: "America/New_York", status: 0, reminders: [],
    }] } },
    { name: tickTickWrites.update, args: { task_id: id, task: { projectId: "inbox", title: "Plant tulips", etag: "1" } } },
    { name: tickTickWrites.complete, args: { task_id: id, project_id: "inbox" } },
    { name: tickTickWrites.update, args: { task_id: id, task: { projectId: "inbox", dueDate: null, isAllDay: false, timeZone: "America/New_York", status: 0, etag: "2" } } },
  ]);

  link = "another-account";
  await expect(session.remove(reopened)).rejects.toThrow("Write denied");
  link = "account";
  await session.remove(reopened);
  expect(await session.task(id)).toBeNull();
});
