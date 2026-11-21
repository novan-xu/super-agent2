import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  task: "Find or ingest the given video, wait for the job, read passages and save an article in Agent_wring.",
  kind: "operation",
  engine: "codex",
  mode: "agent_wring",
};
const report = { en: "Done", zh: "已完成" };
const mac: MachineReport = {
  hostname: "mac", platform: "darwin", arch: "arm64", release: "1", user: "owner", slots: { total: 2, free: 2 },
  programs: [
    { id: "antigravity", installed: true, path: "agy", version: "1", models: startingEngineTable.antigravity.map(({ model, effort }) => ({ id: model, efforts: [effort] })), source: "program", problem: null },
    { id: "codex", installed: true, path: "codex", version: "1", models: [{ id: startingEngineTable.codex.standard.model, efforts: [startingEngineTable.codex.standard.effort] }], source: "program", problem: null },
    { id: "claude", installed: true, path: "claude", version: "1", models: [{ id: startingEngineTable.claude.standard.model, efforts: [startingEngineTable.claude.standard.effort] }], source: "program", problem: null },
  ],
  allowances: [],
};

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-light-tasks-"));
  key = await signingKey("key-1");
  clock = new TestClock();
  hub = await startTestHub({
    config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock,
    environment: {
      HUB_EXTRA_MCP_SERVERS: JSON.stringify([{ name: "Agent_wring", url: "http://worker/mcp", secret: "WRING_TOKEN", brain: true, workers: true }]),
      WRING_TOKEN: "example-token",
    },
  });
});

afterEach(async () => {
  await hub?.close();
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

  it.each([false, true])("quietly delivers a project operation in its repository topic (already assigned: %s)", async (assigned) => {
    const project = "owner/repository";
    const { link } = connectBrain();
    const run = connectRunner();
    const topic = hub.conversations.create().id;
    if (assigned) {
      const scope = turn(link, topic, [owner(topic, "看看这个仓库")]);
      expect((await scope.call("set_topic_repository", { repository: project })).isError).toBe(false);
      scope.finish();
    }
    const request = turn(link, topic, [owner(topic, "处理仓库配置")]);
    expect((await request.call("start_light_task", { ...operation, mode: "transfer", project })).isError).toBe(false);
    expect((await request.call("start_light_task", { ...operation, mode: "transfer", project })).isError).toBe(false);
    request.finish();
    expect(hub.conversations.get(topic)?.repository).toBe(project);
    const sends = run.sent.filter((message) => message.type === "work.task");
    expect(sends).toMatchObject([{ task: { light: true, checkout: null, deploys: false, engine: "codex", environment: {} } }]);
    const started = sends[0]!.task.ticket;
    expect(hub.tickets.get(started)).toMatchObject({ project, repository: null, conversation: topic });
    run.show(started, 1, { kind: "delivered", text: "Configuration checked.", files: [], report });
    expect(entries(topic, project).at(-1)).toMatchObject({ kind: "delivery", light: true, text: "Configuration checked." });
    expect(entries(topic)).toEqual([]);
    expect(await (await get("/api/tickets")).json()).toEqual({ tickets: [] });
    expect(hub.waiting.cards()).toEqual([]);
  });

  it("refuses a project task when conflicting work was filed in the same topic", async () => {
    const { link } = connectBrain();
    const topic = hub.conversations.create().id;
    const request = turn(link, topic, [owner(topic, "处理这些工作")]);
    expect((await request.call("open_task_ticket", { title: writing.title, summary: writing.summary, task: writing.task, kind: "writing" })).isError).toBe(false);
    expect((await request.call("start_light_task", { ...operation, project: "owner/repository" })).isError).toBe(true);
    request.finish();
    expect(hub.conversations.get(topic)?.repository).toBeNull();
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
    expect(starts()[2]).toMatchObject({ attempt: 3, engine: "claude", model: startingEngineTable.claude.standard.model });
    expect(hub.defaults.resolve(ticket)).toMatchObject({ engine: "claude" });
    expect(hub.tickets.get(ticket.id)).toMatchObject({ state: "working", machine: "mac", round: 0 });
    expect(hub.tickets.switches(ticket.id)).toMatchObject([
      { kind: "switched", from: "antigravity", fromModel: "gemini-4-hydrogen", to: "antigravity", model: "gemini-3.8-flash", machine: "mac", reason: "Gemini quota reached" },
      { kind: "switched", from: "antigravity", fromModel: "gemini-3.8-flash", to: "claude", machine: "mac", reason: "Gemini quota reached" },
    ]);
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
      type: "work.task", task: expect.objectContaining({ ticket: ticket.id, engine: "codex", extraMcp: [expect.objectContaining({ name: "Agent_wring" })] }),
    }));
    run.show(ticket.id, 1, {
      kind: "delivered", text: null,
      report: { en: "Saved Example Video in Agent_wring", zh: "已在 Agent_wring 保存 Example Video。" },
      files: [{ name: "library-export.md", size: 5, mediaType: "text/markdown" }],
    });
    expect(run.sent.some((message) => message.type === "work.file")).toBe(false);
    expect(entries(topic).at(-1)).toMatchObject({ kind: "delivery", report: { zh: expect.stringContaining("Example Video") }, files: [] });
    expect(await (await get(transferPath)).json()).toMatchObject({ items: [] });
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
