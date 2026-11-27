import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { storeTopic, type Hub } from "@super-agent2/hub";
import { AttachmentUpload, type MachineReport, nextTodoDay, protocolVersion, type ScheduleFields, startingEngineTable, todoDay } from "@super-agent2/protocol";

export interface LayoutFixture {
  readonly ticket: number;
  readonly startCard: number;
  readonly previewName: string;
  readonly todoDetail: string;
  readonly graphs: readonly (readonly number[])[];
}

const repositories = [
  "demo/garden-notes",
  "demo/plant-log",
  "demo/seed-exchange",
  "demo/weather-station",
  "demo/community-notices",
  "demo/a-repository-with-a-long-name-for-layout-testing",
] as const;
const paragraph = "这份笔记记录了花园的工作安排、每周的维护计划以及需要在下一次会议上讨论的事项。";
const previewName = `garden-notes-${"weekly-maintenance-and-work-schedule-".repeat(3)}preview.html`;
const markdown = [
  "## 本周维护计划",
  paragraph.repeat(3),
  ["```text", `garden schedule --section ${"greenhouse-north-".repeat(9)}`, "```"].join("\n"),
  [
    "| 工作 | 负责区域 | 当周进度 | 下周计划 | 参考文档 |",
    "| --- | --- | --- | --- | --- |",
    `| 浇水 | 温室北区 | 已完成 | 检查灌溉系统 ${paragraph} | ${"weekly-maintenance-".repeat(5)} |`,
  ].join("\n"),
].join("\n\n");

async function seedTransfer(url: string, icon: Buffer): Promise<void> {
  const request = async (path: string, method: string, body: string, type = "application/json") => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": type }, body });
    if (!response.ok) throw new Error(`Seeding ${path} failed with HTTP ${response.status}: ${await response.text()}`);
    return response;
  };
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>花园工作计划</title><style>body { font-family: system-ui; margin: 2rem; } img { display: block; max-width: 100%; height: auto; }</style><h1>花园工作计划</h1><p>${paragraph.repeat(4)}</p><img src="data:image/png;base64,${icon.toString("base64")}" width="1600" height="1600" alt="Super Agent"></html>`;
  const created = await request("/api/transfer/files", "POST", JSON.stringify({ name: previewName, size: Buffer.byteLength(html), mediaType: "text/html" }));
  const { attachment } = AttachmentUpload.parse(await created.json());
  const uploaded = await request(`/api/transfer/files/${attachment.id}/upload?offset=0`, "PUT", html, "application/octet-stream");
  await uploaded.body?.cancel();
  const sent = await request("/api/transfer", "POST", JSON.stringify({ text: paragraph.repeat(3), device: "desktop", files: [attachment.id] }));
  await sent.body?.cancel();
}

function seedSchedules(hub: Hub, topic: string, now: number): void {
  const plan = {
    title: "整理温室巡检记录",
    instruction: "Review the greenhouse logs, summarize unresolved maintenance items and post the report in this topic.",
    recurrence: { cron: "0 9 * * 1" }, repository: repositories[0], machine: "mac-mini",
  } satisfies ScheduleFields;
  const paused = hub.schedules.save({ title: "归档传感器报告", instruction: "Archive the sensor report.", recurrence: { trigger: "garden-sensors" } });
  hub.schedules.change(paused, "pause");
  const completed = hub.schedules.save({ title: "核对灌溉清单", instruction: "Check the irrigation checklist.", recurrence: { at: now + 86_400_000 } });
  const { connection } = hub.database;
  connection.prepare("UPDATE schedules SET state = 'completed', next_at = NULL, fields = json_set(fields, '$.recurrence.at', ?) WHERE id = ?")
    .run(now - 86_400_000, completed);
  const active = hub.schedules.save(plan);
  const entry = randomUUID();
  hub.conversations.writePromptNotice(entry, topic, "巡检记录已整理。");
  connection.prepare("UPDATE schedules SET topic = ? WHERE id = ?").run(topic, active);
  connection.prepare("INSERT INTO schedule_runs (id, schedule, revision, due_at, entry, state) VALUES (?, ?, 1, ?, ?, 'completed')")
    .run(randomUUID(), active, now, entry);
  const revised = { ...plan, recurrence: { cron: "30 8 * * 1" }, machine: "mac-studio" };
  connection.prepare("INSERT INTO schedule_proposals (id, topic, fields, target, target_revision, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .run(randomUUID(), topic, JSON.stringify(revised), active, now);
}

export async function seedLayout(hub: Hub, url: string, pageDir: string, deviceTransfer: boolean): Promise<LayoutFixture> {
  const now = Date.now();
  const code = storeTopic(hub.database, now, "温室维护工具", { repository: repositories[0] });
  const daily = storeTopic(hub.database, now, "花园日常安排");
  seedSchedules(hub, code, now);
  const icon = await readFile(join(pageDir, "icons", "icon-512.png"));
  const { attachment } = hub.attachments.create({ name: "garden-notes.png", size: icon.length, mediaType: "image/png" });
  const saved = await hub.attachments.write(attachment.id, 0, Readable.from([icon]));
  if (!saved.ok) throw new Error("Could not seed the layout image");

  for (const topic of [code, daily]) {
    hub.conversations.send(topic, paragraph, [attachment]);
    hub.conversations.writeConfirmation(topic, randomUUID(), markdown);
  }
  hub.memories.add(paragraph.repeat(4));
  const garden = hub.todos.addList("花园维护");
  hub.todos.addList("周末采购");
  const archived = hub.todos.addList("秋季种植");
  hub.todos.editList(archived.id, { archived: true });
  const timeZone = hub.database.ticketTimeZone;
  const today = todoDay(now, timeZone);
  const tomorrow = nextTodoDay(today);
  hub.todos.add({ title: "核对温室水表", notes: "记录早上的读数，并与上周的数据对照。", list: garden.id, date: todoDay(now - 86_400_000, timeZone), time: null });
  const todoDetail = hub.todos.add({ title: "把种子清单发给园艺小组", notes: "附上下一轮播种的品种和数量。", list: garden.id, date: today, time: "16:30" }).id;
  hub.todos.add({ title: "准备周末维护材料", notes: "确认园艺剪和备用标签够用。", list: garden.id, date: today, time: null });
  hub.todos.add({ title: "预约土壤检测", notes: "", list: garden.id, date: nextTodoDay(tomorrow), time: null });
  hub.todos.add({ title: "补充育苗土", notes: "", list: null, date: tomorrow, time: "10:00" });

  let detail = 0;
  let stopped = 0;
  let number = 0;
  const open = (repository: string, title: { en: string; zh: string }, waitsFor: readonly number[] = []) => {
    number++;
    const summary = { en: "Prepare the maintenance schedule and review the records at the next meeting.", zh: paragraph.repeat(3) };
    return hub.tickets.open({
      kind: "feature",
      repository,
      issues: [{ repository, number, title, summary, url: `https://github.com/${repository}/issues/${number}` }],
      title,
      summary,
      waitsFor,
    }).id;
  };
  hub.machines.add({ name: "mac-mini", accessClientId: "layout.access", system: "macos" });
  hub.runners.setStorage("mac-mini", { projectsDir: "/Users/demo/Projects", artifactsDir: "/Volumes/Workspace/Artifacts" });
  const machine = hub.machines.get("mac-mini");
  if (machine === undefined) throw new Error("Could not seed the layout machine");
  const link = hub.runners.attach(machine, { send: () => undefined, close: () => undefined });
  const claude = startingEngineTable.claude.standard;
  const report: MachineReport = {
    hostname: "mac-mini", platform: "darwin", arch: "arm64", release: "1", user: "owner", slots: { total: 4, free: 4 }, allowances: [],
    programs: [{ id: "claude", installed: true, path: null, version: null, source: "configuration", problem: null, models: [{ id: claude.model, efforts: [claude.effort] }] }],
  };
  link.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
  for (let seconds = 120; seconds >= 0; seconds -= 15) {
    link.receive({ type: "report", machine: { ...report, load: { cpuPercent: 85, ownCpuPercent: 3, gpuPercent: 97, sampledAt: now - seconds * 1_000 } } });
  }
  const pin = (ticket: number, issue: number) => {
    const pinned = hub.chains.arranger.state([{
      ticket, kind: "feature", issues: [{ number: issue, difficulty: "standard" }], platform: "macos",
      reason: { en: "A bounded review of the greenhouse checklist.", zh: "复核温室巡检表中的一项改动。" },
      machine: "mac-mini", ownerEngine: "claude",
    }]);
    if (!pinned.ok) throw new Error(pinned.reason);
  };
  for (const [index, repository] of [...repositories, ...repositories, ...repositories, ...repositories].entries()) {
    const title = { en: `Improve the garden's weekly maintenance schedule (${index + 1})`, zh: `完善花园的每周维护计划与工作记录（${index + 1}）` };
    const id = open(repository, title);
    if (index === 0) {
      detail = id;
      pin(id, number);
      hub.tickets.move(id, "waiting");
    }
    if (index >= 12) {
      stopped = id;
      hub.tickets.stop(id, { en: "Done for this season", zh: "本季的工作已经完成" });
    }
  }
  open(repositories[5], { en: "Plan next season's maintenance", zh: "规划下一季维护工作" }, [stopped]);

  const graph = (repository: string, nodes: readonly (readonly [string, string, ...number[]])[]) => {
    const ids: number[] = [];
    for (const [en, zh, ...after] of nodes) {
      const id = open(repository, { en, zh }, after.map((index) => ids[index]!));
      ids.push(id);
      if (after.length === 0) hub.tickets.move(id, "working");
    }
    return ids;
  };
  const merge = graph(repositories[1], [
    ["Fix the greenhouse sensors", "修复温室传感器"],
    ["Update the irrigation logs", "更新灌溉记录"],
    ["Check the monitoring dashboard", "校验监控面板", 0, 1],
  ]);
  const fork = graph(repositories[2], [
    ["Organize the seed catalog", "整理种子目录"],
    ["Make seed labels", "制作种子标签", 0],
    ["Improve seed search", "调整种子检索", 0],
  ]);
  const forkThenMerge = graph(repositories[0], [
    ["Update the garden maintenance process", "更新花园维护流程"],
    ["Prepare the greenhouse checklist", "整理温室巡检表", 0],
    ["Complete the irrigation records", "补充灌溉记录", 0],
    ["Publish the maintenance plan", "发布维护计划", 1, 2],
  ]);
  hub.tickets.move(forkThenMerge[0]!, "verifying");
  hub.tickets.move(forkThenMerge[1]!, "waiting");
  const startCard = open(repositories[0], { en: "Review the greenhouse checklist", zh: "复核温室巡检表" });
  pin(startCard, number);
  const card = hub.chains.cards().find((entry) => entry.ticket.id === startCard);
  if (card === undefined) throw new Error("Could not seed the conversation chain");
  for (const topic of [code, daily]) {
    hub.database.connection.prepare(`INSERT INTO conversation_entries (id, conversation_id, seq, kind, turn_id, body, created_at, stream_seq)
      VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM conversation_entries WHERE conversation_id = ?), 'chains', ?, ?, ?, (SELECT COALESCE(MAX(stream_seq), 0) + 1 FROM conversation_entries))`)
      .run(randomUUID(), topic, topic, randomUUID(), JSON.stringify({ chains: [{ ticket: startCard, fingerprint: card.fingerprint }] }), now);
  }
  for (const repository of repositories) hub.repositories.setPinned(repository, true);

  if (deviceTransfer) await seedTransfer(url, icon);
  return { ticket: detail, startCard, previewName, todoDetail, graphs: [forkThenMerge, fork, merge] };
}
