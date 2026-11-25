import type { Schedule, ScheduleProposal, ScheduleRun } from "@super-agent2/protocol";
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

const proposal: ScheduleProposal = {
  id: "00000000-0000-4000-8000-000000000003", createdAt: nextAt - 30000,
  topic: "planning-topic", topicRepository: "owner/project", target: schedule.id, targetRevision: schedule.revision,
  fields: { title: "检查剩余空间", instruction: "Report free space and list large files.", recurrence: { cron: "30 8 * * 0" }, repository: "owner/project", machine: "mac-mini" },
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
    const current = { ok: true as const, value: { timeZone: "America/New_York", schedules: [triggered], proposals: [] } };
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
    const current = () => ({ ok: true as const, value: { timeZone: "America/New_York", schedules, proposals: [] } });
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

  it("renders pending and confirmed cards, compares an edit and confirms the owner's edited fields", async () => {
    const timeZone = "America/New_York";
    const current = { ok: true as const, value: { timeZone, schedules: [schedule], proposals: [proposal] } };
    const edited = { ...proposal.fields, title: "检查工作机空间" };
    const revised = { ...schedule, ...edited, revision: 2 };
    const updated = { ok: true as const, value: { timeZone, schedules: [revised], proposals: [] } };
    const read = vi.spyOn(scheduleApi, "schedules").mockResolvedValue(current);
    const confirm = vi.spyOn(scheduleApi, "confirmProposal").mockImplementation(() => {
      read.mockResolvedValue(updated);
      return Promise.resolve(updated);
    });
    await act(async () => root.render(<SchedulesView navigate={() => undefined} focusedProposal={proposal.id} />));
    expect(host.querySelectorAll(".schedule-card")).toHaveLength(2);
    const card = host.querySelector(".schedule-card--proposal")!;
    expect(document.activeElement).toBe(card);
    expect(card.textContent).toContain("每周日 08:30");
    expect(card.textContent).toContain("owner/project · mac-mini");
    expect(card.textContent).toContain(proposal.fields.instruction);
    expect(card.querySelector('a[href="/conversations/planning-topic?repository=owner%2Fproject"]')).not.toBeNull();
    expect(card.querySelector("details")?.textContent).toContain("每周日 03:00");
    expect(card.querySelector("details")?.textContent).toContain(schedule.instruction);
    await act(async () => button("修改").click());
    const field = card.querySelector<HTMLInputElement>('input[name="title"]')!;
    expect(field.value).toBe(proposal.fields.title);
    field.value = edited.title;
    await act(async () => button("保存并确认").click());
    expect(confirm).toHaveBeenCalledWith(proposal.id, edited);
    expect(host.querySelector(".schedule-card--proposal")).toBeNull();
    expect(host.querySelector(".schedule-card")?.textContent).toContain(edited.title);
  });

  it.each(["确认", "放弃"] as const)("refreshes on a socket update and sends the %s action for a new card", async (action) => {
    const timeZone = "America/New_York";
    const pending = { ...proposal, target: null, targetRevision: null };
    const read = vi.spyOn(scheduleApi, "schedules").mockResolvedValue({ ok: true, value: { timeZone, schedules: [], proposals: [] } });
    const navigate = () => undefined;
    await act(async () => root.render(<SchedulesView navigate={navigate} />));
    expect(host.textContent).toContain("暂无定时任务");
    read.mockResolvedValue({ ok: true, value: { timeZone, schedules: [], proposals: [pending] } });
    await act(async () => root.render(<SchedulesView navigate={navigate} update={{ type: "schedules.changed", pending: 1 }} />));
    expect(host.textContent).toContain("待确认");
    const apply = vi.spyOn(scheduleApi, action === "确认" ? "confirmProposal" : "discardProposal").mockImplementation(() => {
      const updated = { ok: true as const, value: { timeZone, schedules: action === "确认" ? [schedule] : [], proposals: [] } };
      read.mockResolvedValue(updated);
      return Promise.resolve(updated);
    });
    await act(async () => button(action).click());
    expect(apply).toHaveBeenCalledWith(proposal.id);
    expect(host.querySelector(".schedule-card--proposal")).toBeNull();
    if (action === "确认") expect(host.querySelector(".schedule-card")?.textContent).toContain(schedule.title);
    else expect(host.textContent).toContain("暂无定时任务");
  });
});
