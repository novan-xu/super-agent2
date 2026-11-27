import { z } from "zod";
import { ConversationId } from "./conversations.js";

export const todosPath = "/api/todos";
export const todoListsPath = `${todosPath}/lists`;
export const todoReminderSettingsPath = "/api/settings/todo-reminders";
export const TodoId = z.uuid();
export const TodoDate = z.iso.date();
export const TodoTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const TodoReminderSettings = z.strictObject({ enabled: z.boolean(), summaryTime: TodoTime });
export type TodoReminderSettings = z.infer<typeof TodoReminderSettings>;
export const TodoReminderChange = TodoReminderSettings.partial().refine((given) => given.enabled !== undefined || given.summaryTime !== undefined);
export type TodoReminderChange = z.infer<typeof TodoReminderChange>;
export const defaultTodoReminderSettings: TodoReminderSettings = { enabled: true, summaryTime: "09:00" };
export const TodoReminderStatus = TodoReminderSettings.extend({ timeZone: z.string() });
export type TodoReminderStatus = z.infer<typeof TodoReminderStatus>;
export const TodoTitle = z.string().trim().min(1).max(240);
export const TodoListName = z.string().trim().min(1).max(80);

export const TodoFields = z.strictObject({
  title: TodoTitle,
  notes: z.string().max(8000),
  list: TodoId.nullable(),
  date: TodoDate.nullable(),
  time: TodoTime.nullable(),
});
export type TodoFields = z.infer<typeof TodoFields>;
export const TodoCreate = TodoFields.extend({ id: TodoId.optional() });
export type TodoCreate = z.infer<typeof TodoCreate>;
export const TodoEdit = TodoFields.partial().extend({ done: z.boolean().optional() });
export type TodoEdit = z.infer<typeof TodoEdit>;

export const Todo = TodoFields.extend({
  id: TodoId,
  doneAt: z.number().int().nonnegative().nullable(),
  position: z.number().int(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  topic: ConversationId.nullable(),
  sourceTopic: ConversationId.nullable().optional(),
});
export type Todo = z.infer<typeof Todo>;

export const TodoList = z.object({
  id: TodoId,
  name: TodoListName,
  position: z.number().int(),
  archived: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});
export type TodoList = z.infer<typeof TodoList>;
export const TodoListCreate = z.strictObject({ name: TodoListName });
export const TodoListEdit = z.strictObject({ name: TodoListName.optional(), archived: z.boolean().optional() });
export type TodoListEdit = z.infer<typeof TodoListEdit>;
export const TodoReorder = z.strictObject({ anchor: TodoId, side: z.enum(["before", "after"]) });
export type TodoReorder = z.infer<typeof TodoReorder>;

export const TodoSnapshot = z.object({
  todos: z.array(Todo),
  lists: z.array(TodoList),
  timeZone: z.string(),
  selected: Todo.optional(),
});
export type TodoSnapshot = z.infer<typeof TodoSnapshot>;
export const TodoHandoff = z.object({ topic: ConversationId });
export const TodoChanged = z.object({ type: z.literal("todos.changed") });
export type TodoChanged = z.infer<typeof TodoChanged>;

export const todoViews = ["today", "planned", "inbox", "completed"] as const;
export type TodoView = (typeof todoViews)[number] | { readonly list: string };

export function todoDay(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

export function nextTodoDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
