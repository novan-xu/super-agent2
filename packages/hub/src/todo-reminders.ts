import { text } from "@super-agent2/catalog";
import { pagePath, type PushPayload, todoDay, type TodoReminderSettings } from "@super-agent2/protocol";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import type { PushService } from "./push-service.js";
import { intervalTicker, type Ticker } from "./verification.js";

const hour = 3_600_000;
const catchUp = 3 * hour;
const TimedRow = z.object({ id: z.string(), title: z.string(), date: z.string(), time: z.string() });
const SummaryRow = z.object({ title: z.string(), total: z.number().int().positive() });

function reminderTime(date: string, time: string, tz: string): number {
  const [, month, day] = date.split("-");
  const [hours, minutes] = time.split(":");
  const currentDate = new Date(Date.parse(date + "T00:00:00Z") - 36 * hour);
  return CronExpressionParser.parse(`${minutes} ${hours} ${day} ${month} *`, { currentDate, tz }).next().getTime();
}

function clipped(title: string, limit: number): string {
  const characters = [...title.replace(/\s+/gu, " ").trim()];
  return characters.length <= limit ? characters.join("") : characters.slice(0, limit - 1).join("") + "…";
}

export function createTodoReminders({ database, clock, push, settings, ticker, report }: {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly push: Pick<PushService, "hasSubscribers" | "todo">;
  readonly settings: () => TodoReminderSettings;
  readonly ticker?: Ticker | undefined;
  readonly report: (line: string) => void;
}) {
  const { connection, ticketTimeZone: timeZone } = database;
  const timed = connection.prepare(`SELECT id, title, date, time FROM todos
    WHERE deleted = 0 AND done_at IS NULL AND date BETWEEN ? AND ? AND time IS NOT NULL ORDER BY date, time, id`);
  const summary = connection.prepare(`SELECT title, count(*) OVER () AS total FROM todos
    WHERE deleted = 0 AND done_at IS NULL AND date <= ? AND time IS NULL ORDER BY date, position, id LIMIT 3`);
  const claimed = connection.prepare("SELECT 1 FROM todo_reminder_slots WHERE key = ?");
  const claim = connection.prepare("INSERT OR IGNORE INTO todo_reminder_slots (key, due_at) VALUES (?, ?)");
  const pending = new Set<Promise<void>>();
  let closed = false;

  const send = (key: string, due: number, payload: PushPayload) => {
    if (claim.run(key, due).changes === 0) return;
    const work = push.todo(payload)
      .catch((error: unknown) => report(`Sending a to-do reminder failed: ${String(error)}`))
      .finally(() => pending.delete(work));
    pending.add(work);
  };

  const poll = () => {
    if (closed) return;
    try {
      const preference = settings();
      if (!preference.enabled || !push.hasSubscribers()) return;
      const now = clock.now();
      const today = todoDay(now, timeZone);
      const earliest = todoDay(now - catchUp, timeZone);
      const eligible = (due: number) => due <= now && due > now - catchUp;
      for (const row of timed.all(earliest, today)) {
        const task = TimedRow.parse(row);
        const key = `timed:${task.id}:${task.date}T${task.time}`;
        if (claimed.get(key) !== undefined) continue;
        const due = reminderTime(task.date, task.time, timeZone);
        if (!eligible(due)) continue;
        send(key, due, {
          title: text("todo.push.timed"), body: clipped(task.title, 160),
          url: pagePath({ view: "todos", todo: task.id }), tag: `todo:${task.id}`,
        });
      }

      const key = `summary:${today}`;
      if (claimed.get(key) !== undefined) return;
      const due = reminderTime(today, preference.summaryTime, timeZone);
      if (!eligible(due)) return;
      const rows = summary.all(today).map((row) => SummaryRow.parse(row));
      const first = rows[0];
      if (first === undefined) {
        claim.run(key, due);
        return;
      }
      send(key, due, {
        title: text("navigation.todos"),
        body: text("todo.push.summary", { count: first.total, titles: rows.map(({ title }) => clipped(title, 64)).join("、") }),
        url: pagePath({ view: "todos" }), tag: `todo:${today}`,
      });
    } catch (error) {
      report(`Checking to-do reminders failed: ${String(error)}`);
    }
  };

  const stop = (ticker ?? intervalTicker(5_000))(poll);
  poll();
  return {
    close: async () => {
      closed = true;
      stop();
      await Promise.all([...pending]);
    },
  };
}
