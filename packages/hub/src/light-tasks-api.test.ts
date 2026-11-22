import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startingEngineTable, filePartBytes, protocolVersion, ticketReference, type BrainInput, type HubToRunner, type MachineReport, type WorkEvent } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrainLink } from "./conversations.js";
import type { Hub } from "./hub.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { requestBrainTool } from "./testing/brain-tools.js";
import { startTestHub } from "./testing/http.js";

const writing = {
  title: { en: "Write an email", zh: "写一封邮件" },
  summary: { en: "Draft a thank-you email", zh: "起草感谢邮件" },
  task: "Write a short thank-you email in English.",
  kind: "writing",
  reason: { en: "A short draft", zh: "简短的草稿" },
};
const operation = {
  ...writing,
  title: { en: "Save the video", zh: "保存视频" },
  task: "Find or ingest the given video and wait for the job in Agent_wring.",
  kind: "operation",
  mode: "agent_wring",
};
const article = {
  ...writing,
  title: { en: "Write an article from the video", zh: "根据视频写文章" },
  task: "Search Agent_wring first, read relevant passages and the article guide, and save the finished HTML with save_article.",
  mode: "agent_wring",
};
const product = "cc992985d3ce4559";
const otherProduct = "3e6ebf3ab533a184";
const savedHtml = '<!doctype html><html lang="zh-CN"><title>文章</title><p>原文</p></html>';
const report = { en: "Done", zh: "已完成" };
const mac: MachineReport = {
  hostname: "mac", platform: "darwin", arch: "arm64", release: "1", user: "owner", slots: { total: 2, free: 2 },
  programs: [
    { id: "antigravity", installed: true, path: "agy", version: "1", models: startingEngineTable.antigravity.map(({ model, effort }) => ({ id: model, efforts: [effort] })), source: "program", problem: null },
    { id: "dsh", installed: true, path: "dsh", version: "1", models: [{ id: startingEngineTable.dsh.standard.model, efforts: [startingEngineTable.dsh.standard.effort] }], source: "program", problem: null },
    { id: "codex", installed: true, path: "codex", version: "1", models: [{ id: startingEngineTable.codex.standard.model, efforts: [startingEngineTable.codex.standard.effort] }], source: "program", problem: null },
    { id: "claude", installed: true, path: "claude", version: "1", models: [{ id: startingEngineTable.claude.standard.model, efforts: [startingEngineTable.claude.standard.effort] }], source: "program", problem: null },
  ],
  allowances: [],
};

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub;
let articleServer: Server;
let wringUrl: string;
let replyArticle: RequestListener;
let articleRequests: { path: string | undefined; authorization: string | undefined }[];

async function startHub() {
  hub = await startTestHub({
    config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock,
    environment: {
      HUB_EXTRA_MCP_SERVERS: JSON.stringify([{ name: "agent_wring", url: wringUrl, secret: "WRING_TOKEN", brain: true, workers: true }]),
      WRING_TOKEN: "example-token",
    },
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-light-tasks-"));
  key = await signingKey("key-1");
  clock = new TestClock();
  articleRequests = [];
  replyArticle = (_request, response) => response.writeHead(404).end();
  articleServer = createServer((request, response) => {
    articleRequests.push({ path: request.url, authorization: request.headers.authorization });
    replyArticle(request, response);
  });
  await new Promise<void>((resolve) => articleServer.listen(0, "127.0.0.1", resolve));
  const address = articleServer.address();
  if (address === null || typeof address === "string") throw new Error("Could not start the test article server");
  wringUrl = `http://127.0.0.1:${address.port}/library/mcp/`;
  await startHub();
});

afterEach(async () => {
  await hub?.close();
  await new Promise<void>((resolve) => {
    articleServer.close(() => resolve());
    articleServer.closeAllConnections();
  });
  rmSync(dataDir, { recursive: true, force: true });
});

function connectBrain() {
  const inputs: BrainInput[] = [];
  const link = hub.conversations.attach({
    send: (message) => { if (message.type === "input") inputs.push(message.input); }, close: () => undefined,
  });
  link.receive({ type: "hello", protocol: protocolVersion, running: [] });
  return { link, inputs };
}

function turn(brain: BrainLink, conversation: string, inputs: string[] = []) {
  const scope = { conversation, turn: randomUUID() };
  brain.receive({ type: "turn.started", ...scope, provider: "gpt", model: "test", inputs });
  return {
    scope,
    call: (name: string, args: Record<string, unknown>) => requestBrainTool(hub, name, args, scope),
    finish: () => brain.receive({ type: "turn.finished", ...scope, outcome: "completed", reason: null }),
  };
}

function owner(topic: string, message: string): string {
  const entry = hub.conversations.send(topic, message);
  if (entry === undefined) throw new Error("The test owner message was not stored");
  return entry.id;
}

async function agreed(brain: BrainLink, topic: string, args: Record<string, unknown> = writing) {
  const request = turn(brain, topic, [owner(topic, "帮我处理这件事")]);
  const result = await request.call("start_light_task", args);
  expect(result.isError, result.text).toBe(false);
  request.finish();
  const ticket = hub.tickets.list().find((candidate) => candidate.conversation === topic && candidate.light !== undefined);
  if (ticket === undefined) throw new Error("The light task was not opened");
  return ticket;
}

function connectRunner() {
  hub.machines.add({ name: "mac", accessClientId: "mac.access" });
  const machine = hub.machines.get("mac");
  if (machine === undefined) throw new Error("The test machine was not stored");
  const sent: HubToRunner[] = [];
  const runner = hub.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
  runner.receive({ type: "hello", protocol: protocolVersion, machine: mac, works: [] });
  const sequences = new Map<string, number>();
  const show = (ticket: number, attempt: number, event: WorkEvent) => {
    const key = `${ticket}:${attempt}`;
    const seq = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, seq);
    runner.receive({ type: "work.event", ticket, attempt, seq, at: clock.now(), event });
  };
  return { sent, runner, show };
}

const transferPath = "/api/transfer";

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${hub.address.port}${path}`, {
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), ...headers },
  });
}

function entries(topic: string, project?: string) {
  return hub.conversations.stream(Number.MAX_SAFE_INTEGER, 50, project === undefined ? { kind: "daily" } : { kind: "repository", repository: project }).entries
    .filter((item) => item.topic.id === topic).map((item) => item.entry);
}

describe("light tasks", () => {
  it("requires an owner message in the active turn and starts multiple distinct requests without confirmation", async () => {
    const { link } = connectBrain();
    const topic = hub.conversations.create().id;
    const synthetic = turn(link, topic);
    expect(await synthetic.call("start_light_task", writing)).toMatchObject({ isError: true, text: expect.stringContaining("owner message") });
    synthetic.finish();
    const request = turn(link, topic, [owner(topic, "处理两件事")]);
    expect((await request.call("start_light_task", writing)).isError).toBe(false);
    expect((await request.call("start_light_task", writing)).isError).toBe(false);
    expect((await request.call("start_light_task", { ...writing, task: "Write another email." })).isError).toBe(false);
    request.finish();
    expect(hub.tickets.list()).toHaveLength(2);
    expect(entries(topic).map((entry) => entry.kind)).toEqual(["owner"]);
  });

  it("rejects checkout and deployment inputs and leaves the ordinary task flow available", async () => {
    const { link } = connectBrain();
    const topic = hub.conversations.create().id;
    const request = turn(link, topic, [owner(topic, "处理仓库")]);
    expect((await request.call("start_light_task", { ...writing, repository: "owner/repository" })).isError).toBe(true);
    expect((await request.call("start_light_task", { ...operation, project: "owner/repository", deploy: true })).isError).toBe(true);
    const normal = await request.call("open_task_ticket", { title: writing.title, summary: writing.summary, task: writing.task, kind: "writing" });
    expect(normal.isError, normal.text).toBe(false);
    expect(hub.waiting.cards()).toMatchObject([{ kind: "start" }]);
    expect(entries(topic)).toContainEqual(expect.objectContaining({ kind: "notice", start: true }));
    request.finish();

    const code = hub.conversations.create().id;
    const scope = turn(link, code, [owner(code, "在这个仓库部署")]);
    expect((await scope.call("set_topic_repository", { repository: "owner/repository" })).isError).toBe(false);
    expect(await scope.call("start_light_task", writing)).toMatchObject({ isError: true, text: expect.stringContaining("daily topic") });
    scope.finish();
  });

  it.each([undefined, "owner/repository"])("quietly delivers a project operation without changing the topic repository (%s)", async (topicRepository) => {
    const project = "owner/repository";
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    if (topicRepository !== undefined) {
      const scope = turn(link, topic, [owner(topic, "看看这个仓库")]);
      expect((await scope.call("set_topic_repository", { repository: topicRepository.toUpperCase() })).isError).toBe(false);
      scope.finish();
    }
    const request = turn(link, topic, [owner(topic, "处理仓库配置")]);
    if (topicRepository !== undefined) {
      expect((await request.call("start_light_task", { ...operation, project: "owner/elsewhere" })).isError).toBe(true);
    }
    expect((await request.call("start_light_task", { ...operation, mode: "transfer", project })).isError).toBe(false);
    expect((await request.call("start_light_task", { ...operation, mode: "transfer", project })).isError).toBe(false);
    request.finish();
    expect(hub.conversations.get(topic)?.repository).toBe(topicRepository?.toUpperCase() ?? null);
    const sends = run.sent.filter((message) => message.type === "work.task");
    expect(sends).toMatchObject([{ task: { light: true, checkout: null, deploys: false, engine: "codex", environment: {} } }]);
    const started = sends[0]!.task.ticket;
    expect(hub.tickets.get(started)).toMatchObject({ project, repository: null, conversation: topic });
    run.show(started, 1, { kind: "delivered", text: "Configuration checked.", files: [], report });
    expect(entries(topic, topicRepository).at(-1)).toMatchObject({ kind: "delivery", light: true, text: "Configuration checked." });
    expect(entries(topic, topicRepository === undefined ? project : undefined)).toEqual([]);
    expect(await (await get("/api/tickets")).json()).toEqual({ tickets: [] });
    expect(hub.waiting.cards()).toEqual([]);
  });

  it.each([undefined, "claude"] as const)("runs an operation using the worker order or the owner's engine %s", async (ownerEngine) => {
    const { link } = connectBrain();
    const run = connectRunner();
    hub.settings.setOrder("worker", ["deepseek", "gpt", "claude"]);
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, { ...operation, engine: "codex", ownerEngine });
    expect(ticket).toMatchObject({ engine: ownerEngine ?? "dsh", brainEngine: null, chosenBy: { engine: ownerEngine === undefined ? "default" : "owner" } });
    expect(run.sent.filter((message) => message.type === "work.task")).toMatchObject([{ task: { engine: ownerEngine ?? "dsh" } }]);
  });

  it("accepts a light task with a project alongside unrelated daily work", async () => {
    const { link } = connectBrain();
    const topic = hub.conversations.create().id;
    const request = turn(link, topic, [owner(topic, "处理这些工作")]);
    expect((await request.call("open_task_ticket", { title: writing.title, summary: writing.summary, task: writing.task, kind: "writing" })).isError).toBe(false);
    expect((await request.call("start_light_task", { ...operation, project: "owner/repository" })).isError).toBe(false);
    request.finish();
    expect(hub.conversations.get(topic)?.repository).toBeNull();
  });

  it("moves a topic with labeled and unlabeled light tasks, but refuses a conflicting code ticket", async () => {
    const { link } = connectBrain();
    const topic = hub.conversations.create().id;
    const request = turn(link, topic, [owner(topic, "处理这些工作")]);
    expect((await request.call("start_light_task", writing)).isError).toBe(false);
    expect((await request.call("start_light_task", { ...operation, project: "owner/old" })).isError).toBe(false);

    for (const repository of ["owner/old", null, "owner/new"]) {
      expect((await request.call("set_topic_repository", { repository })).isError).toBe(false);
      expect(hub.conversations.get(topic)?.repository).toBe(repository);
    }

    const repository = "owner/old";
    hub.tickets.open({
      repository, conversation: topic, kind: "feature", title: writing.title, summary: writing.summary,
      issues: [{ repository, number: 1, url: `https://github.com/${repository}/issues/1`, title: writing.title, summary: writing.summary }],
    });
    expect(await request.call("set_topic_repository", { repository: null })).toMatchObject({ isError: true, text: expect.stringContaining("tickets") });
    expect(hub.conversations.get(topic)?.repository).toBe("owner/new");
    request.finish();
  });

  it("waits offline, starts once when a runner returns, and delivers text only in the topic", async () => {
    const { link } = connectBrain();
    const topic = hub.conversations.create().id;
    const answer = turn(link, topic, [owner(topic, "帮我写邮件")]);
    expect(await answer.call("start_light_task", writing)).toMatchObject({ isError: false, text: expect.stringContaining("is waiting") });
    expect((await answer.call("start_light_task", writing)).isError).toBe(false);
    answer.finish();
    expect(hub.tickets.list()).toMatchObject([{ light: "transfer", state: "waiting" }]);
    const run = connectRunner();
    await hub.chains.idle();
    const calls = run.sent.filter((message) => message.type === "work.task");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toMatchObject({ light: true, checkout: null, engine: "antigravity", model: "gemini-4-hydrogen", effort: "high" });
    const started = calls[0];
    if (started === undefined) throw new Error("The worker was not started");
    const ticket = started.task.ticket;
    expect(await (await get("/api/tickets?scope=open")).json()).toEqual({ tickets: [] });
    expect(hub.waiting.cards()).toEqual([]);
    run.show(ticket, 1, { kind: "phase", phase: "started", detail: "The worker started" });
    run.show(ticket, 1, { kind: "text", block: "progress", delta: "Internal worker output" });
    run.show(ticket, 1, { kind: "delivered", text: "Thank you for your help.", files: [], report });
    expect(entries(topic).map((entry) => entry.kind)).toEqual(["owner", "delivery"]);
    expect(entries(topic).at(-1)).toMatchObject({ kind: "delivery", light: true, text: "Thank you for your help." });
    expect(hub.waiting.cards()).toEqual([]);
    expect(await (await get("/api/tickets")).json()).toEqual({ tickets: [] });
    expect(hub.tickets.history().tickets).toEqual([]);
    expect(await (await get(transferPath)).json()).toMatchObject({ items: [] });
  });

  it("starts on Hydrogen, continues on Flash, and falls back to code only after both hit quota", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const ticket = await agreed(link, hub.conversations.create().id);
    await hub.chains.idle();
    const starts = () => run.sent.filter((message) => message.type === "work.task").map((message) => message.task);
    expect(starts()).toMatchObject([{ attempt: 1, engine: "antigravity", model: "gemini-4-hydrogen", effort: "high" }]);
    run.show(ticket.id, 1, { kind: "phase", phase: "started", detail: "The worker started" });
    run.show(ticket.id, 1, { kind: "session", session: "hydrogen-session" });
    run.show(ticket.id, 1, { kind: "text", block: "draft", delta: "The first draft" });
    run.show(ticket.id, 1, { kind: "unavailable", category: "limit", reason: "Gemini quota reached", until: null, unsent: [] });
    expect(starts()[1]).toMatchObject({ attempt: 2, engine: "antigravity", model: "gemini-3.8-flash", effort: "high", session: null, takeover: true, note: expect.stringContaining("The first draft") });
    expect(hub.defaults.unavailable()).toEqual([]);
    expect(hub.defaults.resolve(ticket)).toMatchObject({ engine: "antigravity", model: "gemini-3.8-flash" });

    run.show(ticket.id, 2, { kind: "phase", phase: "started", detail: "The worker started" });
    run.show(ticket.id, 2, { kind: "unavailable", category: "limit", reason: "Gemini quota reached", until: null, unsent: [] });
    expect(starts()[2]).toMatchObject({ attempt: 3, engine: "codex", model: startingEngineTable.codex.standard.model });
    expect(hub.defaults.resolve(ticket)).toMatchObject({ engine: "codex" });
    expect(hub.tickets.get(ticket.id)).toMatchObject({ state: "working", machine: "mac", round: 0 });
    expect(hub.tickets.switches(ticket.id)).toMatchObject([
      { kind: "switched", from: "antigravity", fromModel: "gemini-4-hydrogen", to: "antigravity", model: "gemini-3.8-flash", machine: "mac", reason: "Gemini quota reached" },
      { kind: "switched", from: "antigravity", fromModel: "gemini-3.8-flash", to: "codex", machine: "mac", reason: "Gemini quota reached" },
    ]);
  });

  it("renders delivered ticket HTML through the isolated route", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic);
    const html = "<style>body { background: rgb(1, 2, 3) }</style>中文";
    const bytes = Buffer.from(html);
    run.show(ticket.id, 1, { kind: "delivered", text: "Ready.", files: [{ name: "page.html", size: bytes.length, mediaType: "text/html" }], report });
    run.runner.receive({ type: "work.file.part", ticket: ticket.id, attempt: 1, name: "page.html", offset: 0, data: bytes.toString("base64"), problem: null });
    const response = await get(`/api/tickets/${ticket.id}/files/page.html/render`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(await response.text()).toBe(html);
    expect((await get(`/api/tickets/${ticket.id}/files/missing.html/render`)).status).toBe(404);
  });

  it("stores a file larger than 100 MiB and over 30 files together in transfer and the reply", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic);
    const bytes = 100 * 1024 * 1024 + 1;
    const file = { name: "large.bin", size: bytes, mediaType: "application/octet-stream" };
    const files = [file, ...Array.from({ length: 30 }, (_, index) => ({ ...file, name: `empty-${index}.bin`, size: 0 }))];
    run.show(ticket.id, 1, { kind: "delivered", text: "Files are ready.", files, report });
    const fullPart = Buffer.alloc(filePartBytes, 42).toString("base64");
    for (let offset = 0; offset < bytes; offset += filePartBytes) {
      expect(run.sent.at(-1)).toMatchObject({ type: "work.file", name: file.name, offset });
      run.runner.receive({
        type: "work.file.part", ticket: ticket.id, attempt: 1, name: file.name, offset,
        data: bytes - offset < filePartBytes ? Buffer.alloc(bytes - offset, 42).toString("base64") : fullPart, problem: null,
      });
    }
    const delivery = entries(topic).at(-1);
    expect(delivery).toMatchObject({ kind: "delivery", light: true, text: "Files are ready.", files: [{ name: file.name, size: bytes }, ...files.slice(1).map(({ name, size }) => ({ name, size }))] });
    const transfer = await (await get(transferPath)).json() as { items: { title: string; files: { id: string }[] }[] };
    expect(transfer.items).toMatchObject([{ title: writing.title.zh, text: "Files are ready.", files }]);
    const id = transfer.items[0]?.files[0]?.id;
    for (const url of [`${transferPath}/files/${id}`, `/api/tickets/${ticket.id}/files/${file.name}`]) {
      const response = await get(url, { range: `bytes=${bytes - 1}-${bytes - 1}` });
      expect(response.status).toBe(206);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(42));
    }
  });

  it("accepts a spoken stop in its topic and ends the worker with one reply", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic);
    const args = { ticket: ticketReference(ticket), reason: { en: "Stopped", zh: "已停止。" } };
    const stop = turn(link, topic, [owner(topic, "不用了，停一下")]);
    expect((await stop.call("read_ticket", { ticket: args.ticket })).isError).toBe(false);
    expect((await stop.call("stop_ticket", args)).isError).toBe(false);
    stop.finish();
    expect(hub.tickets.get(ticket.id)?.state).toBe("stopped");
    expect(run.sent).toContainEqual({ type: "work.stop", ticket: ticket.id, save: false, remove: true });
    expect(entries(topic).filter((entry) => entry.kind === "notice")).toMatchObject([{ text: "任务「写一封邮件」已停止。" }]);
  });

  it("runs Agent_wring on the worker and only replies with the library result", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, operation);
    expect(run.sent).toContainEqual(expect.objectContaining({
      type: "work.task", task: expect.objectContaining({ ticket: ticket.id, engine: "codex", extraMcp: [expect.objectContaining({ name: "agent_wring" })] }),
    }));
    const libraryReport = { en: "Saved Example Video in Agent_wring", zh: "已在 Agent_wring 保存 Example Video。" };
    run.show(ticket.id, 1, {
      kind: "delivered", text: "Video is available.", report: libraryReport,
      files: [{ name: "library-export.md", size: 5, mediaType: "text/markdown" }],
    });
    expect(run.sent.some((message) => message.type === "work.file")).toBe(false);
    expect(entries(topic).at(-1)).toMatchObject({ kind: "delivery", text: `${libraryReport.zh}\n\nVideo is available.`, report: libraryReport, files: [] });
    expect(await (await get(transferPath)).json()).toMatchObject({ items: [] });
    expect(articleRequests).toEqual([]);
  });

  it("writes Agent_wring articles on the ordered Antigravity models and hands off to a code engine when the provider is out", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, article);
    await hub.chains.idle();
    const assignment = { task: article.task, agentWringArticle: true, extraMcp: [{ name: "agent_wring", url: wringUrl, token: "example-token" }] };
    const starts = () => run.sent.filter((message) => message.type === "work.task").map((message) => message.task);
    expect(starts()).toMatchObject([{ ...assignment, attempt: 1, engine: "antigravity", model: "gemini-4-hydrogen", effort: "high" }]);
    run.show(ticket.id, 1, { kind: "unavailable", category: "limit", reason: "Gemini quota reached", until: null, unsent: [] });
    expect(starts()[1]).toMatchObject({ ...assignment, attempt: 2, engine: "antigravity", model: "gemini-3.8-flash", effort: "high" });
    run.show(ticket.id, 2, { kind: "unavailable", category: "problem", reason: "Sign in required", until: null, unsent: [] });
    expect(starts()[2]).toMatchObject({ ...assignment, attempt: 3, engine: "codex" });
  });

  it("retries a transient fetch and delivers only the saved HTML in the topic and transfer", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, article);
    replyArticle = (_request, response) => {
      if (articleRequests.length === 1) response.writeHead(503).end();
      else response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(savedHtml);
    };
    run.show(ticket.id, 1, { kind: "delivered", products: [product], text: "Worker summary", report, files: [{ name: "draft.md", size: 5, mediaType: "text/markdown" }] });

    const name = `${product}.html`;
    const size = Buffer.byteLength(savedHtml);
    await expect.poll(() => entries(topic).at(-1), { timeout: 5_000 }).toMatchObject({
      kind: "delivery", light: true, title: article.title, text: null, report: null, files: [{ name, size }],
    });
    expect(hub.tickets.get(ticket.id)).toMatchObject({ state: "delivered", report });
    expect(run.sent.some((message) => message.type === "work.file")).toBe(false);
    const request = { path: `/library/products/${product}/article.html`, authorization: "Bearer example-token" };
    expect(articleRequests).toEqual([request, request]);
    const transfer = await (await get(transferPath)).json() as { items: { files: { id: string }[] }[] };
    expect(transfer.items).toMatchObject([{ title: article.title.zh, text: "", files: [{ name, size }] }]);
    const id = transfer.items[0]?.files[0]?.id;
    for (const path of [`/api/tickets/${ticket.id}/files/${name}`, `${transferPath}/files/${id}`]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(savedHtml));
    }
    const preview = await get(`/api/tickets/${ticket.id}/files/${name}/render`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe(savedHtml);
  });

  it("delivers duplicate UTF-8 article names separately and serves downloads and previews", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, article);
    const name = "文章：标题.html";
    replyArticle = (_request, response) => response.writeHead(200, {
      "content-type": "text/html",
      "content-disposition": `inline; filename="fallback.html"; filename*=UTF-8''${encodeURIComponent(name)}`,
    }).end(savedHtml);
    run.show(ticket.id, 1, { kind: "delivered", products: [product, otherProduct], text: null, report, files: [] });
    const names = [name, "文章：标题 (2).html"];
    await expect.poll(() => entries(topic).at(-1), { timeout: 5_000 }).toMatchObject({ files: names.map((fileName) => ({ name: fileName })) });
    for (const fileName of names) {
      const path = `/api/tickets/${ticket.id}/files/${encodeURIComponent(fileName)}`;
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      expect(await response.text()).toBe(savedHtml);
      const preview = await get(`${path}/render`);
      expect(preview.status).toBe(200);
      expect(await preview.text()).toBe(savedHtml);
    }
  });

  it("ends a failed article fetch through the light-task retry flow without delivering a partial result", async () => {
    const { link, inputs } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, article);
    replyArticle = (request, response) => {
      if (request.url === `/library/products/${product}/article.html`) response.writeHead(200, { "content-type": "text/html" }).end(savedHtml);
      else response.writeHead(404).end();
    };
    run.show(ticket.id, 1, { kind: "delivered", products: [product, otherProduct], text: "Worker summary", report, files: [] });

    const reason = `Agent_wring article ${otherProduct} could not be fetched: HTTP 404`;
    await expect.poll(() => hub.tickets.get(ticket.id), { timeout: 5_000 }).toMatchObject({
      work: { state: "failed", failure: "lost", reason: expect.stringContaining(reason) },
    });
    expect(inputs.at(-1)?.text).toContain(reason);
    expect(inputs.at(-1)?.text).toContain("guide_ticket");
    expect(articleRequests.map(({ path }) => path)).toEqual([product, otherProduct, otherProduct, otherProduct].map((id) => `/library/products/${id}/article.html`));
    expect(entries(topic).map((entry) => entry.kind)).toEqual(["owner"]);
    expect(await (await get(transferPath)).json()).toMatchObject({ items: [] });
    expect((await get(`/api/tickets/${ticket.id}/files/${product}.html`)).status).toBe(404);
  });

  it("rejects an older runner's article hand-back without a product ID", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, article);
    run.show(ticket.id, 1, { kind: "delivered", text: "Worker summary", report, files: [] });

    expect(hub.tickets.get(ticket.id)).toMatchObject({ work: { state: "failed", reason: expect.stringContaining("product IDs") } });
    expect(entries(topic).map((entry) => entry.kind)).toEqual(["owner"]);
    expect(articleRequests).toEqual([]);
  });

  it("resumes the stored hand-back after a hub restart and delivers all saved articles without a runner", async () => {
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic, article);
    replyArticle = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).write("Partial HTML");
    };
    run.show(ticket.id, 1, { kind: "delivered", products: [product, otherProduct], text: null, report, files: [] });
    await expect.poll(() => articleRequests.length).toBe(1);
    await hub.close();

    replyArticle = (_request, response) => response.writeHead(200, { "content-type": "text/html" }).end(savedHtml);
    await startHub();
    await expect.poll(() => entries(topic).filter((entry) => entry.kind === "delivery"), { timeout: 5_000 }).toMatchObject([{
      files: [product, otherProduct].map((id) => ({ name: `${id}.html`, size: Buffer.byteLength(savedHtml) })), text: null, report: null,
    }]);
    expect(hub.tickets.get(ticket.id)).toMatchObject({ state: "delivered", work: { attempt: 1, state: "finished" } });
    expect(await (await get(`/api/tickets/${ticket.id}/files/${product}.html`)).text()).toBe(savedHtml);
  });

  it("shows a worker question as a message and forwards the owner's answer once", async () => {
    const { link, inputs } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic);
    const internal = { ticket: ticketReference(ticket) };
    const question = "邮件收件人是谁？";
    run.show(ticket.id, 1, { kind: "question", id: randomUUID(), text: question });
    expect(entries(topic).at(-1)).toMatchObject({ kind: "notice", text: question });
    const empty = turn(link, topic);
    expect((await empty.call("answer_light_task", internal)).isError).toBe(true);
    empty.finish();
    const answer = turn(link, topic, [owner(topic, "给 Maya")]);
    expect(inputs.at(-1)?.text).toContain(question);
    const response = await answer.call("answer_light_task", internal);
    expect(response.isError, response.text).toBe(false);
    expect((await answer.call("answer_light_task", internal)).isError).toBe(true);
    answer.finish();
    expect(run.sent.filter((message) => message.type === "work.message")).toMatchObject([{ from: "owner", text: "给 Maya" }]);
  });

  it("guides three rounds privately and publishes a single final failure line", async () => {
    const { link, inputs } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    const ticket = await agreed(link, topic);
    const reference = ticketReference(ticket);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      run.show(ticket.id, attempt, { kind: "delivered", outcome: "failed", text: null, files: [], report: { en: "No result", zh: "没有结果" } });
      if (attempt === 4) break;
      const input = inputs.at(-1);
      if (input === undefined) throw new Error("The hub did not ask the brain to guide the retry");
      expect(input.text).toContain("guide_ticket");
      expect(entries(topic).map((entry) => entry.kind)).toEqual(["owner"]);
      const guidance = turn(link, topic, [input.id]);
      link.receive({ type: "text", ...guidance.scope, block: "internal", delta: "Internal failure detail" });
      expect((await guidance.call("read_ticket", { ticket: reference })).isError).toBe(false);
      const retry = await guidance.call("guide_ticket", { ticket: reference, guidance: { en: "Try using the available material", zh: "使用现有材料重试" } });
      expect(retry.isError, retry.text).toBe(false);
      guidance.finish();
    }
    expect(hub.tickets.get(ticket.id)).toMatchObject({ state: "stopped", round: 3 });
    expect(entries(topic).filter((entry) => entry.kind === "notice")).toMatchObject([{ text: "任务「写一封邮件」未能完成。" }]);
    expect(hub.conversations.detail(topic)?.turns).toHaveLength(1);
    expect(hub.waiting.cards()).toEqual([]);
  });
});
