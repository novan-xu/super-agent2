import { text } from "@super-agent2/catalog";
import { pagePath, ScheduleFields, type PageRoute, type Schedule, type ScheduleAction, type ScheduleList, type ScheduleRecurrence, type ScheduleRun } from "@super-agent2/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { scheduleApi } from "../hub/api.js";
import { Icon } from "../parts/icons.js";
import type { Navigate } from "../parts/route.js";
import { followLink } from "../parts/Shell.js";

const frequencies = ["daily", "weekly", "monthly", "once", "cron"] as const;
type Frequency = (typeof frequencies)[number];
const days = ["0", "1", "2", "3", "4", "5", "6"] as const;
const dateTime = (at: number, timeZone: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone, month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(at);

function timing(recurrence: ScheduleRecurrence): { frequency: Frequency; time: string; weekday: typeof days[number]; day: string } {
  const base = { time: "09:00", weekday: "0" as const, day: "1" };
  if ("at" in recurrence) return { ...base, frequency: "once" };
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

function Editor({ schedule, timeZone, busy, save, cancel }: {
  readonly schedule: Schedule | null;
  readonly timeZone: string;
  readonly busy: boolean;
  readonly save: (fields: ScheduleFields) => void;
  readonly cancel: () => void;
}) {
  const existing = schedule?.recurrence ?? { cron: "0 9 * * *" };
  const initial = timing(existing);
  const [frequency, setFrequency] = useState(initial.frequency);
  const [time, setTime] = useState(initial.time);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (key: string) => String(data.get(key) ?? "").trim();
    const [hour, minute] = time.split(":").map(Number);
    const cron = `${minute} ${hour} ${frequency === "monthly" ? read("day") : "*"} * ${frequency === "weekly" ? read("weekday") : "*"}`;
    const recurrence = frequency === "once" ? { at: new Date(read("at")).getTime() }
      : { cron: frequency === "cron" ? read("cron") : cron };
    save({
      title: read("title"), instruction: read("instruction"), recurrence,
      ...(read("repository") === "" ? {} : { repository: read("repository") }),
      ...(read("machine") === "" ? {} : { machine: read("machine") }),
    });
  };
  return (
    <form className="schedule-editor" onSubmit={submit}>
      <label>{text("schedule.title")}<input className="field" name="title" required maxLength={120} defaultValue={schedule?.title} /></label>
      <label>{text("schedule.instruction")}<textarea className="field" name="instruction" required maxLength={12000} rows={4} defaultValue={schedule?.instruction} /></label>
      <div className="schedule-fields">
        <label>{text("schedule.frequency")}
          <select className="field" value={frequency} onChange={(event) => {
            const next = frequencies.find((value) => value === event.target.value);
            if (next !== undefined) setFrequency(next);
          }}>
            {frequencies.map((value) => <option key={value} value={value}>{text(`schedule.frequency.${value}`)}</option>)}
          </select>
        </label>
        {frequency === "once" ? (
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
        <label>{text("schedule.repository")}<input className="field" name="repository" defaultValue={schedule?.repository} /></label>
        <label>{text("schedule.machine")}<input className="field" name="machine" maxLength={100} defaultValue={schedule?.machine} /></label>
      </div>
      <div className="schedule-actions">
        <span className="muted">{frequency === "once" ? null : timeZone}</span>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={cancel}>{text("schedule.cancel")}</button>
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>{text(schedule === null ? "schedule.confirm" : "schedule.confirmEdit")}</button>
      </div>
    </form>
  );
}

function runRoute(schedule: Schedule, run?: ScheduleRun): PageRoute {
  return {
    view: "conversations",
    conversation: run?.topic ?? schedule.topic,
    scope: schedule.topicRepository === null ? { kind: "daily" } : { kind: "repository", repository: schedule.topicRepository },
    ...(run === undefined ? {} : { entry: run.entry }),
  };
}

export function SchedulesView({ navigate }: { readonly navigate: Navigate }) {
  const [data, setData] = useState<ScheduleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Schedule | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; runs: readonly ScheduleRun[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    if (busy) return;
    let active = true;
    const refresh = async () => {
      const version = ++request.current;
      const result = await scheduleApi.schedules();
      if (!active || version !== request.current) return;
      if (result.ok) setData(result.value);
      else setError(text("schedule.loadFailed"));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [busy]);

  useEffect(() => {
    if (selected === null) return;
    let active = true;
    const refresh = async () => {
      const result = await scheduleApi.scheduleHistory(selected);
      if (!active) return;
      if (result.ok) setHistory({ id: selected, runs: result.value.runs });
      else setError(text("schedule.loadFailed"));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selected]);

  const apply = async (action: () => ReturnType<typeof scheduleApi.schedules>, saving: boolean) => {
    request.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(text(saving ? "schedule.saveFailed" : "schedule.actionFailed"));
        return;
      }
      setData(result.value);
      if (saving) setEditor(undefined);
      if (!result.value.schedules.some((item) => item.id === selected)) setSelected(null);
    } finally {
      setBusy(false);
    }
  };

  const save = (fields: ScheduleFields) => {
    const checked = ScheduleFields.safeParse(fields);
    if (!checked.success) {
      setError(text("schedule.saveFailed"));
      return;
    }
    void apply(() => scheduleApi.saveSchedule(checked.data, editor?.id, editor?.revision), true);
  };
  const change = (schedule: Schedule, action: ScheduleAction) => {
    if (action === "delete" && !window.confirm(text("schedule.deleteConfirm", { title: schedule.title }))) return;
    void apply(() => scheduleApi.changeSchedule(schedule.id, action), false);
  };
  const link = (route: PageRoute, label: string) => <a className="btn btn-sm" href={pagePath(route)} onClick={(event) => followLink(event, () => navigate(route))}>{label}</a>;
  const timeZone = data?.timeZone;
  return (
    <div className="page schedules">
      <div className="schedule-toolbar">
        <button className="btn btn-primary btn-sm" type="button" disabled={timeZone === undefined || busy}
          onClick={() => { setError(null); setEditor(null); }}><Icon name="plus" />{text("schedule.new")}</button>
      </div>
      {error === null ? null : <p className="schedule-status" role="alert">{error}</p>}
      {editor === undefined || timeZone === undefined ? null : <Editor key={editor?.id ?? "new"} schedule={editor} timeZone={timeZone} busy={busy}
        save={save} cancel={() => { setError(null); setEditor(undefined); }} />}
      {data === null ? <p className="schedule-status muted">{error === null ? text("schedule.loading") : null}</p>
        : data.schedules.length === 0 && editor === undefined ? <p className="schedule-status muted">{text("schedule.empty")}</p> : null}
      <ul className="schedule-list">
        {data?.schedules.map((schedule) => {
          const current = schedule.id === selected;
          const last = schedule.lastRun;
          return <li className="schedule-card" key={schedule.id}>
            <div className="schedule-summary">
              <div>
                <button className="schedule-title" type="button" aria-expanded={current} onClick={() => setSelected(current ? null : schedule.id)}>{schedule.title}</button>
                <p className="muted">{recurrenceLabel(schedule.recurrence, data.timeZone)}</p>
                {schedule.nextAt === null ? <p className="muted">{text(`schedule.state.${schedule.state}`)}</p>
                  : <p className="muted num">{text("schedule.next", { time: dateTime(schedule.nextAt, data.timeZone) })}</p>}
                {last === null ? null : <p className="schedule-last"><span className="muted num">{text("schedule.last", { time: dateTime(last.at, data.timeZone) })}</span>
                  {link(runRoute(schedule, last), text(`schedule.run.${last.state}`))}</p>}
              </div>
              <div className="schedule-actions">
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { setError(null); setEditor(schedule); }}>{text("schedule.edit")}</button>
                {schedule.state === "completed" ? null : <button className="btn btn-sm" type="button" disabled={busy}
                  onClick={() => change(schedule, schedule.state === "paused" ? "resume" : "pause")}>{text(schedule.state === "paused" ? "schedule.resume" : "schedule.pause")}</button>}
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => change(schedule, "delete")}>{text("schedule.delete")}</button>
              </div>
            </div>
            {current ? <div className="schedule-history">
              <div className="schedule-summary"><h2>{text("schedule.history")}</h2>{link(runRoute(schedule), text("schedule.openTopic"))}</div>
              {history?.id === schedule.id && history.runs.length === 0 ? <p className="muted">{text("schedule.noRuns")}</p> : null}
              <ul>
                {history?.id !== schedule.id ? null : history.runs.map((run) => <li key={run.id}>
                  <span className="num">{dateTime(run.at, data.timeZone)}</span>
                  <span className="chip">{text(`schedule.run.${run.state}`)}</span>
                  {link(runRoute(schedule, run), text("schedule.openResult"))}
                  {run.tickets.filter((ticket) => !ticket.light).map((ticket) => <span key={ticket.id}>{link({ view: "ticket", ticket: ticket.id }, ticket.title)}</span>)}
                </li>)}
              </ul>
            </div> : null}
          </li>;
        })}
      </ul>
    </div>
  );
}
