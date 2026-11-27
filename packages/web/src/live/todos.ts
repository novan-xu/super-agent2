import { nextTodoDay, type Todo, type TodoFields, type TodoView } from "@super-agent2/protocol";

export function quickTodo(title: string, view: TodoView, today: string): TodoFields {
  return {
    title: title.trim(), notes: "", list: typeof view === "string" ? null : view.list,
    date: view === "today" ? today : view === "planned" ? nextTodoDay(today) : null,
    time: null,
  };
}

export interface TodoGroup {
  readonly date: string | null;
  readonly todos: readonly Todo[];
}

export function todosFor(todos: readonly Todo[], view: TodoView, today: string): TodoGroup[] {
  if (view === "completed") {
    return [{ date: null, todos: todos.filter((todo) => todo.doneAt !== null).sort((left, right) => right.doneAt! - left.doneAt!) }];
  }
  const open = todos.filter((todo) => todo.doneAt === null).sort((left, right) => left.position - right.position);
  if (view === "planned") {
    const dates = new Map<string, Todo[]>();
    for (const todo of open) {
      if (todo.date === null || todo.date <= today) continue;
      const group = dates.get(todo.date) ?? [];
      group.push(todo);
      dates.set(todo.date, group);
    }
    return [...dates.keys()].sort().map((date) => ({ date, todos: dates.get(date)! }));
  }
  const visible = view === "today" ? open.filter((todo) => todo.date !== null && todo.date <= today)
    : open.filter((todo) => todo.list === (view === "inbox" ? null : view.list));
  return [{ date: null, todos: visible }];
}
