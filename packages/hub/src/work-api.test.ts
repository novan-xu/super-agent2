import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeliverInput, type HubToRunner, type MachineReport, protocolVersion, ServerMessage, type Ticket, TicketDetail, TicketResponse, uiConfigFile, type WorkEvent, WorkEventList } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import WebSocket from "ws";
import { type Hub, type HubOptions, scheduleWorkDrain } from "./hub.js";
import type { RunnerLink } from "./runners.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { testCredentials } from "./testing/commands.js";
import { fakeForge, fakeGitHubBase, fakeWoodpeckerServer } from "./testing/forge.js";
import { startTestHub } from "./testing/http.js";

const sandbox = "novan-xu/super-agent-sandbox";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-work-api-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const report: MachineReport = {
  hostname: "pc",
  platform: "win32",
  release: "1",
  arch: "x64",
  user: "owner",
  slots: { total: 2, free: 2 },
  programs: [],
  allowances: [],
};

interface Started {
  readonly running: Hub;
  readonly ticket: Ticket;
  readonly runner: RunnerLink;
  readonly sent: HubToRunner[];
}

async function start(extra: Partial<HubOptions> = {}): Promise<Started> {
  const running = await startTestHub({ config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock, credentials: testCredentials, ...extra });
  hub = running;
  running.machines.add({ name: "pc", accessClientId: "pc.access" });
  const machine = running.machines.get("pc");
  if (machine === undefined) {
    throw new Error("machine missing");
  }
  const sent: HubToRunner[] = [];
  const runner = running.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
  runner.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
  const summary = { en: "Print hello", zh: "打印问候" };
  const opened = running.tickets.open({
    repository: sandbox,
    issues: [{ repository: sandbox, number: 3, url: `https://github.com/${sandbox}/issues/3`, title: { en: "Greet", zh: "问候" }, summary }],
    title: { en: "Greet", zh: "问候" },
    summary,
    kind: "feature",
  });
  running.tickets.change((writes) => {
    writes.choose(opened.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } });
    writes.move(opened.id, "working");
  });
  const ticket = running.tickets.get(opened.id);
  if (ticket === undefined || running.work === undefined) {
    throw new Error("setup failed");
  }
  running.work.begin(ticket);
  return { running, ticket, runner, sent };
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function owner(running: Hub, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), ...(init.headers as Record<string, string> | undefined) },
  });
}

function post(running: Hub, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return owner(running, path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: base(running), ...headers } });
}

function event(runner: RunnerLink, ticket: number, seq: number, body: WorkEvent, attempt = 1): void {
  runner.receive({ type: "work.event", ticket, attempt, seq, at: clock.now(), event: body });
}

describe("a ticket's worker for the page and the brain", () => {
  it("returns a UI hand-in, then merges after the same pull request supplies images and green CI", async () => {
    const forge = fakeForge();
    const { running, ticket, runner, sent } = await start({
      forgeFetch: forge.fetch, gitHubBase: fakeGitHubBase,
      credentials: () => ({ ok: true, credentials: { GH_TOKEN: "github", WOODPECKER_TOKEN: "woodpecker", WOODPECKER_SERVER: fakeWoodpeckerServer } }),
    });
    const first = sent.find((message) => message.type === "work.start");
    if (first === undefined) throw new Error("Missing first attempt");
    const head = "a".repeat(40);
    forge.repository(sandbox).issues.set(3, "open");
    forge.pull(sandbox, 77, head, ["packages/web/src/App.tsx"], first.task.branch, [3]);
    forge.tree(sandbox, head, [".woodpecker/check.yaml"]);
    forge.file(sandbox, head, uiConfigFile, JSON.stringify({ paths: ["packages/web/**"] }));
    forge.woodpecker.set(sandbox, { id: 6, active: true, configFile: "", pipelines: [] });
    const report = { en: "Adjusted the interface", zh: "调整了界面" };
    const finished = { kind: "finished", pullRequest: 77, url: `https://github.com/${sandbox}/pull/77`, report } as const;
    event(runner, ticket.id, 1, finished);
    await running.verification.idle();
    const second = sent.find((message) => message.type === "work.start" && message.task.attempt === 2);
    expect(second).toMatchObject({ task: { branch: first.task.branch, note: expect.stringContaining("after screenshots at phone (390 px) and desktop (1440 px)") } });
    expect(running.tickets.get(ticket.id)).toMatchObject({ state: "working", round: 0, verification: { conflictReturns: 0 } });
    expect(forge.merges).toEqual([]);

    const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfX0AAAAASUVORK5CYII=", "base64");
    const images = (["phone", "desktop"] as const).flatMap((width) => (["before", "after"] as const).map((phase) =>
      ({ view: "history", width, phase, name: `history-${width}-${phase}.png`, mediaType: "image/png" as const, size: data.length })));
    event(runner, ticket.id, 1, { ...finished, screenshots: { head, images, newViews: [] } }, 2);
    expect(running.tickets.get(ticket.id)?.state).toBe("working");
    for (const image of images) {
      const request = sent.filter((message) => message.type === "work.file").at(-1);
      expect(request).toMatchObject({ ticket: ticket.id, attempt: 2, name: image.name, offset: 0, length: data.length });
      runner.receive({ type: "work.file.part", ticket: ticket.id, attempt: 2, name: image.name, offset: 0, data: data.toString("base64"), problem: null });
    }
    await running.verification.idle();
    expect(running.tickets.get(ticket.id)).toMatchObject({ state: "verifying", verification: { waiting: "pipeline" }, round: 0 });
    expect(forge.merges).toEqual([]);

    forge.woodpecker.get(sandbox)?.pipelines.push({
      number: 10, commit: head, ref: "refs/pull/77/merge", event: "pull_request", status: "success",
      workflows: [{ name: "check", state: "success", steps: [{ id: 11, name: "check", state: "success", exitCode: 0 }] }], config: ["check"],
    });
    await running.verification.poll();
    await running.verification.idle();
    expect(forge.merges).toEqual([{ repository: sandbox, number: 77, sha: head, method: "squash" }]);
    const result = TicketDetail.parse(await (await owner(running, `/api/tickets/${ticket.id}`)).json()).ticket;
    expect(result?.state).toBe("merged");
    const stored = result?.pullRequests[0]?.screenshots?.images;
    expect(stored?.map(({ view, width, phase }) => ({ view, width, phase }))).toEqual(images.map(({ view, width, phase }) => ({ view, width, phase })));
    const topic = running.tickets.topic(ticket.id);
    expect(running.conversations.entries(topic)).toContainEqual(expect.objectContaining({
      kind: "notice", screenshots: [{ ticket: ticket.id, pullRequest: 77, images: stored }],
    }));
    const file = await owner(running, `/api/tickets/${ticket.id}/files/${stored?.[0]?.name}`);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(data);
  });

  it("sends the runner its task, and serves the worker's output over HTTP and the page's socket", async () => {
    const { running, ticket, runner, sent } = await start();
    expect(sent.filter((message) => message.type === "work.start")).toHaveLength(1);
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, 2, { kind: "text", block: "b", delta: "Reading the issue" });
    const listed = WorkEventList.parse(await (await owner(running, `/api/tickets/${ticket.id}/work`)).json());
    expect(listed.events.map((entry) => entry.event.kind)).toEqual(["phase", "text"]);
    const after = WorkEventList.parse(await (await owner(running, `/api/tickets/${ticket.id}/work?after=${listed.events[0]?.id ?? 0}`)).json());
    expect(after.events.map((entry) => entry.seq)).toEqual([2]);
    expect((await owner(running, "/api/tickets/99/work")).status).toBe(404);
    const detail = TicketDetail.parse(await (await owner(running, `/api/tickets/${ticket.id}`)).json());
    expect(detail.attempts.map((attempt) => [attempt.attempt, attempt.machine, attempt.engine, attempt.model])).toEqual([[1, "pc", "claude", "claude-haiku-5-5"]]);
    const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    sockets.push(socket);
    const received: ServerMessage[] = [];
    const arrived = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (received.filter((message) => message.type === "work").length >= count) {
            socket.off("message", check);
            resolve();
          }
        };
        socket.on("message", check);
        check();
      });
    socket.on("message", (data) => received.push(ServerMessage.parse(JSON.parse(String(data)))));
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send(JSON.stringify({ type: "watch.ticket", ticket: ticket.id, after: 0 }));
    await arrived(2);
    event(runner, ticket.id, 3, { kind: "text", block: "b", delta: " and writing" });
    await arrived(3);
    const work = received.flatMap((message) => (message.type === "work" ? [message.event] : []));
    expect(work.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(received.some((message) => message.type === "tickets" && message.tickets.some((entry) => entry.work?.state === "running"))).toBe(true);
  });

  it("writes a burst from the runner once it has arrived, in one transaction, and announces every event in order", async () => {
    const { running, ticket, runner } = await start({ workSchedule: scheduleWorkDrain });
    const work = running.work;
    if (work === undefined) {
      throw new Error("no work service");
    }
    const exec = vi.spyOn(running.database.connection, "exec");
    const commits = () => exec.mock.calls.filter(([sql]) => sql === "COMMIT").length;
    const before = commits();
    const announced: { readonly seq: number; readonly commits: number }[] = [];
    const all = new Promise<void>((resolve) => {
      work.subscribe((stored) => {
        announced.push({ seq: stored.seq, commits: commits() });
        if (stored.seq === 50) {
          resolve();
        }
      });
    });
    for (let seq = 1; seq <= 50; seq += 1) {
      event(runner, ticket.id, seq, { kind: "tool.output", call: "c-1", delta: `line ${seq}
` });
    }
    expect(work.events(ticket.id)).toEqual([]);
    await all;
    exec.mockRestore();
    expect(announced.map((entry) => entry.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(new Set(announced.map((entry) => entry.commits)).size).toBe(1);
    expect(announced[0]?.commits).toBeGreaterThan(before);
    expect(work.events(ticket.id).map((stored) => stored.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  });

  it("passes the owner's message to the running worker, with the owner's checks", async () => {
    const { running, ticket, sent } = await start();
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "hi" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "hi" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "" })).status).toBe(400);
    const answer = await post(running, `/api/tickets/${ticket.id}/messages`, { text: "Use the short greeting" });
    expect(answer.status).toBe(202);
    const { id } = (await answer.json()) as { id: string };
    expect(sent.filter((message) => message.type === "work.message")).toEqual([{ type: "work.message", ticket: ticket.id, attempt: 1, id, from: "owner", text: "Use the short greeting" }]);
    const long = "Keep every greeting. ".repeat(10_000);
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: long })).status).toBe(202);
    expect(sent.some((message) => message.type === "work.message" && message.text === long.trim())).toBe(true);
  });

  it("lets the brain message the worker and read its output with the ticket", async () => {
    const { running, ticket, runner, sent } = await start();
    runner.receive({
      type: "work.event", ticket: ticket.id, attempt: 1, seq: 1, at: clock.now() - 60_000,
      event: { kind: "text", block: "b", delta: "Looking at greet.ts" },
    });
    const received = new Date(clock.now()).toISOString();
    clock.advance(60_000);
    const told = await callBrainTool(running, "message_worker", { ticket: ticket.code, text: "Keep it to one line" });
    expect(told.isError).toBe(false);
    expect(sent.filter((message) => message.type === "work.message").map((message) => (message.type === "work.message" ? message.from : ""))).toEqual(["brain"]);
    const read = await callBrainTool(running, "read_ticket", { ticket: ticket.code });
    expect(read.text).toContain("Worker: attempt 1 on pc with claude claude-haiku-5-5 low is preparing");
    expect(read.text).toContain(`Last worker activity: ${received}.`);
    expect(read.text).toContain("Looking at greet.ts");
  });

  it("sends a silent code worker's notice privately to the brain in its topic", async () => {
    let tick: (() => void) | undefined;
    const { running, ticket, runner } = await start({ workTicker: (callback) => {
      tick = callback;
      return () => undefined;
    } });
    const topic = running.tickets.topic(ticket.id);
    const messages: DeliverInput[] = [];
    const brain = running.conversations.attach({
      send: (message) => { if (message.type === "input") messages.push(message); },
      close: () => undefined,
    });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    const before = running.conversations.entries(topic);
    clock.advance(20 * 60_000);
    tick?.();
    expect(messages.filter(({ input }) => input.text.includes("has been silent"))).toMatchObject([
      { conversation: topic, input: { text: expect.stringContaining("Last worker event: phase.") } },
    ]);
    expect(running.conversations.entries(topic)).toEqual(before);
  });

  it("stops a pending ticket for the owner and removes its start card", async () => {
    const running = await startTestHub({ config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock, credentials: testCredentials });
    hub = running;
    const summary = { en: "Pending work", zh: "待办工作" };
    const pending = running.tickets.open({ repository: sandbox, issues: [{ repository: sandbox, number: 3, url: `https://github.com/${sandbox}/issues/3`, title: summary, summary }], title: summary, summary, kind: "feature" });
    expect(running.waiting.cards().some((card) => card.kind === "start" && card.ticket.id === pending.id)).toBe(true);
    const response = await post(running, `/api/tickets/${pending.id}/stop`, {});
    expect(response.status).toBe(202);
    expect(TicketResponse.parse(await response.json()).ticket.state).toBe("stopped");
    expect(running.waiting.cards().some((card) => card.kind === "start" && card.ticket.id === pending.id)).toBe(false);
  });

  it("stops the ticket for the owner, which stops the worker and removes its worktree", async () => {
    const { running, ticket, sent } = await start();
    const answer = await post(running, `/api/tickets/${ticket.id}/stop`, {});
    expect(answer.status).toBe(202);
    const stopped = TicketResponse.parse(await answer.json()).ticket;
    expect(stopped).toMatchObject({ state: "stopped", stopReason: { en: "The owner stopped it", zh: "你停止了它" }, work: { state: "stopped" } });
    expect(sent.filter((message) => message.type === "work.stop")).toEqual([{ type: "work.stop", ticket: ticket.id, save: false, remove: true }]);
    expect((await post(running, `/api/tickets/${ticket.id}/stop`, {})).status).toBe(409);
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "hi" })).status).toBe(409);
  });
});

describe("a writing ticket's delivery", () => {
  it("runs through the same start, delivers into the conversation, and serves the files to the owner only", async () => {
    const running = await startTestHub({ config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock, credentials: testCredentials });
    hub = running;
    running.machines.add({ name: "pc", accessClientId: "pc.access" });
    const machine = running.machines.get("pc");
    if (machine === undefined || running.work === undefined) {
      throw new Error("setup failed");
    }
    const sent: HubToRunner[] = [];
    const runner = running.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
    const withAntigravity: MachineReport = {
      ...report,
      programs: [
        {
          id: "antigravity",
          installed: true,
          path: "agy",
          version: "1.5.10",
          models: [{ id: "gemini-3.8-flash", efforts: ["low", "medium", "high"] }],
          source: "program",
          problem: null,
        },
      ],
    };
    runner.receive({ type: "hello", protocol: protocolVersion, machine: withAntigravity, works: [] });
    const conversation = running.conversations.create();
    running.database.connection.prepare("UPDATE conversations SET repository = ? WHERE id = ?").run(sandbox, conversation.id);
    const updates: string[] = [];
    running.conversations.subscribe((update) => { if (update.type === "entry") updates.push(update.entry.id); });
    const opened = await callBrainTool(
      running,
      "open_task_ticket",
      {
        title: { en: "Translate a notice", zh: "翻译一则通知" },
        summary: { en: "Translate the notice into English", zh: "把通知译成英文" },
        task: "Translate input/notice.txt into English. Keep the tone.",
        kind: "writing",
        material: [{ name: "notice.txt", source: "pasted by the owner in the conversation", text: "你好，世界。" }],
      },
      conversation.id,
    );
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain("Opened task ticket AA-2026-11-17");
    expect(opened.text).toContain("choose_defaults");
    const ticket = running.tickets.get(1);
    expect(ticket).toMatchObject({ kind: "writing", repository: null, issues: [], state: "pending", conversation: conversation.id });
    const stream = async (repository: string) => (await (await owner(running, `/api/stream?repository=${encodeURIComponent(repository)}`)).json()) as { entries: { topic: { id: string }; entry: { id: string; kind: string; text?: string | null; ticket?: number; start?: boolean } }[] };
    const filingTopic = expect.objectContaining({ id: conversation.id });
    expect((await stream(sandbox)).entries).toContainEqual(expect.objectContaining({ topic: filingTopic, entry: expect.objectContaining({ id: "task-card-1", ticket: 1, start: true }) }));
    expect((await stream("")).entries).toEqual([]);
    expect(running.tickets.task(1)).toEqual({
      task: "Translate input/notice.txt into English. Keep the tone.",
      materials: [{ name: "notice.txt", source: "pasted by the owner in the conversation", text: "你好，世界。" }],
      commitRef: null,
      commit: null,
      deploys: false,
    });
    const stated = await callBrainTool(running, "choose_defaults", {
      chains: [{ ticket: "aa", kind: "writing", reason: { en: "A short translation", zh: "一段很短的翻译" }, platform: "any" }],
    });
    expect(stated.isError).toBe(false);
    const card = running.chains.cards().find((entry) => entry.ticket.id === 1);
    expect(card).toMatchObject({ startable: true, choice: { machine: "pc", engine: "antigravity", model: "gemini-3.8-flash", effort: "high", missing: [] } });
    running.tickets.change((writes) => {
      writes.choose(1, { machine: "pc", engine: "antigravity", model: "gemini-3.8-flash", effort: "high", by: { machine: "default", engine: "default", model: "default", effort: "default" } });
      writes.move(1, "working");
    });
    running.work.begin(running.tickets.get(1) ?? (ticket as Ticket));
    expect(sent.filter((message) => message.type === "work.task")).toHaveLength(1);
    event(runner, 1, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, 1, 2, { kind: "text", block: "question", delta: "Which " });
    event(runner, 1, 3, { kind: "text", block: "question", delta: "format?" });
    const progress = (await stream(sandbox)).entries;
    expect(progress).toContainEqual(expect.objectContaining({ topic: filingTopic, entry: expect.objectContaining({ text: "工单 AA 已开始" }) }));
    expect(progress).toContainEqual(expect.objectContaining({ topic: filingTopic, entry: expect.objectContaining({ text: "工单 AA：Which format?", ticket: 1 }) }));
    expect(updates).toContain("task-card-1");
    const question = progress.find(({ entry }) => entry.text === "工单 AA：Which format?");
    expect(updates).toContain(question?.entry.id);
    expect(updates.filter((id) => id === question?.entry.id)).toHaveLength(2);
    event(runner, 1, 4, {
      kind: "delivered",
      text: "Hello, world.\n",
      files: [{ name: "译文.pdf", size: 4, mediaType: "application/pdf" }],
      report: { en: "Translated the notice", zh: "翻译了通知" },
    });
    expect(running.tickets.get(1)?.state).toBe("working");
    expect(sent.filter((message) => message.type === "work.file")).toEqual([{ type: "work.file", ticket: 1, attempt: 1, name: "译文.pdf", offset: 0, length: 4 }]);
    runner.receive({ type: "work.file.part", ticket: 1, attempt: 1, name: "译文.pdf", offset: 0, data: Buffer.from([1, 2, 3, 4]).toString("base64"), problem: null });
    expect(running.tickets.get(1)).toMatchObject({ state: "delivered", pullRequest: null, branch: null });
    const detail = (await (await owner(running, `/api/conversations/${conversation.id}`)).json()) as { entries: { kind: string; ticket?: number; text?: string | null; files?: unknown[] }[] };
    const delivery = detail.entries.find((entry) => entry.kind === "delivery");
    expect(delivery).toMatchObject({ kind: "delivery", ticket: 1, text: "Hello, world.\n", files: [{ name: "译文.pdf", size: 4 }] });
    expect((await stream(sandbox)).entries).toContainEqual(expect.objectContaining({ topic: filingTopic, entry: expect.objectContaining({ kind: "delivery", ticket: 1 }) }));
    const file = await owner(running, `/api/tickets/1/files/${encodeURIComponent("译文.pdf")}`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("译文.pdf")}`);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect((await owner(running, "/api/tickets/1/files/none.pdf")).status).toBe(404);
    expect((await fetch(`${base(running)}/api/tickets/1/files/${encodeURIComponent("译文.pdf")}`)).status).toBeGreaterThanOrEqual(400);
    const events = WorkEventList.parse(await (await owner(running, "/api/tickets/1/work")).json());
    expect(JSON.stringify(events)).not.toContain(Buffer.from([1, 2, 3, 4]).toString("base64"));
    const failed = await callBrainTool(running, "open_task_ticket", {
      title: { en: "Prepare a draft", zh: "准备草稿" }, summary: { en: "Prepare a draft", zh: "准备草稿" }, task: "Prepare a draft.", kind: "writing",
    }, conversation.id);
    expect(failed.isError).toBe(false);
    expect(running.tickets.get(2)?.conversation).toBe(conversation.id);
    running.tickets.change((writes) => {
      writes.choose(2, { machine: "pc", engine: "antigravity", model: "gemini-3.8-flash", effort: "high", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } });
      writes.move(2, "working");
    });
    running.work.begin(running.tickets.get(2)!);
    event(runner, 2, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, 2, 2, { kind: "failed", failure: "task-failed", reason: "The source is missing" });
    expect((await stream(sandbox)).entries).toContainEqual(expect.objectContaining({ topic: filingTopic, entry: expect.objectContaining({ kind: "notice", text: "工单 AB 的执行没有完成，大脑会决定怎么处理" }) }));
    expect((await stream("")).entries).toEqual([]);
  });
});
