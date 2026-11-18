import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintOf, type Hub, type Job, type Target } from "@super-agent2/hub";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, startTestHub, TestClock, testConfig, testCredentials } from "@super-agent2/hub/testing";
import {
  brainToolsPath,
  type Conversation,
  type ConversationDetail,
  ConversationDetail as DetailShape,
  ConversationList,
  conversationHeader,
  turnHeader,
  MemoryList,
  type Provider,
  quoteChunkLimit,
  quoteInlineLimit,
  StreamEntry,
  type StreamMessage,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Brain, createBrain } from "./brain.js";
import { createHubLink, type HubLink, type Schedule } from "./link.js";
import type { OpenOptions } from "@super-agent2/programs";
import { FakeProgram } from "./testing/fake.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
let brain: Brain | undefined;
let link: HubLink | undefined;
let token: string;
let port: number;
let jobs: Job[];
let retries: (() => void)[];
let autoRetry: boolean;
let programs: Record<Provider, FakeProgram>;

const pullRequests = "#29\tAdd the Chinese presentation\tclaude/issue-22\n#28\tAdd the confirmation lock\tclaude/issue-4\n";

function scriptedTarget(): Target {
  return {
    name: "hub",
    run: (job, output) => {
      jobs.push(job);
      if (job.command.startsWith("gh pr list")) {
        output("stdout", Buffer.from(pullRequests));
      }
      return { ended: Promise.resolve({ exitCode: 0, signal: null }), stop: () => Promise.resolve() };
    },
  };
}

function drainRetries(): void {
  while (retries.length > 0) {
    retries.shift()?.();
  }
}

const manualSchedule: Schedule = (callback) => {
  retries.push(callback);
  if (autoRetry) {
    setImmediate(drainRetries);
  }
  return () => {
    retries = retries.filter((entry) => entry !== callback);
  };
};

async function startHub(fixedPort = 0): Promise<Hub> {
  hub = await startTestHub({
    config: { ...testConfig(dataDir), port: fixedPort, projectFolders: ["/srv/projects"] },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [scriptedTarget()],
    credentials: testCredentials,
  });
  port = hub.address.port;
  token = readFileSync(join(dataDir, "brain.token"), "utf8").trim();
  return hub;
}

function hubUrl(): string {
  return `http://127.0.0.1:${port}`;
}

function startBrain(order: readonly Provider[] = ["gpt", "claude", "deepseek"], routers?: Record<Provider, FakeProgram>): Brain {
  link = createHubLink({ hubUrl: hubUrl(), token, schedule: manualSchedule, reconnectDelay: 0 });
  brain = createBrain({
    adapters: new Map(Object.entries(programs) as [Provider, FakeProgram][]),
    order,
    transport: link,
    clock,
    tools: { url: `${hubUrl()}${brainToolsPath}`, token },
    workspace: dataDir,
    ...(routers === undefined ? {} : { router: { adapters: new Map(Object.entries(routers) as [Provider, FakeProgram][]), workspace: dataDir } }),
  });
  const current = brain;
  link.bind({ receive: (message) => current.receive(message), running: () => current.running() });
  link.connect();
  return brain;
}

async function stopBrain(): Promise<void> {
  await link?.close();
  await brain?.close();
  link = undefined;
  brain = undefined;
}

function freshPrograms(): Record<Provider, FakeProgram> {
  return { gpt: new FakeProgram("gpt"), claude: new FakeProgram("claude"), deepseek: new FakeProgram("deepseek") };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "brain-session-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  jobs = [];
  retries = [];
  autoRetry = false;
  programs = freshPrograms();
});

afterEach(async () => {
  await stopBrain();
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

function running(): Hub {
  if (hub === undefined) {
    throw new Error("The hub is not running");
  }
  return hub;
}

function until<T>(check: () => T | undefined | false): Promise<T> {
  return new Promise((resolve) => {
    const current = running();
    let stop = () => undefined as void;
    const test = () => {
      const value = check();
      if (value !== undefined && value !== false) {
        stop();
        resolve(value);
        return true;
      }
      return false;
    };
    if (test()) {
      return;
    }
    const off = [current.conversations.subscribe(() => void test()), current.commands.subscribe(() => void test())];
    stop = () => off.forEach((unsubscribe) => unsubscribe());
  });
}

function detail(id: string): ConversationDetail {
  const value = running().conversations.detail(id);
  if (value === undefined) {
    throw new Error(`No conversation ${id}`);
  }
  return value;
}

function lastTurn(id: string) {
  return detail(id).turns.at(-1);
}

function turnEnded(id: string, count: number) {
  return until(() => {
    const turns = detail(id).turns;
    return turns.length >= count && turns.slice(0, count).every((turn) => turn.state !== "running") && turns;
  });
}

async function owner(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", await assertion({ key, clock }));
  headers.set("origin", hubUrl());
  headers.set("content-type", "application/json");
  return fetch(`${hubUrl()}${path}`, { ...init, headers });
}

async function newConversation(): Promise<Conversation> {
  const response = await owner("/api/conversations", { method: "POST", body: "{}" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { conversation: Conversation }).conversation;
}

async function say(conversation: string, text: string, quotedMessage?: string): Promise<void> {
  const response = await owner(`/api/conversations/${conversation}/messages`, { method: "POST", body: JSON.stringify({ text, quotedMessage }) });
  expect(response.status).toBe(202);
}

async function sayInStream(message: Omit<StreamMessage, "attachments">): Promise<StreamEntry> {
  const response = await owner("/api/stream", { method: "POST", body: JSON.stringify(message) });
  expect(response.status).toBe(202);
  return StreamEntry.parse(await response.json());
}

async function callTool(options: OpenOptions, name: string, args: Record<string, unknown>, bearer?: string): Promise<string> {
  const tools = options.tools;
  if (tools === null) {
    throw new Error("The brain opened its program without the hub's tools");
  }
  const response = await fetch(tools.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer ?? tools.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      [conversationHeader]: tools.conversation,
      [turnHeader]: tools.turn,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { content: { text: string }[] } };
  return body.result.content.map((item) => item.text).join("\n");
}

describe("the brain's session", () => {
  it("bypasses routing for topic input and quotes, including steering a live session and reading a long quote", async () => {
    const running = await startHub();
    const routers = freshPrograms();
    startBrain(["gpt", "claude", "deepseek"], routers);
    const conversation = await newConversation();
    const other = await newConversation();
    await say(conversation.id, "Original topic input");
    const first = await programs.gpt.next();
    expect(first.text).toBe("Original topic input");
    first.handle.emit({ type: "session", session: "gpt-with-quotes" });
    const short = "完整引用\n第二行";
    first.handle.finish(short);
    await turnEnded(conversation.id, 1);
    const original = detail(conversation.id).entries.at(-1)!;

    const mismatch = await owner(`/api/conversations/${other.id}/messages`, {
      method: "POST", body: JSON.stringify({ text: "Wrong topic", quotedMessage: original.id }),
    });
    expect(mismatch.status).toBe(404);
    expect(detail(other.id).entries).toEqual([]);

    await say(conversation.id, "Direct reply to the quote", original.id);
    const direct = await programs.gpt.next();
    expect(direct.handle.options.session).toBe("gpt-with-quotes");
    expect(direct.text).toContain(short);
    const steered = await sayInStream({ text: "One more point", quotedMessage: original.id, scope: { kind: "code" } });
    expect(steered).toMatchObject({ topic: { id: conversation.id }, entry: { quotedMessage: original.id } });
    expect((await programs.gpt.next("steer")).text).toContain(short);

    const long = "中".repeat(quoteChunkLimit - 1) + "🌱" + "a".repeat(quoteInlineLimit) + "\nLast line";
    direct.handle.finish(long);
    await turnEnded(conversation.id, 2);
    const longEntry = detail(conversation.id).entries.at(-1)!;
    running.database.connection.prepare("UPDATE conversations SET topic_state = 'archived' WHERE id = ?").run(conversation.id);
    const quoted = await sayInStream({ text: "Reply to the long text", quotedMessage: longEntry.id });
    expect(quoted.topic.id).toBe(conversation.id);
    expect(detail(conversation.id).conversation.topicState).toBe("active");
    const next = await programs.gpt.next();
    expect(next.text).toContain(longEntry.id);
    expect(next.text).toContain("read_quote");
    expect(next.text).not.toContain(long.slice(0, 100));
    let offset: number | null = 0;
    let collected = "";
    do {
      const part: { text: string; next: number | null } = JSON.parse(await callTool(next.handle.options, "read_quote", { id: longEntry.id, offset }));
      if (offset === 0) {
        expect(part.text.endsWith("🌱")).toBe(true);
      }
      collected += part.text;
      offset = part.next;
    } while (offset !== null);
    expect(collected).toBe(long);
    expect(await callTool({ ...next.handle.options, tools: { ...next.handle.options.tools!, conversation: other.id } }, "read_quote", { id: longEntry.id }))
      .toBe("No quote at that offset in this topic.");
    expect(routers.gpt.happenings).toEqual([]);
  });

  it("reuses a tool-free router, falls through invalid providers and opens a fresh topic when all fail", async () => {
    await startHub();
    const routers = freshPrograms();
    startBrain(["claude", "gpt", "deepseek"], routers);
    const topic = await newConversation();
    await say(topic.id, "A topic about mowing");
    const session = await programs.claude.next();
    session.handle.emit({ type: "session", session: "claude-mowing" });
    session.handle.finish("Mow only when the grass is dry.");
    await turnEnded(topic.id, 1);

    const first = sayInStream({ text: "Does the grass need watering?" });
    const route = await routers.claude.next();
    expect(route.handle.options).toMatchObject({ tools: null, textOnly: true });
    expect(route.text).toContain("Mow only when the grass is dry.");
    route.handle.finish(JSON.stringify({ kind: "existing", topic: topic.id }));
    expect((await first).topic.id).toBe(topic.id);
    expect((await programs.claude.next()).handle.options.session).toBe("claude-mowing");

    const unsure = sayInStream({ text: "How about starting a garden?" });
    const reused = await routers.claude.next();
    expect(reused.handle).toBe(route.handle);
    reused.handle.emit({ type: "failed", reason: "Exited", lostSession: false });
    const bad = await routers.gpt.next();
    bad.handle.finish(JSON.stringify({ kind: "existing", topic: "not-a-candidate" }));
    const fallback = await routers.deepseek.next();
    fallback.handle.finish(JSON.stringify({ kind: "new", title: "Starting a garden", possibleMatch: topic.id }));
    const result = await unsure;
    expect(result.topic).toMatchObject({ title: "Starting a garden", repository: null });
    expect(result.topic.id).not.toBe(topic.id);
    expect(result.entry).toMatchObject({ possibleMatch: topic.id });
    expect(detail(result.topic.id).entries[0]).toMatchObject({ id: result.entry.id, possibleMatch: topic.id });
    expect((await programs.claude.next()).handle.options.tools?.conversation).toBe(result.topic.id);

    for (const program of Object.values(routers)) {
      program.refuseStart = "Unavailable";
    }
    const failed = await sayInStream({ text: "Start something else", scope: { kind: "code" } });
    expect(failed.topic).toMatchObject({ title: "Start something else", repository: null, needsRepository: true });
    expect(failed.entry).not.toHaveProperty("possibleMatch");
    expect(routers.claude.handles).toHaveLength(2);
    const pending = await programs.claude.next();
    expect(pending.handle.options.tools?.conversation).toBe(failed.topic.id);
    expect(pending.text).toContain("waiting for a repository");
    expect(await callTool(pending.handle.options, "set_topic_repository", { repository: "owner/new-project" })).toBe("Repository assigned to this topic.");
    expect(detail(failed.topic.id).conversation).toMatchObject({ repository: "owner/new-project" });
    expect(detail(failed.topic.id).conversation).not.toHaveProperty("needsRepository");
  });

  it("runs gh through the hub for a question about open pull requests and answers with the result", async () => {
    await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "novan-xu/super-agent2 现在有哪些打开的 PR？");
    const { handle, text } = await programs.gpt.next();
    expect(text).toBe("novan-xu/super-agent2 现在有哪些打开的 PR？");
    handle.emit({ type: "session", session: "gpt-session-1" });
    const command = "gh pr list --repo novan-xu/super-agent2 --state open";
    handle.emit({ type: "tool.started", call: "c1", name: "mcp__hub__run_command", input: JSON.stringify({ target: "hub", command }) });
    const result = await callTool(handle.options, "run_command", { target: "hub", command });
    expect(result).toContain("exited with exit code 0");
    expect(result).toContain("#29\tAdd the Chinese presentation");
    handle.emit({ type: "tool.finished", call: "c1", output: result, ok: true });
    handle.emit({ type: "text", block: "a", delta: "打开的 PR 有两个：" });
    handle.emit({ type: "text", block: "a", delta: "#29 和 #28。" });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await turnEnded(conversation.id, 1);
    expect(jobs.map((job) => job.command)).toEqual([command]);
    expect(jobs[0]?.credentials["GH_TOKEN"]).toBe("test-token-for-novan-xu");
    const shown = detail(conversation.id);
    expect(shown.turns[0]).toMatchObject({ state: "completed", provider: "gpt", model: "gpt-model" });
    expect(shown.entries.map((entry) => entry.kind)).toEqual(["owner", "tool", "text"]);
    expect(shown.entries[1]).toMatchObject({ kind: "tool", state: "done", output: result });
    expect(shown.entries[2]).toMatchObject({ kind: "text", text: "打开的 PR 有两个：#29 和 #28。" });
    expect(shown.conversation).toMatchObject({ title: "novan-xu/super-agent2 现在有哪些打开的 PR？", state: "idle", provider: "gpt" });
  });

  it("keeps one program session across turns and resumes it after the brain, the hub and the machine restart", async () => {
    const first = await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "记住：我的猫叫 Mochi。");
    const opening = await programs.gpt.next();
    expect(opening.handle.options.session).toBeNull();
    opening.handle.emit({ type: "session", session: "gpt-session-1" });
    opening.handle.finish("记住了。");
    await turnEnded(conversation.id, 1);

    await say(conversation.id, "今天天气不错。");
    const second = await programs.gpt.next();
    expect(second.handle).not.toBe(opening.handle);
    expect(second.handle.options.session).toBe("gpt-session-1");
    expect(second.handle.options.tools?.turn).not.toBe(opening.handle.options.tools?.turn);
    expect(second.text).toBe("今天天气不错。");
    second.handle.finish("是的。");
    await turnEnded(conversation.id, 2);

    await stopBrain();
    startBrain();
    await say(conversation.id, "我的猫叫什么？");
    const afterBrain = await programs.gpt.next();
    expect(afterBrain.handle).not.toBe(opening.handle);
    expect(afterBrain.handle.options.session).toBe("gpt-session-1");
    expect(afterBrain.text).toBe("我的猫叫什么？");
    afterBrain.handle.finish("Mochi。");
    await turnEnded(conversation.id, 3);

    const fixedPort = first.address.port;
    await first.close();
    hub = undefined;
    await startHub(fixedPort);
    autoRetry = true;
    drainRetries();
    await until(() => running().conversations.linked());
    await say(conversation.id, "它几岁了？我没说过。");
    const afterHub = await programs.gpt.next();
    expect(afterHub.handle.options.session).toBe("gpt-session-1");
    expect(afterHub.text).toBe("它几岁了？我没说过。");
    afterHub.handle.finish("你没告诉过我。");
    await turnEnded(conversation.id, 4);

    await stopBrain();
    await running().close();
    hub = undefined;
    await startHub(fixedPort);
    startBrain();
    await say(conversation.id, "再说一遍猫的名字。");
    const afterMachine = await programs.gpt.next();
    expect(afterMachine.handle.options.session).toBe("gpt-session-1");
    expect(afterMachine.text).toBe("再说一遍猫的名字。");
    afterMachine.handle.finish("Mochi。");
    await turnEnded(conversation.id, 5);
    const prompts = programs.gpt.handles.flatMap((handle) => handle.prompts);
    expect(prompts.filter((prompt) => prompt.includes("Mochi"))).toEqual(["记住：我的猫叫 Mochi。"]);
  });

  it("gives a message sent during a turn to that turn", async () => {
    await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "列出 hub 上的文件，然后总结。");
    const { handle } = await programs.gpt.next();
    await say(conversation.id, "顺便把结果按大小排序。");
    const steered = await programs.gpt.next("steer");
    expect(steered.text).toBe("顺便把结果按大小排序。");
    const turn = lastTurn(conversation.id);
    await until(() => detail(conversation.id).entries.filter((entry) => entry.kind === "owner").every((entry) => entry.taken));
    handle.finish("按大小排好了。");
    await turnEnded(conversation.id, 1);
    expect(detail(conversation.id).turns).toHaveLength(1);
    expect(turn?.state).toBe("running");
  });

  it("queues a message as the next turn when the program cannot take it into the running one", async () => {
    await startHub();
    programs.gpt.steering = false;
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "第一件事。");
    const first = await programs.gpt.next();
    await say(conversation.id, "第二件事。");
    await until(() => detail(conversation.id).entries.length === 2);
    expect(first.handle.steers).toEqual([]);
    first.handle.finish("第一件做完了。");
    const second = await programs.gpt.next();
    expect(second.text).toBe("第二件事。");
    second.handle.finish("第二件也做完了。");
    const turns = await turnEnded(conversation.id, 2);
    expect(turns.map((turn) => turn.state)).toEqual(["completed", "completed"]);
  });

  it("stops a turn when the owner interrupts it", async () => {
    await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "数到一百万。");
    const { handle } = await programs.gpt.next();
    handle.emit({ type: "text", block: "a", delta: "1, 2, 3" });
    const response = await owner(`/api/conversations/${conversation.id}/interrupt`, { method: "POST", body: "{}" });
    expect(response.status).toBe(202);
    await programs.gpt.next("interrupt");
    handle.emit({ type: "turn.finished", outcome: "interrupted" });
    const turns = await turnEnded(conversation.id, 1);
    expect(turns[0]?.state).toBe("interrupted");
    expect(detail(conversation.id).conversation.state).toBe("idle");
  });

  it("hands the conversation to Claude when GPT is unavailable, and to DeepSeek only when both are", async () => {
    await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "我叫 Novan。");
    const gpt = await programs.gpt.next();
    gpt.handle.emit({ type: "session", session: "gpt-session-1" });
    gpt.handle.finish("你好 Novan。");
    await turnEnded(conversation.id, 1);

    await say(conversation.id, "帮我查一下 CI。");
    const gptAgain = await programs.gpt.next();
    gptAgain.handle.emit({ type: "unavailable", reason: "You've hit your usage limit", until: null });
    const claude = await programs.claude.next();
    expect(claude.text).toContain("Owner: 帮我查一下 CI。");
    expect(claude.text).toContain("Assistant (GPT): 你好 Novan。");
    expect(claude.handle.options.session).toBeNull();
    claude.handle.emit({ type: "session", session: "claude-session-1" });
    claude.handle.finish("CI 是绿的。");
    const turns = await turnEnded(conversation.id, 2);
    expect(turns[1]).toMatchObject({ state: "completed", provider: "claude" });
    const notice = detail(conversation.id).entries.find((entry) => entry.kind === "notice");
    expect(notice).toMatchObject({ text: "GPT 暂时不可用（You've hit your usage limit），改由 Claude 接手" });

    await say(conversation.id, "我叫什么？");
    const gptThird = await programs.gpt.next();
    gptThird.handle.emit({ type: "unavailable", reason: "usage limit", until: clock.now() + 3_600_000 });
    const claudeAgain = await programs.claude.next();
    expect(claudeAgain.handle.options.session).toBe("claude-session-1");
    expect(claudeAgain.text).toContain("Owner: 我叫什么？");
    expect(claudeAgain.text).not.toContain("CI 是绿的");
    claudeAgain.handle.emit({ type: "unavailable", reason: "rate limited", until: clock.now() + 3_600_000 });
    const deepseek = await programs.deepseek.next();
    expect(deepseek.text).toContain("Owner: 我叫 Novan。");
    expect(deepseek.text).toContain("Assistant (Claude): CI 是绿的。");
    expect(deepseek.text).toContain("Owner: 我叫什么？");
    deepseek.handle.finish("你叫 Novan。");
    const third = await turnEnded(conversation.id, 3);
    expect(third[2]).toMatchObject({ state: "completed", provider: "deepseek" });

    await say(conversation.id, "谢谢。");
    const deepseekAgain = await programs.deepseek.next();
    expect(deepseekAgain.text).toBe("谢谢。");
    deepseekAgain.handle.finish("不客气。");
    await turnEnded(conversation.id, 4);

    clock.advance(3_600_000);
    await say(conversation.id, "GPT 回来了吗？");
    const gptBack = await programs.gpt.next();
    expect(gptBack.handle.options.session).toBe("gpt-session-1");
    expect(gptBack.text).toContain("Assistant (DeepSeek): 不客气。");
    expect(gptBack.text).toContain("GPT 回来了吗？");
    gptBack.handle.finish("回来了。");
    await turnEnded(conversation.id, 5);
  });

  it("reports a failed turn when no provider can answer", async () => {
    await startHub();
    startBrain(["gpt", "deepseek"]);
    const conversation = await newConversation();
    await say(conversation.id, "在吗？");
    (await programs.gpt.next()).handle.emit({ type: "failed", reason: "authentication failed", lostSession: false });
    (await programs.deepseek.next()).handle.emit({ type: "unavailable", reason: "quota exhausted", until: null });
    const turns = await turnEnded(conversation.id, 1);
    expect(turns[0]).toMatchObject({ state: "failed", reason: "gpt: authentication failed; deepseek: quota exhausted" });
  });

  it("starts a new program session with the whole conversation when the old one is lost", async () => {
    await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "项目代号是 Falcon。");
    const first = await programs.gpt.next();
    first.handle.emit({ type: "session", session: "gpt-session-1" });
    first.handle.finish("好的。");
    await turnEnded(conversation.id, 1);
    await stopBrain();
    startBrain();
    await say(conversation.id, "代号是什么？");
    const resumed = await programs.gpt.next();
    expect(resumed.handle.options.session).toBe("gpt-session-1");
    resumed.handle.emit({ type: "failed", reason: "No conversation found with session ID", lostSession: true });
    const fresh = await programs.gpt.next();
    expect(fresh.handle.options.session).toBeNull();
    expect(fresh.text).toContain("Owner: 项目代号是 Falcon。");
    expect(fresh.text).toContain("代号是什么？");
    fresh.handle.emit({ type: "session", session: "gpt-session-2" });
    fresh.handle.finish("Falcon。");
    await turnEnded(conversation.id, 2);
  });

  it("records a turn cut off by a brain restart as interrupted and still answers a message that was waiting", async () => {
    await startHub();
    programs.gpt.steering = false;
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "开始一个很长的任务。");
    await programs.gpt.next();
    await say(conversation.id, "还有这个。");
    await until(() => detail(conversation.id).entries.length === 2);
    await stopBrain();
    startBrain();
    const turns = await turnEnded(conversation.id, 1);
    expect(turns[0]).toMatchObject({ state: "interrupted", reason: "大脑在这一轮结束前重启了，这一轮被中断" });
    const next = await programs.gpt.next();
    expect(next.text).toBe("还有这个。");
    next.handle.finish("好。");
    await turnEnded(conversation.id, 2);
  });

  it("tells the brain a command is held, and tells it the outcome once the owner answers", async () => {
    await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "删掉 novan-xu/old 这个仓库。");
    const { handle } = await programs.gpt.next();
    const command = "gh repo delete novan-xu/old --yes";
    const result = await callTool(handle.options, "run_command", { target: "hub", command });
    expect(result).toContain("is held");
    expect(result).toContain("waiting for their confirmation");
    expect(jobs).toEqual([]);
    handle.finish("这个操作需要你在页面上确认。");
    await turnEnded(conversation.id, 1);

    const held = running().commands.list().find((record) => record.command === command);
    expect(held?.state).toBe("held");
    if (held === undefined) {
      return;
    }
    const release = await owner(`/api/commands/${held.id}/release`, {
      method: "POST",
      body: JSON.stringify({ fingerprint: fingerprintOf(held) }),
    });
    expect(release.status).toBe(202);
    const told = await programs.gpt.next();
    expect(told.text).toContain(`[hub] The command ${held.id} that was held for the owner's confirmation has an outcome.`);
    expect(told.text).toContain(`originally requested in topic ${conversation.id}`);
    expect(told.text).toContain("exited with exit code 0");
    expect(jobs.map((job) => job.command)).toEqual([command]);
    const system = running().conversations.list().find(({ title }) => title === "System");
    if (system === undefined) {
      throw new Error("The command outcome has no System topic");
    }
    const notice = detail(system.id).entries.find((entry) => entry.kind === "notice");
    expect(notice).toMatchObject({ text: `等你确认的命令有了结果（已结束）：${command}` });
    told.handle.finish("仓库已经删掉了。");
    await turnEnded(system.id, 1);
  });

  it("does not let the brain's token release or refuse a held command", async () => {
    await startHub();
    startBrain();
    const conversation = await newConversation();
    await say(conversation.id, "删掉 novan-xu/old。");
    const { handle } = await programs.gpt.next();
    await callTool(handle.options, "run_command", { target: "hub", command: "gh repo delete novan-xu/old --yes" });
    const held = running().commands.list().find((record) => record.state === "held");
    if (held === undefined) {
      throw new Error("Nothing was held");
    }
    const body = JSON.stringify({ fingerprint: fingerprintOf(held) });
    for (const path of [`/api/commands/${held.id}/release`, `/api/commands/${held.id}/refuse`, `/brain/commands/${held.id}/release`]) {
      const response = await fetch(`${hubUrl()}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: hubUrl(), "content-type": "application/json" },
        body,
      });
      expect(response.status, path).not.toBe(202);
      expect([403, 404]).toContain(response.status);
    }
    const listed = await callTool(handle.options, "read_command", { id: held.id });
    expect(listed).toContain("is held");
    expect(running().commands.get(held.id)?.state).toBe("held");
    expect(running().lock?.get(held.id)?.answer).toBeNull();
    expect(jobs).toEqual([]);
  });

  it("refuses the brain's paths without the brain's token, and the owner's paths with it", async () => {
    await startHub();
    const tools = await fetch(`${hubUrl()}${brainToolsPath}`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(tools.status).toBe(403);
    const signedIn = await fetch(`${hubUrl()}${brainToolsPath}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(signedIn.status).toBe(403);
    const conversations = await fetch(`${hubUrl()}/api/conversations`, { headers: { authorization: `Bearer ${token}` } });
    expect(conversations.status).toBe(403);
  });

  it("lists conversations and returns to an earlier one, each with its own session", async () => {
    await startHub();
    startBrain();
    const first = await newConversation();
    await say(first.id, "第一个对话。");
    const one = await programs.gpt.next();
    one.handle.emit({ type: "session", session: "session-one" });
    one.handle.finish("一。");
    await turnEnded(first.id, 1);
    const second = await newConversation();
    await say(second.id, "第二个对话。");
    const two = await programs.gpt.next();
    expect(two.handle).not.toBe(one.handle);
    two.handle.emit({ type: "session", session: "session-two" });
    two.handle.finish("二。");
    await turnEnded(second.id, 1);
    clock.advance(1000);
    await say(first.id, "回到第一个。");
    const back = await programs.gpt.next();
    expect(back.handle.options.session).toBe("session-one");
    back.handle.finish("回来了。");
    await turnEnded(first.id, 2);

    const response = await owner("/api/conversations");
    const list = ConversationList.parse(await response.json());
    expect(list.brain.linked).toBe(true);
    expect(list.conversations.map((conversation) => conversation.id)).toEqual([first.id, second.id]);
    const read = DetailShape.parse(await (await owner(`/api/conversations/${first.id}`)).json());
    expect(read.entries.map((entry) => entry.kind)).toEqual(["owner", "text", "owner", "text"]);
  });

  it("carries what the owner confirmed into a new conversation after a restart and to another provider, and tells a running session what the owner changed", async () => {
    await startHub();
    startBrain();
    const first = await newConversation();
    await say(first.id, "记住：以后回答先说结论。");
    const opening = await programs.gpt.next();
    expect(opening.text).toBe("记住：以后回答先说结论。");
    opening.handle.emit({ type: "session", session: "gpt-one" });
    expect(await callTool(opening.handle.options, "remember", { text: "你希望先说结论。" })).toContain("Suggested (suggestion 1)");
    opening.handle.finish("已经放进记忆的待确认里。");
    await turnEnded(first.id, 1);
    expect((await owner("/api/memories/suggestions/1/confirm", { method: "POST", body: "{}" })).status).toBe(200);

    await say(first.id, "好。");
    const same = await programs.gpt.next();
    expect(same.text).toContain('- #1 "你希望先说结论。"');
    expect(same.text.endsWith("好。")).toBe(true);
    same.handle.finish("嗯。");
    await turnEnded(first.id, 2);

    await stopBrain();
    startBrain();
    const second = await newConversation();
    await say(second.id, "CI 怎么样？");
    const fresh = await programs.gpt.next();
    expect(fresh.handle.options.session).toBeNull();
    expect(fresh.text).toContain("[hub] Your memory");
    expect(fresh.text).toContain('- #1 "你希望先说结论。"');
    expect(fresh.text.endsWith("CI 怎么样？")).toBe(true);
    fresh.handle.emit({ type: "session", session: "gpt-two" });
    fresh.handle.finish("结论：绿的。");
    await turnEnded(second.id, 1);

    const edited = await owner("/api/memories/1", { method: "PUT", body: JSON.stringify({ text: "你希望先说结论，再列细节。" }) });
    expect(edited.status).toBe(200);
    await say(second.id, "部署呢？");
    const told = await programs.gpt.next();
    expect(told.handle.options.session).toBe("gpt-two");
    expect(told.text).toContain('The owner edited #1; it now reads: "你希望先说结论，再列细节。"');
    expect(told.text).toContain('- #1 "你希望先说结论，再列细节。"');
    told.handle.emit({ type: "unavailable", reason: "usage limit", until: null });
    const claude = await programs.claude.next();
    expect(claude.text).toContain("[hub] Your memory: ");
    expect(claude.text).toContain("你希望先说结论，再列细节。");
    claude.handle.emit({ type: "session", session: "claude-two" });
    claude.handle.finish("结论：部署好了。");
    await turnEnded(second.id, 2);

    expect(MemoryList.parse(await (await owner("/api/memories")).json()).memories).toHaveLength(1);
    expect((await owner("/api/memories/1", { method: "DELETE", body: "{}" })).status).toBe(200);
    await say(first.id, "还记得什么？");
    const back = await programs.gpt.next();
    expect(back.handle.options.session).toBe("gpt-one");
    expect(back.text).toContain("The owner deleted #1");
    expect(back.text).toContain("Your memory is empty.");
    expect(back.text).toContain('(was #1): "你希望先说结论，再列细节。"');
    back.handle.finish("没有了。");
    await turnEnded(first.id, 3);
  });
});
