import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenOptions, ProgramHandle } from "./program.js";
import { EventLog, fakeClaudeSource, fakeCodexSource, fakeDshSource, readLog, writeFake } from "./testing/programs.js";
import { claudeAdapter, claudeEnvironment } from "./claude.js";
import { classifyCodexError, codexAdapter } from "./codex.js";
import { dshAdapter, dshPatch, dshTurnEnd } from "./dsh.js";
import type { ProgramSettings } from "./settings.js";

let directory: string;
let logFile: string;
let handles: ProgramHandle[];

const now = Date.UTC(2026, 10, 17, 12, 0, 0);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "brain-programs-"));
  logFile = join(directory, "log.jsonl");
  handles = [];
});

afterEach(async () => {
  await Promise.all(handles.map((handle) => handle.close()));
  rmSync(directory, { recursive: true, force: true });
});

function settings(program: string, model: string, effort: string): ProgramSettings {
  return { program, model, effort, environment: { ...process.env, FAKE_LOG: logFile }, clock: { now: () => now } };
}

function options(session: string | null): OpenOptions {
  return { session, workspace: directory, tools: { url: "http://hub:8080/brain/mcp", token: "test-brain-token", conversation: "conv-1" } };
}

function track<T extends ProgramHandle>(handle: T): T {
  handles.push(handle);
  return handle;
}

describe("Codex through its app server", () => {
  it("starts a full-access thread with the hub's tools and streams the turn", async () => {
    const adapter = codexAdapter(settings(writeFake(directory, "codex.mjs", fakeCodexSource), "gpt-6-astra", "high"));
    const log = new EventLog();
    const handle = track(adapter.open(options(null), log.listener));
    handle.start("现在有哪些 PR？");
    await log.ended();
    expect(log.events).toEqual([
      { type: "session", session: "thread-new" },
      { type: "tool.started", call: "exec-1", name: "shell", input: "gh pr list" },
      { type: "tool.output", call: "exec-1", delta: "#29 " },
      { type: "tool.finished", call: "exec-1", output: "#29 open\n", ok: true },
      { type: "tool.started", call: "mcp-1", name: "hub.run_command", input: '{"target":"hub"}' },
      { type: "tool.finished", call: "mcp-1", output: "exited", ok: true },
      { type: "text", block: "msg-1", delta: "有 " },
      { type: "text", block: "msg-1", delta: "#29" },
      { type: "turn.finished", outcome: "completed" },
    ]);
    const received = readLog(logFile);
    expect(received[0]).toEqual({ env: { token: "test-brain-token" } });
    const start = received.find((entry) => entry["method"] === "thread/start");
    expect(start?.["params"]).toEqual({
      model: "gpt-6-astra",
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        model_reasoning_effort: "high",
        "mcp_servers.hub": {
          url: "http://hub:8080/brain/mcp",
          bearer_token_env_var: "SUPER_AGENT_HUB_TOKEN",
          http_headers: { "x-super-agent-conversation": "conv-1" },
          tool_timeout_sec: 86400,
          startup_timeout_sec: 60,
        },
      },
    });
    expect(JSON.stringify(received.slice(1))).not.toContain("test-brain-token");
  });

  it("resumes a thread by its id and reports a thread that is gone as a lost session", async () => {
    const adapter = codexAdapter(settings(writeFake(directory, "codex.mjs", fakeCodexSource), "gpt-6-astra", "high"));
    const kept = new EventLog();
    track(adapter.open(options("thread-old"), kept.listener)).start("hello");
    await kept.ended();
    expect(kept.events.at(-1)).toEqual({ type: "turn.finished", outcome: "completed" });
    expect(kept.events.some((event) => event.type === "session")).toBe(false);
    expect(readLog(logFile).find((entry) => entry["method"] === "thread/resume")?.["params"]).toMatchObject({
      threadId: "thread-old",
      excludeTurns: true,
      approvalPolicy: "never",
    });
    const lost = new EventLog();
    track(adapter.open(options("missing"), lost.listener)).start("hello");
    await lost.ended();
    expect(lost.events.at(-1)).toEqual({ type: "failed", reason: "no rollout found for thread id missing", lostSession: true });
  });

  it("puts a message into the running turn and interrupts a turn, ignoring what arrives late", async () => {
    const adapter = codexAdapter(settings(writeFake(directory, "codex.mjs", fakeCodexSource), "gpt-6-astra", "high"));
    const log = new EventLog();
    const handle = track(adapter.open(options(null), log.listener));
    handle.start("wait");
    expect(await handle.steer("顺便排序")).toBe("steered");
    await log.ended();
    expect(log.events.slice(-2)).toEqual([
      { type: "text", block: "msg-steer", delta: "steered: 顺便排序" },
      { type: "turn.finished", outcome: "completed" },
    ]);
    expect(await handle.steer("too late")).toBe("queued");
    handle.start("wait");
    handle.interrupt();
    await log.ended(2);
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "interrupted" });
  });

  it("reports an exhausted allowance with the time it resets", async () => {
    const adapter = codexAdapter(settings(writeFake(directory, "codex.mjs", fakeCodexSource), "gpt-6-astra", "high"));
    const log = new EventLog();
    track(adapter.open(options(null), log.listener)).start("limit");
    await log.ended();
    expect(log.events.at(-1)).toEqual({ type: "unavailable", reason: "You've hit your usage limit.", until: 1_800_000_000_000 });
  });

  it("tells allowance and outages from other failures by what Codex reports", () => {
    expect(classifyCodexError({ message: "m", codexErrorInfo: "usageLimitExceeded" }).kind).toBe("limit");
    expect(classifyCodexError({ message: "m", codexErrorInfo: "rateLimitExceeded" }).kind).toBe("limit");
    expect(classifyCodexError({ message: "m", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }).kind).toBe("limit");
    expect(classifyCodexError({ message: "m", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).kind).toBe("unavailable");
    expect(classifyCodexError({ message: "m", codexErrorInfo: "serverOverloaded" }).kind).toBe("unavailable");
    expect(classifyCodexError({ message: "m", codexErrorInfo: "contextWindowExceeded" }).kind).toBe("failed");
    expect(classifyCodexError(null)).toEqual({ kind: "failed", reason: "Codex reported a failed turn" });
  });
});

describe("dsh through its SDK profile", () => {
  it("starts a full-access session with the hub's tools and reports each step", async () => {
    const adapter = dshAdapter(settings(writeFake(directory, "dsh.mjs", fakeDshSource), "deepseek-flash", "high"));
    const log = new EventLog();
    track(adapter.open(options(null), log.listener)).start("你好");
    await log.ended();
    const session = log.events[0];
    expect(session?.type).toBe("session");
    expect(log.events.slice(1)).toEqual([
      { type: "tool.started", call: "call-1", name: "bash", input: '{"command":"echo hi"}' },
      { type: "tool.finished", call: "call-1", output: "hi\n", ok: true },
      { type: "text", block: "a2", delta: "回答：你好" },
      { type: "turn.finished", outcome: "completed" },
    ]);
    const received = readLog(logFile);
    expect(received[0]).toMatchObject({
      env: { mode: "danger-full-access", token: "test-brain-token", conversation: "conv-1" },
    });
    expect((received[0]?.["args"] as string[]).slice(0, 3)).toEqual(["--profile", "sdk", "--patch"]);
    expect(received.find((entry) => entry["method"] === "initialize")?.["params"]).toEqual({
      cwd: directory,
      provider: "deepseek-account",
      model: "deepseek-flash",
      reasoningEffort: "high",
    });
    expect(received.some((entry) => entry["method"] === "session/resume")).toBe(false);
  });

  it("cannot take a message into a running turn, and interrupts by stopping the program and resuming", async () => {
    const adapter = dshAdapter(settings(writeFake(directory, "dsh.mjs", fakeDshSource), "deepseek-flash", "high"));
    const log = new EventLog();
    const handle = track(adapter.open(options("kept"), log.listener));
    handle.start("wait");
    await log.until((events) => events.some((event) => event.type === "text"));
    expect(await handle.steer("顺便")).toBe("queued");
    handle.interrupt();
    await log.ended();
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "interrupted" });
    handle.start("继续");
    await log.ended(2);
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "completed" });
    expect(readLog(logFile).filter((entry) => entry["method"] === "session/resume")).toHaveLength(2);
  });

  it("reports an exhausted allowance and a lost session", async () => {
    const adapter = dshAdapter(settings(writeFake(directory, "dsh.mjs", fakeDshSource), "deepseek-flash", "high"));
    const quota = new EventLog();
    track(adapter.open(options("kept"), quota.listener)).start("quota");
    await quota.ended();
    expect(quota.events.at(-1)).toEqual({ type: "unavailable", reason: "ACCOUNT_QUOTA: quota exhausted", until: null });
    const lost = new EventLog();
    track(adapter.open(options("missing"), lost.listener)).start("hello");
    await lost.ended();
    expect(lost.events.at(-1)).toEqual({ type: "failed", reason: 'session "missing" not found', lostSession: true });
  });

  it("reads every way a dsh turn ends", () => {
    expect(dshTurnEnd({ reason: { kind: "max-tokens" } }, now)).toEqual({ type: "turn.finished", outcome: "completed" });
    expect(dshTurnEnd({ reason: { kind: "aborted", reason: { kind: "user" } } }, now)).toEqual({ type: "turn.finished", outcome: "interrupted" });
    expect(dshTurnEnd({ reason: { kind: "error", error: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 5000 } } }, now)).toEqual({
      type: "unavailable",
      reason: "RATE_LIMIT: slow down",
      until: now + 5000,
    });
    expect(dshTurnEnd({ reason: { kind: "error", error: { code: "ACCOUNT_TOKEN_INVALID", message: "401" } } }, now)?.type).toBe("unavailable");
    expect(dshTurnEnd({ reason: { kind: "error", error: { code: "CONTEXT_WINDOW_EXCEEDED", message: "big" } } }, now)?.type).toBe("failed");
  });

  it("keeps the hub token out of the patch file it writes", () => {
    const patch = dshPatch("http://hub:8080/brain/mcp");
    expect(patch).toContain('url: "http://hub:8080/brain/mcp"');
    expect(patch).toContain("process.env.SUPER_AGENT_HUB_TOKEN");
    expect(patch).toContain("process.env.SUPER_AGENT_CONVERSATION");
    expect(patch).toContain("id: session-log-deepseek");
  });
});

describe("Claude Code through stream-json", () => {
  function claude(environment: Record<string, string | undefined> = {}) {
    const base = settings(writeFake(directory, "claude.mjs", fakeClaudeSource), "claude-opus-5-5", "high");
    return claudeAdapter({ ...base, environment: { ...base.environment, ...environment } });
  }

  it("starts a session of its own choosing in full access with only the hub's tools, and streams the turn", async () => {
    const log = new EventLog();
    track(claude({ CLAUDECODE: "1", BRAIN_CLAUDE_OAUTH_TOKEN: "test-oauth" }).open(options(null), log.listener)).start("有哪些 PR？");
    await log.ended();
    const session = log.events[0];
    expect(session?.type).toBe("session");
    expect(log.events.slice(1)).toEqual([
      { type: "text", block: "msg-1:0", delta: "我来" },
      { type: "text", block: "msg-1:0", delta: "查。" },
      { type: "tool.started", call: "toolu-1", name: "mcp__hub__run_command", input: '{"target":"hub"}' },
      { type: "tool.finished", call: "toolu-1", output: "exited", ok: true },
      { type: "text", block: "msg-3:whole:1", delta: "结果是 exited。" },
      { type: "turn.finished", outcome: "completed" },
    ]);
    const first = readLog(logFile)[0] as { args: string[]; env: Record<string, string | null> };
    expect(first.env).toEqual({ token: "test-brain-token", host: null, oauth: "test-oauth", brainOauth: null });
    expect(first.args).toContain("--dangerously-skip-permissions");
    expect(first.args).toContain("--strict-mcp-config");
    expect(first.args.slice(first.args.indexOf("--model"), first.args.indexOf("--model") + 4)).toEqual(["--model", "claude-opus-5-5", "--effort", "high"]);
    expect(first.args.at(-2)).toBe("--session-id");
    expect(session?.type === "session" && session.session).toBe(first.args.at(-1));
    const tools = JSON.parse(first.args[first.args.indexOf("--mcp-config") + 1] ?? "{}") as unknown;
    expect(tools).toEqual({
      mcpServers: {
        hub: {
          type: "http",
          url: "http://hub:8080/brain/mcp",
          headers: { Authorization: "Bearer ${SUPER_AGENT_HUB_TOKEN}", "x-super-agent-conversation": "conv-1" },
          alwaysLoad: true,
        },
      },
    });
    expect(first.args.join(" ")).not.toContain("test-brain-token");
  });

  it("resumes by id, and reports a session that is gone as lost", async () => {
    const kept = new EventLog();
    track(claude().open(options("kept"), kept.listener)).start("hello");
    await kept.ended();
    expect(kept.events.some((event) => event.type === "session")).toBe(false);
    expect((readLog(logFile)[0] as { args: string[] }).args.slice(-2)).toEqual(["--resume", "kept"]);
    const lost = new EventLog();
    track(claude().open(options("missing"), lost.listener)).start("hello");
    await lost.ended();
    expect(lost.events.at(-1)).toMatchObject({ type: "failed", lostSession: true });
  });

  it("folds a message into the running turn, also when the program answers it as a turn of its own", async () => {
    const log = new EventLog();
    const handle = track(claude().open(options(null), log.listener));
    handle.start("wait");
    await log.until((events) => events.some((event) => event.type === "text"));
    expect(await handle.steer("排序")).toBe("steered");
    await log.ended();
    expect(log.events.filter((event) => event.type === "text").map((event) => (event.type === "text" ? event.delta : ""))).toEqual(["working", "也做了：排序"]);
    handle.start("split");
    await log.until((events) => events.filter((event) => event.type === "text").length === 3);
    expect(await handle.steer("再来")).toBe("steered");
    await log.ended(2);
    expect(log.events.filter((event) => event.type === "turn.finished")).toHaveLength(2);
    expect(log.events.at(-2)).toEqual({ type: "text", block: "msg-next:0", delta: "接着：再来" });
  });

  it("interrupts a turn and stays usable", async () => {
    const log = new EventLog();
    const handle = track(claude().open(options(null), log.listener));
    handle.start("wait");
    await log.until((events) => events.some((event) => event.type === "text"));
    handle.interrupt();
    await log.ended();
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "interrupted" });
    expect(readLog(logFile).find((entry) => entry["type"] === "control_request")).toMatchObject({ request: { subtype: "interrupt", cancel_queued: true } });
    handle.start("again");
    await log.ended(2);
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "completed" });
  });

  it("reports an exhausted allowance with the time it resets", async () => {
    const log = new EventLog();
    track(claude().open(options(null), log.listener)).start("limit");
    await log.ended();
    expect(log.events.at(-1)).toEqual({ type: "unavailable", reason: "You've hit your limit", until: 1_800_000_000_000 });
    expect(log.events.some((event) => event.type === "text")).toBe(false);
  });

  it("gives the program a clean environment without the host's Claude settings", () => {
    const environment = claudeEnvironment(
      { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_BASE_URL: "http://x", MCP_TIMEOUT: "1", CLAUDE_CONFIG_DIR: "/data/claude" },
      "t",
    );
    expect(environment).toMatchObject({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/data/claude", SUPER_AGENT_HUB_TOKEN: "t" });
    expect(Object.keys(environment)).not.toContain("CLAUDECODE");
    expect(Object.keys(environment)).not.toContain("ANTHROPIC_BASE_URL");
    expect(Object.keys(environment)).not.toContain("MCP_TIMEOUT");
  });
});
