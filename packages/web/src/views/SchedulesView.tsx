import { text } from "@super-agent2/catalog";
import { pagePath, ScheduleFields, type PageRoute, type Schedule, type ScheduleAction, type ScheduleList, type ScheduleProposal, type ScheduleRecurrence, type ScheduleRun, type SchedulesUpdate } from "@super-agent2/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { scheduleApi } from "../hub/api.js";
import { Icon } from "../parts/icons.js";
import type { Navigate } from "../parts/route.js";
import { followLink } from "../parts/Shell.js";

const frequencies = ["daily", "weekly", "monthly", "once", "cron", "trigger"] as const;
type Frequency = (typeof frequencies)[number];
const days = ["0", "1", "2", "3", "4", "5", "6"] as const;
const dateTime = (at: number, timeZone: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone, month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(at);

function timing(recurrence: ScheduleRecurrence): { frequency: Frequency; time: string; weekday: typeof days[number]; day: string } {
  const base = { time: "09:00", weekday: "0" as const, day: "1" };
  if ("at" in recurrence) return { ...base, frequency: "once" };
  if ("trigger" in recurrence) return { ...base, frequency: "trigger" };
  const [minute, hour, day, month, weekday] = recurrence.cron.split(/ +/);
  if (minute === undefined || hour === undefined || month !== "*" || !/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return { ...base, frequency: "cron" };
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (day === "*" && weekday === "*") return { ...base, time, frequency: "daily" };
  const week = days.find((value) => value === weekday || (value === "0" && weekday === "7"));
  if (day === "*" && week !== undefined) return { ...base, time, weekday: week, frequency: "weekly" };
  if (day !== undefined && /^\d+$/.test(day) && weekday === "*") return { ...base, time, day, frequency: "monthly" };
  return { ...base, frequency: "cron" };
}

function fieldLabel(field = "*"): string {
  const [range, step] = field.split("/");
  const words = (range ?? "*").replaceAll(",", "、").replaceAll("-", " 至 ");
  if (step !== undefined) return words === "*" ? text("schedule.repeat.step", { step }) : text("schedule.repeat.range", { range: words, step });
  return words === "*" ? text("schedule.repeat.any") : words;
}

export function recurrenceLabel(recurrence: ScheduleRecurrence, timeZone: string): string {
  if ("at" in recurrence) return text("schedule.repeat.once", { time: dateTime(recurrence.at, timeZone) });
  if ("trigger" in recurrence) return text("schedule.repeat.trigger", { source: recurrence.trigger });
  const when = timing(recurrence);
  if (when.frequency === "daily") return text("schedule.repeat.daily", { time: when.time });
  if (when.frequency === "weekly") return text("schedule.repeat.weekly", { day: text(`schedule.weekday.${when.weekday}`), time: when.time });
  if (when.frequency === "monthly") return text("schedule.repeat.monthly", { day: when.day, time: when.time });
  const [minute, hour, day, month, weekday] = recurrence.cron.split(/ +/).map(fieldLabel);
  return text("schedule.repeat.cron", { minute: minute ?? "", hour: hour ?? "", day: day ?? "", month: month ?? "", weekday: weekday ?? "" });
}

function localValue(at: number): string {
  return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Editor({ fields, timeZone, busy, save, cancel }: {
  readonly fields: ScheduleFields | null;
  readonly timeZone: string;
  readonly busy: boolean;
  readonly save: (fields: ScheduleFields) => void;
  readonly cancel: () => void;
}) {
  const existing = fields?.recurrence ?? { cron: "0 9 * * *" };
  const initial = timing(existing);
  const [frequency, setFrequency] = useState(initial.frequency);
  const [time, setTime] = useState(initial.time);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (key: string) => String(data.get(key) ?? "").trim();
    const [hour, minute] = time.split(":").map(Number);
    const cron = `${minute} ${hour} ${frequency === "monthly" ? read("day") : "*"} * ${frequency === "weekly" ? read("weekday") : "*"}`;
    const at = "at" in existing && localValue(existing.at) === read("at") ? existing.at : new Date(read("at")).getTime();
    const recurrence = frequency === "trigger" ? { trigger: read("source") }
      : frequency === "once" ? { at }
      : { cron: frequency === "cron" ? read("cron") : cron };
    save({
      title: read("title"), instruction: read("instruction"), recurrence,
      ...(read("repository") === "" ? {} : { repository: read("repository") }),
      ...(read("machine") === "" ? {} : { machine: read("machine") }),
    });
  };
  return (
    <form className={fields === null ? "schedule-editor schedule-editor--standalone" : "schedule-editor"} onSubmit={submit}>
      <label>{text("schedule.title")}<input className="field" name="title" required maxLength={120} defaultValue={fields?.title} /></label>
      <label>{text("schedule.instruction")}<textarea className="field" name="instruction" required maxLength={12000} rows={4} defaultValue={fields?.instruction} /></label>
      <div className="schedule-fields">
        <label>{text("schedule.frequency")}
          <select className="field" value={frequency} onChange={(event) => {
            const next = frequencies.find((value) => value === event.target.value);
            if (next !== undefined) setFrequency(next);
          }}>
            {frequencies.map((value) => <option key={value} value={value}>{text(`schedule.frequency.${value}`)}</option>)}
          </select>
        </label>
        {frequency === "trigger" ? (
          <label>{text("schedule.source")}<input className="field" name="source" required maxLength={64} pattern="[a-z0-9][a-z0-9_\-]{0,63}" defaultValue={"trigger" in existing ? existing.trigger : undefined} /></label>
        ) : frequency === "once" ? (
          <label>{text("schedule.localTime")}<input className="field" name="at" type="datetime-local" required defaultValue={"at" in existing ? localValue(existing.at) : undefined} /></label>
        ) : frequency === "cron" ? (
          <label>{text("schedule.cron")}<input className="field mono" name="cron" required maxLength={100} defaultValue={"cron" in existing ? existing.cron : undefined}
            placeholder={text("schedule.cron.hint")} /></label>
        ) : (
          <label>{text("schedule.time")}<input className="field" name="time" type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></label>
        )}
        {frequency === "weekly" ? <label>{text("schedule.weekday")}<select className="field" name="weekday" defaultValue={initial.weekday}>
          {days.map((value) => <option key={value} value={value}>{text(`schedule.weekday.${value}`)}</option>)}
        </select></label> : null}
        {frequency === "monthly" ? <label>{text("schedule.monthDay")}<input className="field" name="day" type="number" required min={1} max={31} defaultValue={initial.day} /></label> : null}
      </div>
      <div className="schedule-fields">
        <label>{text("schedule.repository")}<input className="field" name="repository" defaultValue={fields?.repository} /></label>
        <label>{text("schedule.machine")}<input className="field" name="machine" maxLength={100} defaultValue={fields?.machine} /></label>
      </div>
      <div className="schedule-actions">
        <span className="muted">{frequency === "once" || frequency === "trigger" ? null : timeZone}</span>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={cancel}>{text("schedule.cancel")}</button>
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>{text(fields === null ? "schedule.confirm" : "schedule.confirmEdit")}</button>
      </div>
    </form>
  );
}

function topicRoute(schedule: Pick<Schedule, "topic" | "topicRepository">, run?: ScheduleRun): PageRoute {
  return {
    view: "conversations",
    conversation: run?.topic ?? schedule.topic,
    scope: schedule.topicRepository === null ? { kind: "daily" } : { kind: "repository", repository: schedule.topicRepository },
    ...(run === undefined ? {} : { entry: run.entry }),
  };
}

function ProposalChanges({ current, fields, timeZone }: {
  readonly current: Schedule;
  readonly fields: ScheduleFields;
  readonly timeZone: string;
}) {
  const unset = text("schedule.proposal.unset");
  const changes = [
    [text("schedule.title"), current.title, fields.title],
    [text("schedule.frequency"), recurrenceLabel(current.recurrence, timeZone), recurrenceLabel(fields.recurrence, timeZone)],
    [text("schedule.proposal.repository"), current.repository ?? unset, fields.repository ?? unset],
    [text("schedule.proposal.machine"), current.machine ?? unset, fields.machine ?? unset],
    [text("schedule.instruction"), current.instruction, fields.instruction],
  ].filter(([, before, after]) => before !== after);
  if (changes.length === 0) return <p className="muted">{text("schedule.proposal.noChanges")}</p>;
  return <details className="schedule-changes">
    <summary>{text("schedule.proposal.changes")} · {changes.map(([label]) => label).join("、")}</summary>
    <dl>{changes.map(([label, before, after]) => <div key={label}>
      <dt>{label}</dt>
      <dd><span className="muted">{text("schedule.proposal.from")}</span><span>{before}</span></dd>
      <dd><span className="muted">{text("schedule.proposal.to")}</span><span>{after}</span></dd>
    </div>)}</dl>
  </details>;
}

type Editing = { readonly kind: "new" }
  | { readonly kind: "schedule"; readonly item: Schedule }
  | { readonly kind: "proposal"; readonly item: ScheduleProposal };

export function SchedulesView({ navigate, update, focusedProposal }: {
  readonly navigate: Navigate;
  readonly update?: SchedulesUpdate | null;
  readonly focusedProposal?: string | undefined;
}) {
  const [data, setData] = useState<ScheduleList | null>(null);
  const [error, setError] = useState<{ message: string; id?: string | undefined } | null>(null);
  const [editor, setEditor] = useState<Editing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; runs: readonly ScheduleRun[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const linkedCard = useRef<HTMLLIElement>(null);
  const linked = data?.proposals.some((item) => item.id === focusedProposal) ?? false;

  useEffect(() => {
    if (linked) linkedCard.current?.focus();
  }, [focusedProposal, linked]);

  useEffect(() => {
    if (busy) return;
    let active = true;
    const refresh = async () => {
      const version = ++request.current;
      const result = await scheduleApi.schedules();
      if (!active || version !== request.current) return;
      if (result.ok) setData(result.value);
      else setError({ message: text("schedule.loadFailed") });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [busy, update]);

  useEffect(() => {
    if (selected === null) return;
    let active = true;
    const refresh = async () => {
      const result = await scheduleApi.scheduleHistory(selected);
      if (!active) return;
      if (result.ok) setHistory({ id: selected, runs: result.value.runs });
      else setError({ message: text("schedule.loadFailed"), id: selected });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selected]);

  const apply = async (action: () => ReturnType<typeof scheduleApi.schedules>, saving: boolean, id?: string) => {
    request.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        const message = result.error === "conflict" ? "schedule.proposal.stale"
          : result.error === "not_found" ? "schedule.proposal.missing" : saving ? "schedule.saveFailed" : "schedule.actionFailed";
        setError({ message: text(message), id });
        return;
      }
      setData(result.value);
      if (saving || (editor?.kind === "proposal" && editor.item.id === id)) setEditor(null);
      if (!result.value.schedules.some((item) => item.id === selected)) setSelected(null);
      if (focusedProposal !== undefined && id === focusedProposal) navigate({ view: "schedules" }, true);
    } finally {
      setBusy(false);
    }
  };

  const save = (fields: ScheduleFields, editing: Editing) => {
    const checked = ScheduleFields.safeParse(fields);
    const id = editing.kind === "new" ? undefined : editing.item.id;
    if (!checked.success) {
      setError({ message: text("schedule.saveFailed"), id });
      return;
    }
    void apply(() => editing.kind === "proposal" ? scheduleApi.confirmProposal(editing.item.id, checked.data)
      : scheduleApi.saveSchedule(checked.data, id, editing.kind === "schedule" ? editing.item.revision : undefined), true, id);
  };
  const change = (schedule: Schedule, action: ScheduleAction) => {
    if (action === "delete" && !window.confirm(text("schedule.deleteConfirm", { title: schedule.title }))) return;
    void apply(() => scheduleApi.changeSchedule(schedule.id, action), false, schedule.id);
  };
  const edit = (next: Editing | null) => { setError(null); setEditor(next); };
  const form = (editing: Editing, timeZone: string) => <Editor key={editing.kind === "new" ? "new" : editing.item.id}
    fields={editing.kind === "new" ? null : editing.kind === "proposal" ? editing.item.fields : editing.item}
    timeZone={timeZone} busy={busy} save={(fields) => save(fields, editing)} cancel={() => edit(null)} />;
  const actionError = (id?: string) => error !== null && error.id === id ? <p className="schedule-error" role="alert">{error.message}</p> : null;
  const link = (route: PageRoute, label: string) => <a className="btn btn-sm" href={pagePath(route)} onClick={(event) => followLink(event, () => navigate(route))}>{label}</a>;
  return (
    <div className="page schedules">
      <div className="schedule-toolbar">
        <button className="btn btn-primary btn-sm" type="button" disabled={data === null || busy}
          onClick={() => edit({ kind: "new" })}><Icon name="plus" />{text("schedule.new")}</button>
      </div>
      {actionError()}
      {error?.id !== undefined && data !== null && ![...data.proposals, ...data.schedules].some(({ id }) => id === error.id) ? actionError(error.id) : null}
      {focusedProposal !== undefined && data !== null && !linked && error?.id !== focusedProposal ? <p className="schedule-status muted">{text("schedule.proposal.missing")}</p> : null}
      {editor?.kind === "new" && data !== null ? form(editor, data.timeZone) : null}
      {data === null ? <p className="schedule-status muted">{error === null ? text("schedule.loading") : null}</p>
        : data.schedules.length === 0 && data.proposals.length === 0 && editor?.kind !== "new" ? <p className="schedule-status muted">{text("schedule.empty")}</p> : null}
      {data === null || data.proposals.length === 0 ? null : <section className="schedule-group" aria-labelledby="schedule-pending">
        <h2 id="schedule-pending">{text("schedule.pending")}</h2>
        <ul className="schedule-list">
          {data.proposals.map((proposal) => {
            const { id, fields, target, targetRevision } = proposal;
            const current = data.schedules.find((item) => item.id === target);
            const stale = target !== null && current?.revision !== targetRevision;
            const focused = id === focusedProposal;
            const editing = editor?.kind === "proposal" && editor.item.id === id;
            return <li className={`schedule-card schedule-card--proposal${focused ? " schedule-card--focused" : ""}`} key={id}
              ref={focused ? linkedCard : undefined} tabIndex={focused ? -1 : undefined}>
              <div className="schedule-heading"><span className="dot dot--warn" aria-hidden="true" /><h3>{fields.title}</h3>
                <span className="muted schedule-state">{text(target === null ? "schedule.proposal.kind.new" : "schedule.proposal.kind.edit")}</span></div>
              <p className="schedule-timing">{recurrenceLabel(fields.recurrence, data.timeZone)}</p>
              {fields.repository === undefined && fields.machine === undefined ? null : <p className="schedule-meta muted">
                {[fields.repository, fields.machine].filter(Boolean).join(" · ")}</p>}
              <p className="schedule-preview">{fields.instruction}</p>
              {stale ? <p className="schedule-error" role="status">{text("schedule.proposal.stale")}</p> : current === undefined ? null
                : <ProposalChanges current={current} fields={fields} timeZone={data.timeZone} />}
              {stale ? null : actionError(id)}
              <div className="schedule-footer">
                <a className="schedule-topic" href={pagePath(topicRoute(proposal))} onClick={(event) => followLink(event, () => navigate(topicRoute(proposal)))}>{text("schedule.proposal.source")}</a>
                {!editing ? <div className="schedule-actions">
                  <button className="btn btn-sm btn-primary" type="button" disabled={busy || stale} onClick={() => void apply(() => scheduleApi.confirmProposal(id), true, id)}>{text("schedule.proposal.confirm")}</button>
                  <button className="btn btn-sm" type="button" disabled={busy || stale} onClick={() => edit({ kind: "proposal", item: proposal })}>{text("schedule.proposal.edit")}</button>
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void apply(() => scheduleApi.discardProposal(id), false, id)}>{text("schedule.proposal.discard")}</button>
                </div> : null}
              </div>
              {editing ? form(editor, data.timeZone) : null}
            </li>;
          })}
        </ul>
      </section>}
      {data === null || data.schedules.length === 0 ? null : <section className="schedule-group" aria-labelledby="schedule-saved">
        <h2 id="schedule-saved" className={data.proposals.length === 0 ? "sr-only" : undefined}>{text("schedule.saved")}</h2>
        <ul className="schedule-list">
          {data.schedules.map((schedule) => {
            const current = schedule.id === selected;
            const last = schedule.lastRun;
            return <li className="schedule-card" key={schedule.id}>
              <div className="schedule-heading">
                <span className={`dot dot--${schedule.state === "active" ? "ok" : schedule.state === "paused" ? "warn" : "mute"}`} aria-hidden="true" />
                <h3><button className="schedule-title" type="button" aria-expanded={current} onClick={() => setSelected(current ? null : schedule.id)}>{schedule.title}<Icon name="down" size={14} /></button></h3>
                <span className="muted schedule-state">{text(`schedule.state.${schedule.state}`)}</span>
              </div>
              <p className="schedule-timing">{recurrenceLabel(schedule.recurrence, data.timeZone)}</p>
              {schedule.nextAt === null ? null : <p className="muted num schedule-meta">{text("schedule.next", { time: dateTime(schedule.nextAt, data.timeZone) })}</p>}
              {last === null ? null : <p className="schedule-last"><span className="muted num">{text("schedule.last", { time: dateTime(last.at, data.timeZone) })}</span>
                {link(topicRoute(schedule, last), text(`schedule.run.${last.state}`))}</p>}
              {actionError(schedule.id)}
              <div className="schedule-footer">
                <div className="schedule-actions">
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => edit({ kind: "schedule", item: schedule })}>{text("schedule.edit")}</button>
                  {schedule.state === "completed" ? null : <button className="btn btn-sm" type="button" disabled={busy}
                    onClick={() => change(schedule, schedule.state === "paused" ? "resume" : "pause")}>{text(schedule.state === "paused" ? "schedule.resume" : "schedule.pause")}</button>}
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => change(schedule, "delete")}>{text("schedule.delete")}</button>
                </div>
              </div>
              {editor?.kind === "schedule" && editor.item.id === schedule.id ? form(editor, data.timeZone) : null}
              {current ? <div className="schedule-history">
                <div className="schedule-summary"><h4>{text("schedule.history")}</h4>{link(topicRoute(schedule), text("schedule.openTopic"))}</div>
                {history?.id === schedule.id && history.runs.length === 0 ? <p className="muted">{text("schedule.noRuns")}</p> : null}
                <ul>
                  {history?.id !== schedule.id ? null : history.runs.map((run) => <li key={run.id}>
                    <span className="num">{dateTime(run.at, data.timeZone)}</span>
                    <span className="chip">{text(`schedule.run.${run.state}`)}</span>
                    {link(topicRoute(schedule, run), text("schedule.openResult"))}
                    {run.tickets.filter((ticket) => !ticket.light).map((ticket) => <span key={ticket.id}>{link({ view: "ticket", ticket: ticket.id }, ticket.title)}</span>)}
                  </li>)}
                </ul>
              </div> : null}
            </li>;
          })}
        </ul>
      </section>}
    </div>
  );
}
