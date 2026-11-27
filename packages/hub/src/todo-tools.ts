import { text } from "@super-agent2/catalog";
import { pagePath, type Todo, TodoDate, TodoId, type TodoList, TodoListName, TodoTitle, todoTools } from "@super-agent2/protocol";
import { CronDate } from "cron-parser";
import { z } from "zod";
import type { HubDatabase } from "./database.js";
import { TodoRefused, type Todos } from "./todos.js";

const ownerRequested = z.literal(true).describe("Set only for a to-do change the owner asked for in the current message.");
const Due = z.union([TodoDate, z.iso.datetime({ local: true, offset: true })]).describe("An all-day ISO date or a due date and time in the hub's time zone. An explicit ISO offset is accepted.");
const AddTodo = z.strictObject({
  owner_requested: ownerRequested,
  title: TodoTitle,
  list: TodoListName.optional().describe("Name of a built-in list. Omit to use Inbox."),
  due: Due.optional(),
  notes: z.string().max(8000).optional(),
  remind: z.literal(true).optional().describe("Set when the owner asks for a reminder at the due time. Requires a date and time. The hub's notification setting applies."),
});
const TodoLookup = z.strictObject({
  query: z.string().trim().min(1).max(1000).optional().describe("Search task titles and notes. Omit to list available lists."),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(25).default(20),
});
const UpdateTodo = z.strictObject({
  owner_requested: ownerRequested,
  task_id: TodoId.describe("The task ID from todo_lookup or add_todo."),
  due: Due.nullable().optional().describe("Set a new due date and optional time, or pass null to clear both."),
  done: z.boolean().optional().describe("Pass true to complete the task or false to reopen it."),
}).refine(({ due, done }) => due !== undefined || done !== undefined);
const UndoCreated = z.strictObject({
  owner_requested: ownerRequested,
  receipt: TodoId.optional().describe("The receipt from add_todo. Omit to undo the latest creation in this topic."),
});

const tools = {
  todo_lookup: { schema: TodoLookup, description: "List built-in to-do lists or search open and completed to-dos by keyword." },
  add_todo: { schema: AddTodo, description: "Add the owner's personal to-do to Super Agent when asked. Search for near-duplicates with todo_lookup first and report what you added." },
  update_todo: { schema: UpdateTodo, description: "Complete, reopen, or change the date of a built-in to-do when the owner asks. Use todo_lookup to find its ID." },
  undo_created: { schema: UndoCreated, description: "Undo a to-do you created in Super Agent when the owner asks. Use its receipt or omit it for the latest creation in this topic." },
} satisfies Record<(typeof todoTools)[number], { schema: z.ZodType; description: string }>;

export function todoDefinitions(writes: boolean) {
  return todoTools.filter((name) => writes || name === "todo_lookup").map((name) => ({
    name,
    description: tools[name].description,
    inputSchema: z.toJSONSchema(tools[name].schema, { io: "input" }),
  }));
}

class TodoToolError extends Error {}

function dueFields(due: string | null, timeZone: string): { date: string | null; time: string | null } {
  if (due === null || due.length === 10) return { date: due, time: null };
  const when = new CronDate(due, timeZone);
  const pad = (number: number) => String(number).padStart(2, "0");
  const date = `${String(when.getFullYear()).padStart(4, "0")}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (!/(?:Z|[+-]\d\d:\d\d)$/u.test(due) && (due.slice(0, 10) !== date || due.slice(11, 16) !== time)) {
    throw new TodoToolError("That local due time does not exist in the hub's time zone. Choose a different time.");
  }
  return { date, time };
}

const inbox = text("todo.view.inbox");
const fold = (value: string) => value.normalize("NFC").toLowerCase();

function listOf(lists: readonly TodoList[], name: string | undefined): TodoList | null {
  if (name === undefined) return null;
  const matches = lists.filter((list) => !list.archived && fold(list.name) === fold(name));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0 && (fold(name) === "inbox" || name === inbox)) return null;
  const available = [inbox, ...lists.filter((list) => !list.archived).map((list) => list.name)];
  throw new TodoToolError(`${matches.length === 0 ? "No open built-in list has that name." : "More than one open built-in list has that name."} Available lists: ${available.join(", ")}.`);
}

function describe(todo: Todo, lists: readonly TodoList[]) {
  return {
    taskId: todo.id,
    title: todo.title,
    list: lists.find(({ id }) => id === todo.list)?.name ?? inbox,
    date: todo.date,
    time: todo.time,
    done: todo.doneAt !== null,
    url: pagePath({ view: "todos", todo: todo.id }),
  };
}

export function createTodoTools(database: HubDatabase, todos: Todos) {
  const { ticketTimeZone: timeZone } = database;
  const legacyReceipt = database.connection.prepare("SELECT 1 FROM ticktick_receipts WHERE id = ?");
  return (name: (typeof todoTools)[number], raw: Record<string, unknown>, topic: string): unknown => {
    switch (name) {
      case "todo_lookup": {
        const { query, limit, offset } = TodoLookup.parse(raw);
        const lists = todos.lists();
        if (query === undefined) {
          const available = [{ id: null, name: inbox }, ...lists.filter((list) => !list.archived).map(({ id, name }) => ({ id, name }))];
          return { lists: available.slice(offset, offset + limit), nextOffset: available.length > offset + limit ? offset + limit : null };
        }
        const matches = todos.search(query, limit + 1, offset);
        return { tasks: matches.slice(0, limit).map((todo) => describe(todo, lists)), nextOffset: matches.length > limit ? offset + limit : null };
      }
      case "add_todo": {
        const input = AddTodo.parse(raw);
        const due = dueFields(input.due ?? null, timeZone);
        if (input.remind && due.time === null) throw new TodoToolError("A reminder at the due time needs both a date and a time.");
        const lists = todos.lists();
        const list = listOf(lists, input.list);
        const todo = todos.add({ title: input.title, notes: input.notes ?? "", list: list?.id ?? null, ...due }, topic);
        return { ...describe(todo, lists), receipt: todo.id, undoAvailable: true };
      }
      case "update_todo": {
        const { task_id, due, done } = UpdateTodo.parse(raw);
        const todo = todos.edit(task_id, { ...(done === undefined ? {} : { done }), ...(due === undefined ? {} : dueFields(due, timeZone)) });
        return describe(todo, todos.lists());
      }
      case "undo_created": {
        const input = UndoCreated.parse(raw);
        const found = todos.brainCreation(topic, input.receipt);
        if (found === undefined) {
          if (input.receipt !== undefined && legacyReceipt.get(input.receipt) !== undefined) {
            throw new TodoToolError("This receipt belongs to a task created in TickTick. Open TickTick to undo it.");
          }
          throw new TodoToolError("There is no matching built-in to-do creation receipt to undo.");
        }
        if (!found.deleted) todos.remove(found.id);
        return { receipt: found.id, undone: true, ...(found.deleted ? { alreadyUndone: true } : {}) };
      }
    }
  };
}

export type TodoToolCall = ReturnType<typeof createTodoTools>;

export function todoToolError(error: unknown): string {
  if (error instanceof TodoToolError) return error.message;
  if (error instanceof TodoRefused && error.code === "not_found") return "That to-do or list could not be found.";
  if (error instanceof z.ZodError || error instanceof TodoRefused) return "Check the to-do tool's arguments and try again.";
  return "The hub could not complete the to-do request.";
}
