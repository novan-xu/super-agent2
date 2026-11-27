import { randomUUID } from "node:crypto";
import { text } from "@super-agent2/catalog";
import { Todo, TodoFields, TodoList, type TodoCreate, type TodoEdit, type TodoListEdit, type TodoReorder, type TodoSnapshot } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";

export class TodoRefused extends Error {
  constructor(readonly code: "not_found" | "bad_request" | "conflict") {
    super(code);
  }
}

const todoColumns = "id, title, notes, list, date, time, done_at AS doneAt, position, created_at AS createdAt, updated_at AS updatedAt, topic, source_topic AS sourceTopic";
const listColumns = "id, name, position, archived, updated_at AS updatedAt";
const ListRow = TodoList.extend({ archived: z.union([z.literal(0), z.literal(1)]).transform(Boolean) });
const Position = z.object({ id: z.string(), position: z.number().int() });
const BrainCreation = z.object({ id: z.string(), deleted: z.union([z.literal(0), z.literal(1)]).transform(Boolean) });
const recentCompletions = 100;

export type Todos = ReturnType<typeof createTodos>;

export function createTodos(database: HubDatabase, clock: Clock, conversations: Pick<ConversationService, "sendToNewDailyTopic" | "get">) {
  const { connection, ticketTimeZone: timeZone } = database;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listen of listeners) listen(); };
  const getTodo = connection.prepare(`SELECT ${todoColumns} FROM todos WHERE id = ? AND deleted = 0`);
  const hasTodo = connection.prepare("SELECT 1 FROM todos WHERE id = ?");
  const open = connection.prepare(`SELECT ${todoColumns} FROM todos WHERE deleted = 0 AND done_at IS NULL ORDER BY position, id`);
  const completed = connection.prepare(`SELECT ${todoColumns} FROM todos WHERE deleted = 0 AND done_at IS NOT NULL ORDER BY done_at DESC, id LIMIT ?`);
  const getList = connection.prepare(`SELECT ${listColumns} FROM todo_lists WHERE id = ?`);
  const lists = connection.prepare(`SELECT ${listColumns} FROM todo_lists ORDER BY position, id`);
  const byName = connection.prepare("SELECT id FROM todo_lists WHERE name = ?");
  const addTodo = connection.prepare(`INSERT INTO todos (id, title, notes, list, date, time, position, created_at, updated_at, source_topic)
    VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MIN(position), 0) - 1 FROM todos), ?, ?, ?)`);
  const search = connection.prepare(`SELECT ${todoColumns} FROM todos WHERE deleted = 0
    AND (instr(lower(title), lower(?)) > 0 OR instr(lower(notes), lower(?)) > 0)
    ORDER BY done_at IS NOT NULL, updated_at DESC, id LIMIT ? OFFSET ?`);
  const creation = connection.prepare("SELECT id, deleted FROM todos WHERE id = ? AND source_topic IS NOT NULL");
  const latestCreation = connection.prepare("SELECT id, deleted FROM todos WHERE source_topic = ? ORDER BY rowid DESC LIMIT 1");
  const editTodo = connection.prepare("UPDATE todos SET title = ?, notes = ?, list = ?, date = ?, time = ?, done_at = ?, updated_at = ? WHERE id = ?");
  const deleteTodo = connection.prepare("UPDATE todos SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0");
  const linkTodo = connection.prepare("UPDATE todos SET topic = ?, updated_at = ? WHERE id = ?");
  const addList = connection.prepare(`INSERT INTO todo_lists (id, name, position, updated_at)
    VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM todo_lists), ?)`);
  const editList = connection.prepare("UPDATE todo_lists SET name = ?, archived = ?, updated_at = ? WHERE id = ?");

  const get = (id: string): Todo | undefined => {
    const row = getTodo.get(id);
    return row === undefined ? undefined : Todo.parse(row);
  };
  const item = (id: string): Todo => {
    const found = get(id);
    if (found === undefined) throw new TodoRefused("not_found");
    return found;
  };
  const list = (id: string): TodoList => {
    const row = getList.get(id);
    if (row === undefined) throw new TodoRefused("not_found");
    return ListRow.parse(row);
  };
  const listRows = () => lists.all().map((row) => ListRow.parse(row));
  const fields = (input: TodoFields, priorList: string | null): TodoFields => {
    const result = TodoFields.safeParse(input);
    if (!result.success || (result.data.date === null && result.data.time !== null)) throw new TodoRefused("bad_request");
    const id = result.data.list;
    if (id !== null && id !== priorList && list(id).archived) throw new TodoRefused("conflict");
    return result.data;
  };
  const validateName = (name: string, id: string) => {
    const match = byName.get(name);
    if (match !== undefined && match["id"] !== id) throw new TodoRefused("conflict");
  };

  const ordering = (table: "todos" | "todo_lists", eligible: string) => {
    const order = connection.prepare(`SELECT id, position FROM ${table} WHERE ${eligible} ORDER BY position, id`);
    const position = connection.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
    const stamp = connection.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`);
    return (id: string, { anchor, side }: TodoReorder) => {
      const rows = z.array(Position).parse(order.all());
      const from = rows.findIndex((row) => row.id === id);
      if (from === -1 || !rows.some((row) => row.id === anchor)) throw new TodoRefused("not_found");
      if (id === anchor) return;
      const next = rows.filter((row) => row.id !== id);
      const target = next.findIndex((row) => row.id === anchor) + (side === "after" ? 1 : 0);
      if (target === from) return;
      next.splice(target, 0, rows[from]!);
      connection.exec("BEGIN IMMEDIATE");
      try {
        for (let index = Math.min(from, target); index <= Math.max(from, target); index++) {
          position.run(rows[index]!.position, next[index]!.id);
        }
        stamp.run(clock.now(), id);
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
      changed();
    };
  };

  return {
    snapshot: (id?: string): TodoSnapshot => {
      const selected = id === undefined ? undefined : get(id);
      return {
        timeZone,
        todos: [...open.all(), ...completed.all(recentCompletions)].map((row) => Todo.parse(row)),
        lists: listRows(),
        ...(selected === undefined ? {} : { selected }),
      };
    },
    get,
    lists: listRows,
    search: (query: string, limit: number, offset: number): Todo[] => search.all(query, query, limit, offset).map((row) => Todo.parse(row)),
    brainCreation: (sourceTopic: string, receipt?: string) => BrainCreation.optional().parse(receipt === undefined ? latestCreation.get(sourceTopic) : creation.get(receipt)),
    add({ id = randomUUID(), ...provided }: TodoCreate, sourceTopic: string | null = null): Todo {
      const existing = get(id);
      const input = fields(provided, existing?.list ?? null);
      if (existing !== undefined && Object.entries(input).every(([key, value]) => existing[key as keyof TodoFields] === value)) return existing;
      if (hasTodo.get(id) !== undefined) throw new TodoRefused("conflict");
      const at = clock.now();
      addTodo.run(id, input.title, input.notes, input.list, input.date, input.time, at, at, sourceTopic);
      changed();
      return item(id);
    },
    edit(id: string, { done, ...patch }: TodoEdit): Todo {
      const current = item(id);
      const input = fields({ title: current.title, notes: current.notes, list: current.list, date: current.date, time: current.time, ...patch }, current.list);
      const at = clock.now();
      const doneAt = done === undefined ? current.doneAt : done ? current.doneAt ?? at : null;
      if (doneAt === current.doneAt && Object.entries(input).every(([key, value]) => current[key as keyof TodoFields] === value)) return current;
      editTodo.run(input.title, input.notes, input.list, input.date, input.time, doneAt, at, id);
      changed();
      return item(id);
    },
    remove(id: string): void {
      if (deleteTodo.run(clock.now(), id).changes !== 0) changed();
      else if (hasTodo.get(id) === undefined) throw new TodoRefused("not_found");
    },
    reorder: ordering("todos", "deleted = 0 AND done_at IS NULL"),
    addList(name: string): TodoList {
      const id = randomUUID();
      validateName(name, id);
      addList.run(id, name, clock.now());
      changed();
      return list(id);
    },
    editList(id: string, patch: TodoListEdit): TodoList {
      const current = list(id);
      const { name, archived } = { ...current, ...patch };
      if (name === current.name && archived === current.archived) return current;
      validateName(name, id);
      editList.run(name, Number(archived), clock.now(), id);
      changed();
      return list(id);
    },
    reorderList: ordering("todo_lists", "archived = 0"),
    handoff(id: string): string {
      const todo = item(id);
      if (todo.topic !== null) return conversations.get(todo.topic)?.id ?? todo.topic;
      const message = [
        todo.title,
        text("todo.handoff.list", { list: todo.list === null ? text("todo.view.inbox") : list(todo.list).name }),
        ...(todo.date === null ? [] : [text("todo.handoff.date", { date: todo.time === null ? todo.date : `${todo.date} ${todo.time}` })]),
        ...(todo.notes.trim() === "" ? [] : [text("todo.handoff.notes", { notes: todo.notes })]),
      ].join("\n\n");
      const { topic } = conversations.sendToNewDailyTopic(message, (topic) => { linkTodo.run(topic, clock.now(), id); });
      changed();
      return topic.id;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
