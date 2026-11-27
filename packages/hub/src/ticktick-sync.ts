import { createHash, randomUUID } from "node:crypto";
import { TickTickSyncStatus, TodoFields, type TickTickSyncEvent } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { tickTickInbox, type TickTickFields, type TickTickGateway, type TickTickProject, type TickTickTask } from "./ticktick-gateway.js";
import type { SyncTodo, Todos } from "./todos.js";
import { intervalTicker, type Ticker } from "./verification.js";

const pollMilliseconds = 120_000;
const firstRetry = 15_000;
const maximumRetry = 300_000;
const pagePollMinimum = 15_000;
const State = z.object({ account: z.string().nullable(), last_sync: z.number().nullable(), failures: z.number(), retry_at: z.number() });
const Link = z.object({ task: z.string(), todo: z.string(), project: z.string(), local_hash: z.string(), remote_hash: z.string().nullable(), needs_push: z.literal([0, 1]) });
type Link = z.infer<typeof Link>;
const ProjectLink = z.object({ project: z.string(), list: z.string() });

function taskId(todo: string) {
  return createHash("sha256").update("super-agent2-ticktick:" + todo).digest("hex").slice(0, 24);
}

const folded = (name: string) => name.trim().normalize("NFC").toLowerCase();
const hashFields = (fields: readonly unknown[]) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

function localHash(todo: SyncTodo): string {
  return todo.deleted ? "deleted" : hashFields([todo.title, todo.notes, todo.list, todo.date, todo.time, todo.doneAt !== null]);
}

function remoteHash(task: TickTickFields | null): string | null {
  return task === null ? null : hashFields([task.title, task.notes, task.project, task.date, task.time, task.done]);
}

function usable(project: TickTickProject) {
  return project.id === tickTickInbox || (project.closed !== true && project.kind !== "NOTE" && project.permission !== "read" && project.permission !== "comment");
}

export type TickTickSync = ReturnType<typeof createTickTickSync>;

export function createTickTickSync({ database, clock, gateway, todos, ticker, changed }: {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly gateway: TickTickGateway;
  readonly todos: Todos;
  readonly ticker?: Ticker | undefined;
  readonly changed: () => void;
}) {
  const db = database.connection;
  const readState = db.prepare("SELECT account, last_sync, failures, retry_at FROM ticktick_sync_state WHERE id = 1");
  const setAccount = db.prepare("UPDATE ticktick_sync_state SET account = ?, last_sync = CASE WHEN account IS ? THEN last_sync ELSE NULL END, failures = 0, retry_at = 0 WHERE id = 1");
  const success = db.prepare("UPDATE ticktick_sync_state SET last_sync = ?, failures = 0, retry_at = 0 WHERE id = 1");
  const failure = db.prepare("UPDATE ticktick_sync_state SET failures = ?, retry_at = ? WHERE id = 1");
  const taskLinks = db.prepare("SELECT * FROM ticktick_sync_tasks WHERE account = ?");
  const linkedTodo = db.prepare("SELECT 1 FROM ticktick_sync_tasks WHERE account = ? AND todo = ?");
  const saveTask = db.prepare(`INSERT INTO ticktick_sync_tasks (account, task, todo, project, local_hash, remote_hash, remote_modified_at, needs_push)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, todo) DO UPDATE SET task = excluded.task, project = excluded.project,
    local_hash = excluded.local_hash, remote_hash = excluded.remote_hash, remote_modified_at = excluded.remote_modified_at, needs_push = excluded.needs_push`);
  const projectLinks = db.prepare("SELECT project, list FROM ticktick_sync_projects WHERE account = ?");
  const saveProject = db.prepare("INSERT INTO ticktick_sync_projects (account, project, list) VALUES (?, ?, ?)");
  const logRow = db.prepare("INSERT INTO ticktick_sync_log (at, event, count) VALUES (?, ?, ?)");
  const trimLog = db.prepare("DELETE FROM ticktick_sync_log WHERE id NOT IN (SELECT id FROM ticktick_sync_log ORDER BY id DESC LIMIT 12)");
  const logRows = db.prepare("SELECT at, event, count FROM ticktick_sync_log ORDER BY id DESC");
  const state = () => State.parse(readState.get());
  const log = (event: TickTickSyncEvent, count: number) => {
    logRow.run(clock.now(), event, count);
    trimLog.run();
  };

  let pending: Promise<void> | undefined;
  let requested = true;
  let applying = false;
  let closed = false;
  let generation = 0;
  let lastStart = -Infinity;

  const reconcile = async (account: string, authorized: () => boolean) => {
    const session = gateway.session(account, authorized);
    const check = () => { if (!authorized()) throw new Error("TickTick sync authorization changed"); };
    const projects = new Map((await session.projects()).filter(usable).map((project) => [project.id, project]));
    if (!projects.has(tickTickInbox)) throw new Error("TickTick Inbox is unavailable");
    const byProject = new Map(projectLinks.all(account).map((row) => {
      const { project, list } = ProjectLink.parse(row);
      return [project, list] as const;
    }));
    const byList = new Map([...byProject].map(([project, list]) => [list, project]));
    const lists = new Map(todos.lists().map((list) => [list.id, list]));
    const bind = (project: string, list: string) => {
      saveProject.run(account, project, list);
      byProject.set(project, list);
      byList.set(list, project);
    };
    const listFor = (project: TickTickProject) => {
      const match = [...lists.values()].find((list) => !byList.has(list.id) && folded(list.name) === folded(project.name));
      if (match !== undefined) return match;
      const usedNames = new Set([...lists.values()].map(({ name }) => folded(name)));
      const base = project.name.trim().slice(0, 68) || "TickTick";
      let name = base;
      for (let index = 2; usedNames.has(folded(name)); index++) name = `${base} (${index})`;
      const list = todos.addList(name);
      lists.set(list.id, list);
      return list;
    };
    check();
    for (const project of projects.values()) {
      if (project.id !== tickTickInbox && !byProject.has(project.id)) bind(project.id, listFor(project).id);
    }

    const indexed = new Map<string, TickTickTask>();
    for (const project of projects.keys()) {
      for (const task of await session.open(project)) indexed.set(task.id, task);
    }
    const links = taskLinks.all(account).map((row) => Link.parse(row));
    const linkedTasks = new Set(links.map(({ task }) => task));
    const linkedTodos = new Set(links.map(({ todo }) => todo));
    let count = 0;
    let repeating = 0;
    let skipped = 0;

    const record = (local: SyncTodo, remote: TickTickTask | null, id: string, project: string) => {
      saveTask.run(account, remote?.id ?? id, local.id, remote?.project ?? project,
        localHash(local), remoteHash(remote), remote?.modifiedAt ?? null, 0);
    };
    const fromTickTick = (local: SyncTodo | undefined, remote: TickTickTask, input: TodoFields) => {
      check();
      const id = local?.id ?? randomUUID();
      applying = true;
      db.exec("BEGIN IMMEDIATE");
      try {
        todos.applySync(id, input, remote.done);
        record(todos.syncOne(id)!, remote, remote.id, remote.project);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        applying = false;
      }
      count++;
      if (local === undefined && remote.repeating) repeating++;
    };

    const inputOf = (task: TickTickTask): TodoFields | undefined => {
      if (task.note || !projects.has(task.project)) return undefined;
      const list = task.project === tickTickInbox ? null : byProject.get(task.project);
      const parsed = TodoFields.safeParse({ title: task.title, notes: task.notes, list, date: task.date, time: task.time });
      return parsed.success ? parsed.data : undefined;
    };
    const projectFor = async (todo: SyncTodo) => {
      if (todo.list === null) return tickTickInbox;
      const mapped = byList.get(todo.list);
      if (mapped !== undefined) return projects.has(mapped) ? mapped : undefined;
      const list = todos.lists().find(({ id }) => id === todo.list);
      if (list === undefined || list.archived) return undefined;
      check();
      const project = await session.createProject(list.name);
      check();
      projects.set(project.id, project);
      bind(project.id, list.id);
      return project.id;
    };
    const pushTask = async (local: SyncTodo, task: TickTickTask | null, link?: Link) => {
      const project = local.deleted ? task?.project : await projectFor(local);
      check();
      const current = todos.syncOne(local.id);
      if (current === undefined || localHash(current) !== localHash(local)) return;
      if (local.deleted) {
        if (task !== null) {
          await session.remove(task);
          check();
          count++;
        }
        if (link !== undefined) record(local, null, link.task, link.project);
        return;
      }
      if (project === undefined) { skipped++; return; }
      const fields: TickTickFields = { project, title: local.title, notes: local.notes, date: local.date, time: local.time, done: local.doneAt !== null };
      const id = link?.task ?? taskId(local.id);
      if (task === null && link === undefined) saveTask.run(account, id, local.id, project, "", null, null, 0);
      const updated = task === null ? await session.create(id, fields) : await session.update(task, fields, (intermediate) => {
        check();
        if (link !== undefined) {
          saveTask.run(account, id, local.id, intermediate.project, link.local_hash, remoteHash(intermediate), intermediate.modifiedAt, 1);
        }
      });
      check();
      if (remoteHash(updated) !== remoteHash(fields)) throw new Error("TickTick returned different task fields");
      record(local, updated, id, project);
      count++;
    };

    for (const link of links) {
      check();
      let remote = indexed.get(link.task) ?? null;
      if (remote === null && !projects.has(link.project)) { skipped++; continue; }
      if (remote === null && (link.remote_hash !== null || link.local_hash === "")) remote = await session.task(link.task);
      check();
      const local = todos.syncOne(link.todo);
      if (local === undefined) continue;
      const input = remote === null ? undefined : inputOf(remote);
      if (remote !== null && input === undefined) { skipped++; continue; }
      const here = localHash(local);
      const there = remoteHash(remote);
      if (link.local_hash === "" && remote !== null) {
        const expectedList = local.list === null ? tickTickInbox : byList.get(local.list);
        if (!local.deleted && expectedList === remote.project && local.title === remote.title && local.notes === remote.notes
          && local.date === remote.date && local.time === remote.time && (local.doneAt !== null) === remote.done) {
          record(local, remote, link.task, link.project);
        } else if (local.deleted || local.updatedAt > (remote.modifiedAt ?? clock.now())) {
          await pushTask(local, remote, link);
        } else {
          fromTickTick(local, remote, input!);
        }
        continue;
      }
      const localChanged = here !== link.local_hash || link.needs_push === 1;
      const remoteChanged = there !== link.remote_hash;
      if (!localChanged && !remoteChanged) continue;
      if (localChanged && (!remoteChanged || local.updatedAt > (remote?.modifiedAt ?? clock.now()))) {
        await pushTask(local, remote, link);
      } else if (remote !== null) {
        fromTickTick(local, remote, input!);
      } else {
        applying = true;
        db.exec("BEGIN IMMEDIATE");
        try {
          todos.remove(local.id);
          record(todos.syncOne(local.id)!, null, link.task, link.project);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          applying = false;
        }
        if (!local.deleted) count++;
      }
    }

    for (const remote of indexed.values()) {
      if (linkedTasks.has(remote.id) || remote.done) continue;
      const input = inputOf(remote);
      if (input === undefined) { skipped++; continue; }
      fromTickTick(undefined, remote, input);
    }
    for (const local of todos.syncRows()) {
      if (!local.deleted && !linkedTodos.has(local.id) && linkedTodo.get(account, local.id) === undefined) await pushTask(local, null);
    }
    return { count, repeating, skipped };
  };

  const poll = () => {
    if (closed || pending !== undefined) return;
    const at = clock.now();
    const saved = state();
    const account = saved.account;
    if (account === null || saved.retry_at > at || (!requested && at - lastStart < pollMilliseconds)) return;
    if (gateway.account() !== account) return;
    requested = false;
    lastStart = at;
    const started = generation;
    const current = () => !closed && generation === started && state().account === account;
    const authorized = () => current() && gateway.account() === account;
    pending = reconcile(account, authorized).then(({ count, repeating, skipped }) => {
      if (!current()) return;
      success.run(clock.now());
      if (count !== 0 || saved.last_sync === null) log("synced", count);
      if (repeating !== 0) log("repeating", repeating);
      if (skipped !== 0) log("skipped", skipped);
    }).catch(() => {
      if (!current()) return;
      const attempts = saved.failures + 1;
      failure.run(attempts, clock.now() + Math.min(maximumRetry, firstRetry * 2 ** Math.min(saved.failures, 5)));
      log("retry", attempts);
      requested = true;
    }).finally(() => {
      pending = undefined;
      if (!closed) changed();
    });
    changed();
  };
  const unsubscribe = todos.subscribe(() => { if (!applying) requested = true; });
  const stop = (ticker ?? intervalTicker(5_000))(poll);

  return {
    status(): TickTickSyncStatus | undefined {
      if (!gateway.connected()) return undefined;
      const saved = state();
      const account = gateway.account();
      return {
        enabled: saved.account !== null,
        state: account === undefined ? "unavailable" : saved.account === null ? "off"
          : account !== saved.account ? "reconnect" : pending !== undefined ? "syncing"
          : saved.failures > 0 ? "retry" : "ready",
        lastSync: saved.last_sync,
        log: TickTickSyncStatus.shape.log.parse(logRows.all()),
      };
    },
    setEnabled(enabled: boolean): boolean {
      const account = enabled ? gateway.account() : null;
      if (account === undefined) return false;
      if (state().account === account) return true;
      generation++;
      setAccount.run(account, account);
      requested = true;
      poll();
      changed();
      return true;
    },
    pageOpened() {
      if (clock.now() - lastStart >= pagePollMinimum) { requested = true; poll(); }
    },
    poll,
    idle: async () => { await pending; },
    close: async () => {
      closed = true;
      stop();
      unsubscribe();
      await pending;
    },
  };
}
