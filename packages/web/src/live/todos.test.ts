import { todoDay, type Todo } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { quickTodo, todosFor } from "./todos.js";

const now = Date.parse("2026-11-28T01:00:00Z");
const today = "2026-11-27";
const base: Todo = {
  id: "id", title: "Task", notes: "", list: null, position: 0, date: null, time: null, doneAt: null, createdAt: 0, updatedAt: 0, topic: null,
};
const tasks: Todo[] = [
  { ...base, id: "overdue", date: "2026-11-24", position: 1, list: "garden" },
  { ...base, id: "today", date: today, position: 0 },
  { ...base, id: "inbox", position: 2 },
  { ...base, id: "later", date: "2026-11-29", position: 3, list: "garden" },
  { ...base, id: "tomorrow", date: "2026-11-28", position: 4 },
  { ...base, id: "done", doneAt: 2, date: today, position: 5, list: "garden" },
  { ...base, id: "old", doneAt: 1, position: 6 },
];

describe("to-do views", () => {
  it("uses the hub's day even when the browser is already on tomorrow", () => {
    expect(todoDay(now, "America/New_York")).toBe(today);
    expect(todoDay(now, "UTC")).toBe("2026-11-28");
  });

  it("shows due and overdue open work in manual order", () => {
    expect(todosFor(tasks, "today", today)[0]?.todos.map(({ id }) => id)).toEqual(["today", "overdue"]);
  });

  it("groups future work by day and excludes completions", () => {
    expect(todosFor(tasks, "planned", today).map(({ date, todos }) => [date, todos.map(({ id }) => id)])).toEqual([
      ["2026-11-28", ["tomorrow"]], ["2026-11-29", ["later"]],
    ]);
  });

  it("shows open inbox and list tasks and orders completions newest first", () => {
    expect(todosFor(tasks, "inbox", today)[0]?.todos.map(({ id }) => id)).toEqual(["today", "inbox", "tomorrow"]);
    expect(todosFor(tasks, { list: "garden" }, today)[0]?.todos.map(({ id }) => id)).toEqual(["overdue", "later"]);
    expect(todosFor(tasks, "completed", today)[0]?.todos.map(({ id }) => id)).toEqual(["done", "old"]);
  });

  it("applies quick-add dates and lists without parsing the title", () => {
    expect(quickTodo("  Buy milk tomorrow  ", "today", today)).toMatchObject({ title: "Buy milk tomorrow", date: today, list: null });
    expect(quickTodo("Check", "planned", "2026-12-31").date).toBe("2027-01-01");
    expect(quickTodo("Weed", { list: "garden" }, today)).toMatchObject({ date: null, list: "garden" });
    expect(quickTodo("New", "completed", today)).toMatchObject({ date: null, list: null });
  });
});
