import type { Schedule, ScheduleRun } from "@super-agent2/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleApi } from "../hub/api.js";
import { SchedulesView } from "./SchedulesView.js";

const nextAt = Date.UTC(2026, 10, 22, 8);
const run: ScheduleRun = {
  id: "00000000-0000-4000-8000-000000000001", topic: "daily-topic", entry: "a-message",
  at: nextAt - 7 * 24 * 60 * 60_000, dueAt: nextAt - 7 * 24 * 60 * 60_000, state: "completed",
  tickets: [{ id: 42, title: "更新依赖", light: false, state: "merged" }],
};
const schedule: Schedule = {
  id: "00000000-0000-4000-8000-000000000002", title: "清理空间", instruction: "Check free space.",
  topic: run.topic, topicRepository: null, state: "active", nextAt,
  confirmedAt: nextAt - 60000, revision: 1, recurrence: { cron: "0 3 * * 0" }, lastRun: run,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((element) => element.textContent === label);
  if (found === undefined) throw new Error(`Button "${label}" was not shown`);
  return found;
}

describe("schedules tab", () => {
  it("shows the service in place of a next time and edits the trigger name", async () => {
    const triggered: Schedule = { ...schedule, recurrence: { trigger: "loom" }, nextAt: null };
    const current = { ok: true as const, value: { timeZone: "America/New_York", schedules: [triggered] } };
    vi.spyOn(scheduleApi, "schedules").mockResolvedValue(current);
    const save = vi.spyOn(scheduleApi, "saveSchedule").mockResolvedValue(current);
    await act(async () => root.render(<SchedulesView navigate={() => undefined} />));
    expect(host.textContent).toContain("由 loom 触发");
    expect(host.textContent).not.toContain("下次");
    await act(async () => button("编辑").click());
    const source = host.querySelector<HTMLInputElement>('input[name="source"]')!;
    expect(source.value).toBe("loom");
    expect(host.querySelector('input[type="time"]')).toBeNull();
    source.value = "another-source";
    expect(source.checkValidity()).toBe(true);
    await act(async () => button("保存并确认").click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ recurrence: { trigger: "another-source" } }), triggered.id, triggered.revision);
  });

  it("shows localized timing, links to runs, and manages schedules", async () => {
    let schedules = [schedule];
    const current = () => ({ ok: true as const, value: { timeZone: "America/New_York", schedules } });
    vi.spyOn(scheduleApi, "schedules").mockImplementation(() => Promise.resolve(current()));
    vi.spyOn(scheduleApi, "scheduleHistory").mockResolvedValue({ ok: true, value: { runs: [run] } });
    const change = vi.spyOn(scheduleApi, "changeSchedule").mockImplementation((_id, action) => {
      schedules = action === "delete" ? [] : [{ ...schedule, state: action === "pause" ? "paused" : "active" }];
      return Promise.resolve(current());
    });
    vi.stubGlobal("confirm", () => true);
    await act(async () => root.render(<SchedulesView navigate={() => undefined} />));
    expect(host.textContent).toContain("每周日 03:00");
    expect(host.textContent).toContain("下次");
    expect(host.querySelector('a[href="/conversations/daily-topic?scope=daily&entry=a-message"]')).not.toBeNull();
    await act(async () => button(schedule.title).click());
    expect(host.textContent).toContain("运行记录");
    expect(host.querySelector('a[href="/tickets/42"]')?.textContent).toBe("更新依赖");
    await act(async () => button("暂停").click());
    expect(change).toHaveBeenLastCalledWith(schedule.id, "pause");
    await act(async () => button("恢复").click());
    expect(change).toHaveBeenLastCalledWith(schedule.id, "resume");
    await act(async () => button("删除").click());
    expect(change).toHaveBeenLastCalledWith(schedule.id, "delete");
    expect(host.textContent).toContain("暂无定时任务");
  });
});
