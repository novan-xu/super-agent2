import { text } from "@super-agent2/catalog";
import { nextTodoDay, todoDay, todoViews, type PageRoute, type Todo, type TodoChanged, type TodoEdit, type TodoFields, type TodoList, type TodoReorder, type TodoSnapshot, type TodoView } from "@super-agent2/protocol";
import { type FormEvent, type PointerEvent, useEffect, useReducer, useRef, useState } from "react";
import { type Answer, todoApi } from "../hub/api.js";
import { quickTodo, todosFor } from "../live/todos.js";
import { pagePath } from "../parts/app-path.js";
import { Icon, type IconName } from "../parts/icons.js";
import type { Navigate } from "../parts/route.js";
import { followLink } from "../parts/Shell.js";

const viewIcons: Readonly<Record<typeof todoViews[number], IconName>> = {
  today: "sun",
  planned: "calendar",
  inbox: "inbox",
  completed: "check",
};

const dateLabel = (date: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC", year: "numeric", month: "short", day: "numeric", weekday: "short",
}).format(new Date(date + "T00:00:00Z"));

const read = (form: FormData, key: string) => String(form.get(key) ?? "");

type Apply = <T>(run: () => Promise<Answer<T>>) => Promise<T | undefined>;
type Move = (id: string, placement: TodoReorder) => void;

function OrderButtons({ before, after, move, disabled }: {
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly move: (placement: TodoReorder) => void;
  readonly disabled: boolean;
}) {
  return <div className="todo-order-buttons">
    <button className="btn btn-sm" type="button" disabled={disabled || before === undefined} onClick={() => {
      if (before !== undefined) move({ anchor: before, side: "before" });
    }}><Icon name="up" size={14} />{text("todo.moveUp")}</button>
    <button className="btn btn-sm" type="button" disabled={disabled || after === undefined} onClick={() => {
      if (after !== undefined) move({ anchor: after, side: "after" });
    }}><Icon name="down" size={14} />{text("todo.moveDown")}</button>
  </div>;
}

function TodoEditor({ todo, lists, today, busy, save, cancel, remove, before, after, move }: {
  readonly todo: Todo;
  readonly lists: readonly TodoList[];
  readonly today: string;
  readonly busy: boolean;
  readonly save: (patch: TodoEdit) => void;
  readonly cancel: () => void;
  readonly remove: () => void;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly move: (placement: TodoReorder) => void;
}) {
  const [date, setDate] = useState(todo.date ?? "");
  const [time, setTime] = useState(todo.time ?? "");
  const [original] = useState(todo);
  const tomorrow = nextTodoDay(today);
  const chooseDate = (value: string) => {
    setDate(value);
    if (value === "") setTime("");
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields: TodoFields = {
      title: read(form, "title").trim(), notes: read(form, "notes"), list: read(form, "list") || null,
      date: date || null, time: date === "" ? null : time || null,
    };
    if (fields.title === "") return;
    save(Object.fromEntries(Object.entries(fields).filter(([key, value]) => original[key as keyof TodoFields] !== value)));
  };
  return <form className="todo-editor" onSubmit={submit}>
    <label>{text("todo.title")}<input className="field" name="title" defaultValue={original.title} required maxLength={240} autoFocus /></label>
    <label>{text("todo.notes")}<textarea className="field" name="notes" rows={3} defaultValue={original.notes} maxLength={8000} /></label>
    <label>{text("todo.lists")}<select className="field" name="list" defaultValue={original.list ?? ""}>
      <option value="">{text("todo.view.inbox")}</option>
      {lists.filter((list) => !list.archived || list.id === original.list).map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}
    </select></label>
    <div className="todo-date-fields">
      <label>{text("todo.date")}<input className="field" type="date" value={date} onChange={(event) => chooseDate(event.target.value)} /></label>
      <label>{text("todo.time")}<input className="field" type="time" value={time} disabled={date === ""} onChange={(event) => setTime(event.target.value)} /></label>
    </div>
    <div className="todo-date-choices">
      <button className="btn btn-sm" type="button" aria-pressed={date === today} onClick={() => chooseDate(today)}>{text("todo.view.today")}</button>
      <button className="btn btn-sm" type="button" aria-pressed={date === tomorrow} onClick={() => chooseDate(tomorrow)}>{text("todo.tomorrow")}</button>
      <button className="btn btn-sm" type="button" disabled={date === ""} onClick={() => chooseDate("")}>{text("todo.clearDate")}</button>
    </div>
    {before === undefined && after === undefined ? null : <OrderButtons before={before} after={after} move={move} disabled={busy} />}
    <div className="todo-editor-actions">
      <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={remove}>{text("todo.delete")}</button>
      <div className="todo-date-choices">
        <button className="btn btn-sm" type="button" onClick={cancel}>{text("todo.cancel")}</button>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{text("todo.save")}</button>
      </div>
    </div>
  </form>;
}

function TodoRows({ rows, lists, today, groupDate, busy, editing, setEditing, apply, navigate, topicRoute }: {
  readonly rows: readonly Todo[];
  readonly lists: readonly TodoList[];
  readonly today: string;
  readonly groupDate: string | null;
  readonly busy: boolean;
  readonly editing: string | null;
  readonly setEditing: (id: string | null) => void;
  readonly apply: Apply;
  readonly navigate: Navigate;
  readonly topicRoute: (id: string) => PageRoute;
}) {
  const [drop, setDrop] = useState<TodoReorder | null>(null);
  const dragged = useRef<string | null>(null);
  const dropped = useRef(false);
  const group = useRef<HTMLUListElement>(null);
  const move: Move = (id, placement) => { void apply(() => todoApi.reorder(id, placement)); };
  const targetOf = (event: PointerEvent<HTMLButtonElement>): TodoReorder | null => {
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-todo-id]");
    const anchor = row?.dataset["todoId"];
    if (row === undefined || row === null || anchor === undefined || anchor === dragged.current || row.parentElement !== group.current) return null;
    const bounds = row.getBoundingClientRect();
    return { anchor, side: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" };
  };
  const clear = () => {
    dragged.current = null;
    setDrop(null);
  };
  return <ul className="todo-rows mem-list" ref={group}>
    {rows.map((todo, index) => {
      const done = todo.doneAt !== null;
      const list = lists.find(({ id }) => id === todo.list);
      const openTopic = async () => {
        const result = await apply(() => todoApi.handoff(todo.id));
        if (result !== undefined) navigate(topicRoute(result.topic));
      };
      return <li className="todo-row" key={todo.id} data-todo-id={todo.id} data-drop={drop?.anchor === todo.id ? drop.side : undefined}>
        <div className="todo-row-main">
          <button className="todo-check" type="button" aria-label={text(done ? "todo.undo" : "todo.done")} title={text(done ? "todo.undo" : "todo.done")}
            disabled={busy} onClick={() => void apply(() => todoApi.edit(todo.id, { done: !done }))}>
            <span className="icon-btn todo-check-mark" aria-hidden="true">{done ? <Icon name="check" size={16} /> : null}</span>
          </button>
          <div className="todo-copy">
            <button className="todo-title" type="button" aria-expanded={editing === todo.id} title={text("todo.edit")} onClick={() => setEditing(editing === todo.id ? null : todo.id)}>{todo.title}</button>
            {todo.notes === "" ? null : <p className="todo-preview">{todo.notes}</p>}
            <div className="todo-meta">
              {!done && todo.date !== null && todo.date < today ? <span className="chip chip--warn">{text("todo.overdue")}</span> : null}
              {todo.date !== null && todo.date !== groupDate ? <span>{dateLabel(todo.date)}</span> : null}
              {todo.time === null ? null : <time>{todo.time}</time>}
              {list === undefined ? null : <span className="todo-list-label"><Icon name="folder" size={14} />{list.name}</span>}
            </div>
          </div>
          {rows.length < 2 || done ? null : <button className="icon-btn todo-grip" type="button" title={text("todo.reorder")} aria-label={text("todo.reorder")} disabled={busy}
            onClick={(event) => { if (event.detail === 0 || !dropped.current) setEditing(todo.id); }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              dropped.current = false;
              dragged.current = todo.id;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => { if (dragged.current === todo.id) setDrop(targetOf(event)); }}
            onPointerUp={(event) => {
              if (dragged.current !== todo.id) return;
              const target = targetOf(event);
              clear();
              if (target !== null) {
                dropped.current = true;
                move(todo.id, target);
              }
            }}
            onLostPointerCapture={clear}
            onPointerCancel={clear}><Icon name="grip" size={18} /></button>}
        </div>
        <div className="todo-topic">
          {todo.topic === null
            ? <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void openTopic()}><Icon name="hub" size={15} />{text("todo.handoff")}</button>
            : <a className="btn btn-sm" href={pagePath(topicRoute(todo.topic))} onClick={(event) => followLink(event, () => navigate(topicRoute(todo.topic!)))}><Icon name="chat" size={15} />{text("todo.openTopic")}</a>}
          {todo.sourceTopic == null ? null : <a className="btn btn-sm todo-source-topic" href={pagePath(topicRoute(todo.sourceTopic))}
            onClick={(event) => followLink(event, () => navigate(topicRoute(todo.sourceTopic!)))}><Icon name="chat" size={15} />{text("todo.sourceTopic")}</a>}
        </div>
        {editing !== todo.id ? null : <TodoEditor todo={todo} lists={lists} today={today} busy={busy}
          before={done ? undefined : rows[index - 1]?.id} after={done ? undefined : rows[index + 1]?.id}
          move={(placement) => move(todo.id, placement)}
          save={(patch) => { void apply(() => todoApi.edit(todo.id, patch)).then((saved) => { if (saved !== undefined) setEditing(null); }); }}
          cancel={() => setEditing(null)}
          remove={() => { void apply(() => todoApi.remove(todo.id)).then((removed) => { if (removed !== undefined) setEditing(null); }); }} />}
      </li>;
    })}
  </ul>;
}

function ListManager({ lists, busy, error, apply, dialogRef, close }: {
  readonly lists: readonly TodoList[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly apply: Apply;
  readonly dialogRef: React.RefObject<HTMLDialogElement | null>;
  readonly close: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const active = lists.filter((list) => !list.archived);
  const archived = lists.filter((list) => list.archived);
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = read(new FormData(form), "name").trim();
    if (name !== "") void apply(() => todoApi.addList(name)).then((list) => { if (list !== undefined) form.reset(); });
  };
  const rename = (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault();
    const name = read(new FormData(event.currentTarget), "name").trim();
    if (name !== "") void apply(() => todoApi.editList(id, { name })).then((list) => { if (list !== undefined) setRenaming(null); });
  };
  return <dialog className="dlg todo-dialog" aria-labelledby="todo-lists-title" ref={dialogRef} onClose={() => { setRenaming(null); close(); }}>
    <header className="todo-dialog-head">
      <h2 id="todo-lists-title">{text("todo.manageLists")}</h2>
      <button className="icon-btn" type="button" aria-label={text("todo.cancel")} onClick={() => dialogRef.current?.close()}><Icon name="x" /></button>
    </header>
    <form className="todo-quick" onSubmit={add}>
      <input className="field" name="name" aria-label={text("todo.listName")} placeholder={text("todo.listName")} maxLength={80} required />
      <button className="btn btn-primary" type="submit" disabled={busy}>{text("todo.addList")}</button>
    </form>
    {error === null ? null : <p className="todo-error" role="alert">{error}</p>}
    <ul className="todo-managed-lists">
      {active.map((list, index) => <li key={list.id}>
        {renaming === list.id ? <form className="todo-rename" onSubmit={(event) => rename(event, list.id)}>
          <input className="field" name="name" aria-label={text("todo.listName")} defaultValue={list.name} maxLength={80} required autoFocus />
          <button className="btn btn-sm" type="submit" disabled={busy}>{text("todo.save")}</button>
          <button className="btn btn-sm" type="button" onClick={() => setRenaming(null)}>{text("todo.cancel")}</button>
        </form> : <>
          <strong>{list.name}</strong>
          <div className="todo-list-actions">
            <OrderButtons before={active[index - 1]?.id} after={active[index + 1]?.id} disabled={busy}
              move={(placement) => void apply(() => todoApi.reorderList(list.id, placement))} />
            <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setRenaming(list.id)}>{text("todo.renameList")}</button>
            <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void apply(() => todoApi.editList(list.id, { archived: true }))}>{text("todo.archiveList")}</button>
          </div>
        </>}
      </li>)}
    </ul>
    {archived.length === 0 ? null : <section>
      <h3>{text("todo.archivedLists")}</h3>
      <ul className="todo-managed-lists">{archived.map((list) => <li key={list.id}>
        <strong>{list.name}</strong>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void apply(() => todoApi.editList(list.id, { archived: false }))}>{text("todo.restoreList")}</button>
      </li>)}</ul>
    </section>}
  </dialog>;
}

export function TodosView({ selection, focused, navigate, topicRoute, online, update, now }: {
  readonly selection: TodoView;
  readonly focused: string | undefined;
  readonly navigate: Navigate;
  readonly topicRoute: (id: string) => PageRoute;
  readonly online: boolean;
  readonly update: TodoChanged | undefined;
  readonly now: number;
}) {
  const [data, setData] = useState<TodoSnapshot | null>(null);
  const [loadedFocus, setLoadedFocus] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, refresh] = useReducer((version: number) => version + 1, 0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const inFlight = useRef(false);
  const draft = useRef<{ key: string; id: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const request = new AbortController();
    void todoApi.snapshot(request.signal, focused).then((answer) => {
      if (request.signal.aborted) return;
      if (answer.ok) {
        setData(answer.value);
        setLoadedFocus(focused);
        setLoadFailed(false);
      } else setLoadFailed(true);
    });
    return () => request.abort();
  }, [focused, online, update, reload]);

  const apply: Apply = async (run) => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const answer = await run();
      if (!answer.ok) {
        setError(text(answer.error === "conflict" ? "todo.conflict" : "todo.saveFailed"));
        return undefined;
      }
      return answer.value;
    } finally {
      refresh();
      inFlight.current = false;
      setBusy(false);
    }
  };

  const lists = data?.lists ?? [];
  const active = lists.filter((list) => !list.archived);
  const selectedList = typeof selection === "string" ? undefined : active.find((list) => list.id === selection.list);
  const today = data === null ? "" : todoDay(now, data.timeZone);
  const selected = focused === undefined ? undefined : data?.selected?.id === focused ? data.selected : data?.todos.find(({ id }) => id === focused);
  const groups = selected !== undefined ? [{ date: null, todos: [selected] }]
    : data === null || focused !== undefined ? [] : todosFor(data.todos, selection, today);
  const loading = data === null || (focused !== undefined && selected === undefined && loadedFocus !== focused);
  const available = typeof selection === "string" || selectedList !== undefined;
  const choose = (view: TodoView) => {
    setEditing(null);
    setError(null);
    navigate({ view: "todos", selection: view });
  };
  const link = (view: TodoView, current: boolean) => ({
    href: pagePath({ view: "todos", selection: view }),
    onClick: (event: React.MouseEvent) => followLink(event, () => choose(view)),
    "aria-current": current ? "page" as const : undefined,
  });
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = read(new FormData(form), "title").trim();
    if (!available || title === "" || today === "") return;
    const fields = quickTodo(title, selection, today);
    const key = JSON.stringify(fields);
    const id = draft.current?.key === key ? draft.current.id : crypto.randomUUID();
    draft.current = { key, id };
    void apply(() => todoApi.add({ ...fields, id })).then((added) => {
      if (added === undefined) return;
      draft.current = null;
      form.reset();
      if (selection === "completed") choose("inbox");
    });
  };
  return <div className="page todos-page">
    <div className="todo-layout">
      <aside className="todo-sidebar">
        <nav className="todo-views" aria-label={text("todo.views")}>
          {todoViews.map((view) => <a className="nav-btn" key={view} {...link(view, focused === undefined && selection === view)}><Icon name={viewIcons[view]} size={18} /><span>{text(`todo.view.${view}`)}</span></a>)}
        </nav>
        <div className="todo-list-nav">
          <nav className="todo-list-links" aria-label={text("todo.lists")}>
            <h2>{text("todo.lists")}</h2>
            {active.map((list) => <a className="nav-btn" key={list.id} {...link({ list: list.id }, list.id === selectedList?.id)}>
              <Icon name="folder" size={18} /><span>{list.name}</span>
            </a>)}
          </nav>
          <select className="field todo-list-picker" aria-label={text("todo.lists")} value={selectedList?.id ?? ""}
            onChange={(event) => choose(event.target.value === "" ? "today" : { list: event.target.value })}>
            <option value="">{text("todo.lists")}</option>
            {active.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}
          </select>
          <button className="btn todo-list-manage" type="button" aria-haspopup="dialog" disabled={data === null} onClick={() => {
            setError(null);
            setManaging(true);
            dialog.current?.showModal();
          }}><Icon name="gear" size={16} />{text("todo.manageLists")}</button>
        </div>
      </aside>
      <section className="todo-content" aria-labelledby="todo-view-title">
        <h2 id="todo-view-title">{focused !== undefined ? text("todo.details") : typeof selection === "string" ? text(`todo.view.${selection}`) : selectedList?.name ?? text("todo.lists")}</h2>
        {focused === undefined && available && data !== null ? <form className="todo-quick" onSubmit={add}>
          <input className="field" name="title" placeholder={text("todo.quickAdd")} aria-label={text("todo.quickAdd")} required maxLength={240} disabled={busy} />
          <button className="btn btn-primary" type="submit" aria-label={text("todo.quickAdd")} title={text("todo.quickAdd")} disabled={busy}><Icon name="plus" /></button>
        </form> : null}
        {loadFailed ? <div className="todo-error" role="alert">{text("todo.loadFailed")} <button className="btn btn-sm" type="button" onClick={refresh}>{text("todo.retry")}</button></div> : null}
        {error === null || managing ? null : <p className="todo-error" role="alert">{error}</p>}
        {loading ? (loadFailed ? null : <div className="empty" role="status">{text("todo.loading")}</div>)
          : focused !== undefined && selected === undefined ? <div className="empty">{text("todo.unavailable")}</div>
          : !available ? <div className="empty">{text("todo.listUnavailable")}</div>
          : groups.every(({ todos }) => todos.length === 0) ? <div className="empty todo-empty"><Icon name={typeof selection === "string" ? viewIcons[selection] : "folder"} />{text("todo.empty")}</div>
          : groups.map(({ date, todos }) => <div className="todo-group" key={date ?? "open"}>
            {date === null ? null : <h3>{dateLabel(date)}</h3>}
            <TodoRows rows={todos} lists={lists} today={today} groupDate={date} busy={busy} editing={editing}
              setEditing={setEditing} apply={apply} navigate={navigate} topicRoute={topicRoute} />
          </div>)}
      </section>
    </div>
    <ListManager lists={lists} busy={busy} error={error} apply={apply} dialogRef={dialog} close={() => { setManaging(false); setError(null); }} />
  </div>;
}
