import { randomUUID } from "node:crypto";
import { CronDate } from "cron-parser";
import { z } from "zod";
import { type AppGateway, AppInputError, appWrites } from "./app-gateway.js";
import { AppGatewayError } from "./app-server.js";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";

const Text = z.string().trim().min(1);
const Id = Text.max(2048);

export const AddTodo = z.strictObject({
  owner_requested: z.literal(true).describe("Set only for a personal task or reminder in the owner's current message."),
  title: Text.max(500),
  list: Text.max(200).optional().describe("Name of an open TickTick list. Omit to use TickTick's default list."),
  due: z.union([z.iso.date(), z.iso.datetime({ local: true, offset: true })]).optional()
    .describe("An all-day date or ISO date and time in the hub's time zone. An explicit offset is accepted."),
  notes: Text.max(8000).optional(),
  remind: z.literal(true).optional().describe("Set a notification at the due time when the owner explicitly asks for a timed reminder."),
});

export const UndoCreated = z.strictObject({
  owner_requested: z.literal(true).describe("Set only when the owner asks to undo a task you created."),
  receipt: Id.optional().describe("The receipt from add_todo. Omit to undo the latest creation in this topic."),
});

const Projects = z.object({ result: z.array(z.object({ name: Text, id: Id, closed: z.boolean().nullish() })) });
const CreatedTask = z.object({ id: Id, projectId: Id.nullish(), title: Text.nullish() });
const Created = z.union([CreatedTask, z.object({ result: CreatedTask }).transform(({ result }) => result)]);
const Deleted = z.object({ result: z.object({ deleted: Id }) });
const Refusal = z.object({ error: z.string() });
const Receipt = z.object({ id: Id, connection: Id, task: Id, project: Id, undone_at: z.number().nullable() });
const listProjects = "ticktick_to_do_list_calendar.list_projects";

export interface AppWriteScope {
  readonly conversation: string;
  readonly authorized: () => boolean;
}

function dueFields(due: string, timeZone: string) {
  const date = new CronDate(due, timeZone);
  const isAllDay = due.length === 10;
  if (!/(?:Z|[+-]\d\d:\d\d)$/u.test(due)) {
    const pad = (number: number) => String(number).padStart(2, "0");
    const day = `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (due.slice(0, 10) !== day || (isAllDay ? time !== "00:00" : due.slice(11, 16) !== time)) {
      throw new AppInputError("That local due time does not exist in the hub's time zone. Choose a different time.");
    }
  }
  return { dueDate: date.toJSON(), isAllDay, timeZone };
}

function isRefusal(reply: unknown): boolean {
  return Refusal.safeParse(reply).success || z.object({ result: Refusal }).safeParse(reply).success;
}

function normalizeList(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

async function findProject(gateway: AppGateway, name: string) {
  const matches = new Map<string, string>();
  const seen = new Set<string>();
  const requested = normalizeList(name);
  const limit = 50;
  for (let offset = 0; ; offset += limit) {
    const page = Projects.safeParse(await gateway.call(listProjects, { limit, offset }));
    if (!page.success) {
      throw new AppGatewayError("invalid response");
    }
    const before = seen.size;
    for (const list of page.data.result) {
      seen.add(list.id);
      if (list.closed !== true && normalizeList(list.name) === requested) {
        matches.set(list.id, list.name);
      }
    }
    if (page.data.result.length < limit) {
      break;
    }
    if (before === seen.size) {
      throw new AppGatewayError("invalid response");
    }
  }
  const match = matches.size === 1 ? matches.entries().next().value : undefined;
  if (match === undefined) {
    throw new AppInputError(matches.size === 0 ? "No open TickTick list has that name." : "More than one open TickTick list has that name.");
  }
  return { id: match[0], name: match[1] };
}

export function createAppTodos(database: HubDatabase, clock: Clock) {
  const { connection, ticketTimeZone: timeZone } = database;
  const insert = connection.prepare("INSERT INTO ticktick_receipts (id, topic, connection, task, project, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const byId = connection.prepare("SELECT id, connection, task, project, undone_at FROM ticktick_receipts WHERE id = ?");
  const latest = connection.prepare("SELECT id, connection, task, project, undone_at FROM ticktick_receipts WHERE topic = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const markUndone = connection.prepare("UPDATE ticktick_receipts SET undone_at = ? WHERE id = ?");
  const undoing = new Set<string>();

  return {
    async add(gateway: AppGateway, input: z.output<typeof AddTodo>, scope: AppWriteScope) {
      const connectorAccount = gateway.connectionOf(appWrites.tickTickCreate);
      if (connectorAccount === undefined) {
        throw new AppInputError("TickTick task creation is unavailable for this connection.");
      }
      if (input.remind && (input.due === undefined || input.due.length === 10)) {
        throw new AppInputError("A reminder at the due time needs both a date and a time.");
      }
      const due = input.due === undefined ? {} : dueFields(input.due, timeZone);
      const project = input.list === undefined ? undefined : await findProject(gateway, input.list);
      const response = await gateway.write(appWrites.tickTickCreate, {
        task: {
          title: input.title,
          ...due,
          ...(project === undefined ? {} : { projectId: project.id }),
          ...(input.notes === undefined ? {} : { content: input.notes }),
          ...(input.remind ? { reminders: ["TRIGGER;RELATED=END:PT0S"] } : {}),
        },
        client_timezone: timeZone,
      }, () => scope.authorized() && gateway.connectionOf(appWrites.tickTickCreate) === connectorAccount);
      if (isRefusal(response)) {
        throw new AppGatewayError("tool refused");
      }
      const created = Created.safeParse(response);
      if (!created.success) {
        throw new AppGatewayError("write outcome unknown");
      }
      const projectId = created.data.projectId ?? project?.id;
      if (projectId === undefined) {
        throw new AppInputError("TickTick created the task but returned no list ID. Undo is unavailable for this task.");
      }
      const id = randomUUID();
      try {
        insert.run(id, scope.conversation, connectorAccount, created.data.id, projectId, clock.now());
      } catch {
        throw new AppInputError("TickTick created the task but the hub could not save its undo receipt.");
      }
      return { receipt: id, taskId: created.data.id, title: created.data.title ?? input.title, projectId, list: project?.name ?? null, due: input.due ?? null };
    },

    async undo(gateway: AppGateway, input: z.output<typeof UndoCreated>, scope: AppWriteScope) {
      const found = Receipt.safeParse(input.receipt === undefined ? latest.get(scope.conversation) : byId.get(input.receipt));
      if (!found.success) {
        throw new AppInputError("There is no matching TickTick creation receipt to undo.");
      }
      const receipt = found.data;
      if (receipt.undone_at !== null) {
        return { receipt: receipt.id, undone: true, alreadyUndone: true };
      }
      const sameAccount = () => gateway.connectionOf(appWrites.tickTickDelete) === receipt.connection;
      if (!sameAccount()) {
        throw new AppInputError("The receipt's TickTick connection is unavailable.");
      }
      if (undoing.has(receipt.id)) {
        throw new AppInputError("This TickTick creation is already being undone.");
      }
      undoing.add(receipt.id);
      try {
        const result = await gateway.write(appWrites.tickTickDelete, { task_id: receipt.task, project_id: receipt.project },
          () => scope.authorized() && sameAccount());
        if (isRefusal(result)) {
          throw new AppGatewayError("tool refused");
        }
        const deleted = Deleted.safeParse(result);
        if (!deleted.success || deleted.data.result.deleted !== receipt.task) {
          throw new AppGatewayError("write outcome unknown");
        }
        try {
          markUndone.run(clock.now(), receipt.id);
        } catch {
          throw new AppInputError("TickTick deleted the task but the hub could not update its undo receipt.");
        }
        return { receipt: receipt.id, undone: true };
      } finally {
        undoing.delete(receipt.id);
      }
    },
  };
}

export type AppTodos = ReturnType<typeof createAppTodos>;
