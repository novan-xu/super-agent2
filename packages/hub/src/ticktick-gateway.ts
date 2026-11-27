import { TodoDate, TodoTime, type TodoFields } from "@super-agent2/protocol";
import { CronDate } from "cron-parser";
import { z } from "zod";
import { type AppGateway, tickTickWrites } from "./app-gateway.js";
import { AppGatewayError, appRefusal } from "./app-server.js";

const reads = {
  projects: "ticktick_to_do_list_calendar.list_projects",
  opened: "ticktick_to_do_list_calendar.get_project_with_undone_tasks",
  task: "ticktick_to_do_list_calendar.get_task_by_id",
} as const;

const Project = z.object({
  id: z.string().min(1), name: z.string().min(1), kind: z.string().nullish(), closed: z.boolean().nullish(), permission: z.string().nullish(),
});
export type TickTickProject = z.infer<typeof Project>;
const Task = z.object({
  id: z.string().min(1), projectId: z.string().min(1), title: z.string(), content: z.string().nullish(),
  dueDate: z.string().nullish(), isAllDay: z.boolean().nullish(), isFloating: z.boolean().nullish(),
  status: z.number().int().nullish(), modifiedTime: z.string().nullish(), etag: z.string().nullish(), repeatFlag: z.string().nullish(),
  kind: z.string().nullish(),
});
const OpenProject = z.object({ project: z.object({ id: z.string() }).nullable(), tasks: z.array(Task).nullable() });
const WriteBatch = z.object({ id2etag: z.record(z.string(), z.string()) });

export const tickTickInbox = "inbox";

export type TickTickFields = Omit<TodoFields, "list"> & { readonly project: string; readonly done: boolean };
export interface TickTickTask extends TickTickFields {
  readonly id: string;
  readonly modifiedAt: number | null;
  readonly etag: string | null;
  readonly repeating: boolean;
  readonly note: boolean;
}

export interface TickTickSession {
  projects(): Promise<TickTickProject[]>;
  open(project: string): Promise<TickTickTask[]>;
  task(id: string): Promise<TickTickTask | null>;
  createProject(name: string): Promise<TickTickProject>;
  create(id: string, fields: TickTickFields): Promise<TickTickTask>;
  update(task: TickTickTask, fields: TickTickFields, progress: (task: TickTickTask) => void): Promise<TickTickTask>;
  remove(task: TickTickTask): Promise<void>;
}

export interface TickTickGateway {
  connected(): boolean;
  account(): string | undefined;
  session(account: string, authorized: () => boolean): TickTickSession;
}

function localDateTime(iso: string, timeZone: string) {
  const value = new CronDate(iso, timeZone);
  const pad = (part: number) => String(part).padStart(2, "0");
  return {
    date: TodoDate.parse(`${String(value.getFullYear()).padStart(4, "0")}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`),
    time: TodoTime.parse(`${pad(value.getHours())}:${pad(value.getMinutes())}`),
  };
}

function taskOf(task: z.infer<typeof Task>, timeZone: string): TickTickTask {
  const date = task.dueDate;
  const due = !date || date.startsWith("1970-01-01T00:00:00.000+0000") ? { date: null, time: null }
    : task.isAllDay ? { date: TodoDate.parse(date.slice(0, 10)), time: null }
    : task.isFloating ? { date: TodoDate.parse(date.slice(0, 10)), time: TodoTime.parse(date.slice(11, 16)) }
    : localDateTime(date, timeZone);
  const modifiedAt = Date.parse(task.modifiedTime ?? "");
  return {
    id: task.id, project: task.projectId, title: task.title.trim(), notes: task.content ?? "", ...due,
    done: task.status === 2 || task.status === -1, modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : null,
    etag: task.etag ?? null, repeating: !!task.repeatFlag, note: task.kind === "NOTE",
  };
}

function dueFields(fields: TickTickFields, timeZone: string) {
  return {
    dueDate: fields.date === null ? null : new CronDate(`${fields.date}T${fields.time ?? "00:00"}:00`, timeZone).toJSON(),
    isAllDay: fields.date !== null && fields.time === null,
    timeZone,
  };
}

export function createTickTickGateway(gateway: Pick<AppGateway, "has" | "connectionOf" | "status" | "call" | "writeTickTick">, timeZone: string): TickTickGateway {
  const account = () => {
    const required = [...Object.values(reads), ...Object.values(tickTickWrites)];
    const id = gateway.connectionOf(reads.projects) ?? gateway.connectionOf(tickTickWrites.create);
    return id !== undefined && required.every((name) => gateway.has(name) && gateway.connectionOf(name) === id) ? id : undefined;
  };
  return {
    connected: () => gateway.status().ticktick,
    account,
    session: (id, authorized) => {
      const permitted = () => authorized() && account() === id;
      const read = (name: (typeof reads)[keyof typeof reads], args: Record<string, unknown>) => {
        if (!permitted()) throw new AppGatewayError("tool unavailable");
        return gateway.call(name, args);
      };
      const write = (name: (typeof tickTickWrites)[keyof typeof tickTickWrites], args: Record<string, unknown>) => gateway.writeTickTick(name, args, id, permitted);
      const task = async (taskId: string): Promise<TickTickTask | null> => {
        try {
          const result = z.object({ result: z.union([Task, z.object({ error: z.string() })]) }).parse(await read(reads.task, { task_id: taskId })).result;
          if ("error" in result) throw appRefusal(result.error);
          return taskOf(result, timeZone);
        } catch (error) {
          if (error instanceof AppGatewayError && error.status === 404) return null;
          throw error;
        }
      };
      const confirm = async (taskId: string) => {
        const result = await task(taskId);
        if (result === null) throw new AppGatewayError("write outcome unknown");
        return result;
      };
      return {
        projects: async () => z.object({ result: z.array(Project) }).parse(await read(reads.projects, {})).result,
        open: async (project) => {
          const found = OpenProject.parse(await read(reads.opened, { project_id: project }));
          const tasks = found.tasks ?? [];
          if ((found.project?.id ?? (project === tickTickInbox ? tickTickInbox : undefined)) !== project
            || tasks.some((row) => row.projectId !== project)) throw new AppGatewayError("invalid response");
          return tasks.map((row) => taskOf(row, timeZone));
        },
        task,
        createProject: async (name) => Project.parse(await write(tickTickWrites.createProject, { name, kind: "TASK" })),
        create: async (taskId, fields) => {
          const result = WriteBatch.parse(await write(tickTickWrites.create, {
            client_timezone: timeZone,
            tasks: [{ id: taskId, projectId: fields.project, title: fields.title, content: fields.notes, ...dueFields(fields, timeZone), status: fields.done ? 2 : 0, reminders: [] }],
          }));
          if (!Object.hasOwn(result.id2etag, taskId)) throw new AppGatewayError("write outcome unknown");
          return confirm(taskId);
        },
        update: async (current, fields, progress) => {
          let confirmed = current;
          if (current.project !== fields.project) {
            const moved = z.object({ result: z.array(Task) }).parse(await write(tickTickWrites.move, {
              moves: [{ taskId: current.id, fromProjectId: current.project, toProjectId: fields.project }],
            }));
            if (!moved.result.some(({ id: movedId, projectId }) => movedId === current.id && projectId === fields.project)) throw new AppGatewayError("write outcome unknown");
            confirmed = await confirm(current.id);
            if (confirmed.title !== current.title || confirmed.notes !== current.notes || confirmed.date !== current.date
              || confirmed.time !== current.time || confirmed.done !== current.done) throw new AppGatewayError("write outcome unknown");
            progress(confirmed);
          }
          const patch = {
            ...(fields.title === confirmed.title ? {} : { title: fields.title }),
            ...(fields.notes === confirmed.notes ? {} : { content: fields.notes }),
            ...(fields.date === confirmed.date && fields.time === confirmed.time ? {} : dueFields(fields, timeZone)),
            ...(!fields.done && confirmed.done ? { status: 0 } : {}),
          };
          if (Object.keys(patch).length > 0) {
            const patched = taskOf(Task.parse(await write(tickTickWrites.update, {
              task_id: current.id,
              task: { projectId: fields.project, ...patch, ...(confirmed.etag === null ? {} : { etag: confirmed.etag }) },
            })), timeZone);
            const expected = { ...fields, done: fields.done && confirmed.done };
            if (patched.id === current.id && patched.project === expected.project && patched.title === expected.title
              && patched.notes === expected.notes && patched.date === expected.date && patched.time === expected.time && patched.done === expected.done) progress(patched);
          }
          if (fields.done && !confirmed.done) {
            z.object({ result: Task }).parse(await write(tickTickWrites.complete, { task_id: current.id, project_id: fields.project }));
          }
          return confirm(current.id);
        },
        remove: async (current) => {
          const response = z.object({ result: z.object({ deleted: z.string() }) }).parse(await write(tickTickWrites.delete, { task_id: current.id, project_id: current.project }));
          if (response.result.deleted !== current.id) throw new AppGatewayError("write outcome unknown");
        },
      };
    },
  };
}
