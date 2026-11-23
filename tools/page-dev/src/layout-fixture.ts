import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { storeTopic, type Hub } from "@super-agent2/hub";
import { AttachmentUpload } from "@super-agent2/protocol";

export interface LayoutFixture {
  readonly ticket: number;
  readonly previewName: string;
}

const repositories = [
  "demo/garden-notes",
  "demo/plant-log",
  "demo/a-repository-with-a-long-name-for-layout-testing",
  "demo/seed-exchange",
  "demo/weather-station",
  "demo/community-notices",
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

export async function seedLayout(hub: Hub, url: string, pageDir: string): Promise<LayoutFixture> {
  const now = Date.now();
  const code = storeTopic(hub.database, now, "温室维护工具", { repository: repositories[0] });
  const daily = storeTopic(hub.database, now, "花园日常安排");
  const icon = await readFile(join(pageDir, "icons", "icon-512.png"));
  const { attachment } = hub.attachments.create({ name: "garden-notes.png", size: icon.length, mediaType: "image/png" });
  const saved = await hub.attachments.write(attachment.id, 0, Readable.from([icon]));
  if (!saved.ok) throw new Error("Could not seed the layout image");

  for (const topic of [code, daily]) {
    hub.conversations.send(topic, paragraph, [attachment]);
    hub.conversations.writeConfirmation(topic, randomUUID(), markdown);
  }
  hub.memories.add(paragraph.repeat(4));

  let detail = 0;
  for (const [index, repository] of [...repositories, ...repositories, ...repositories, ...repositories].entries()) {
    const number = index + 1;
    const title = { en: `Improve the garden's weekly maintenance schedule (${number})`, zh: `完善花园的每周维护计划与工作记录（${number}）` };
    const summary = { en: "Prepare the maintenance schedule and review the records at the next meeting.", zh: paragraph.repeat(3) };
    const ticket = hub.tickets.open({
      kind: "feature",
      repository,
      issues: [{ repository, number, title, summary, url: `https://github.com/${repository}/issues/${number}` }],
      title,
      summary,
    });
    if (index === 0) {
      detail = ticket.id;
      hub.tickets.move(ticket.id, "working");
    }
    if (index >= 12) hub.tickets.stop(ticket.id, { en: "Done for this season", zh: "本季的工作已经完成" });
  }
  for (const repository of repositories) hub.repositories.setPinned(repository, true);

  await seedTransfer(url, icon);
  return { ticket: detail, previewName };
}
