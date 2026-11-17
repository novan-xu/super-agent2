import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityAdapter, antigravityFailure, antigravityResult } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { dshAdapter, dshPatch } from "./dsh.js";
import { invocationOf, npmShimTarget } from "./process.js";
import type { OpenOptions, ProgramHandle } from "./program.js";
import type { ProgramSettings } from "./settings.js";
import { EventLog, fakeAntigravitySource, fakeClaudeSource, fakeCodexSource, fakeDshSource, readLog, writeFake } from "./testing/programs.js";
import { descendantsOf } from "./tree.js";

let directory: string;
let logFile: string;
let handles: ProgramHandle[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "programs-worker-"));
  logFile = join(directory, "log.jsonl");
  handles = [];
});

afterEach(async () => {
  await Promise.all(handles.map((handle) => handle.close()));
  rmSync(directory, { recursive: true, force: true });
});

function settings(program: string, model: string, effort: string): ProgramSettings {
  return {
    program,
    model,
    effort,
    environment: { ...process.env, FAKE_LOG: logFile, FAKE_REPORT_MODEL: "1", GH_TOKEN: "test-worker-token" },
    clock: { now: () => 0 },
    client: "super-agent2-worker",
    codexConfig: { "shell_environment_policy.inherit": "all" },
    processTree: true,
  };
}

function workerOptions(session: string | null = null): OpenOptions {
  return { session, tools: null, workspace: directory };
}

function track<T extends ProgramHandle>(handle: T): T {
  handles.push(handle);
  return handle;
}

describe("programs opened for a worker, without the hub's tools", () => {
  it("starts Codex with no hub server, the worker's own configuration, and reports the model that runs", async () => {
    const adapter = codexAdapter(settings(writeFake(directory, "codex.mjs", fakeCodexSource), "gpt-6-luna", "low"));
    const log = new EventLog();
    const handle = track(adapter.open(workerOptions(), log.listener));
    handle.start("work");
    await log.ended();
    expect(log.events.slice(0, 2)).toEqual([
      { type: "session", session: "thread-new" },
      { type: "model", model: "gpt-6-luna", effort: "low" },
    ]);
    expect(handle.processId?.()).toEqual(expect.any(Number));
    const received = readLog(logFile);
    expect(received[0]).toEqual({ env: { token: null } });
    expect(received.find((entry) => entry["method"] === "initialize")?.["params"]).toMatchObject({ clientInfo: { name: "super-agent2-worker" } });
    expect(received.find((entry) => entry["method"] === "thread/start")?.["params"]).toEqual({
      model: "gpt-6-luna",
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { model_reasoning_effort: "low", "shell_environment_policy.inherit": "all" },
    });
  });

  it("starts Claude Code with an empty strict tool configuration and reports its model", async () => {
    const adapter = claudeAdapter(settings(writeFake(directory, "claude.mjs", fakeClaudeSource), "claude-haiku-5-5", "low"));
    const log = new EventLog();
    track(adapter.open(workerOptions(), log.listener)).start("work");
    await log.ended();
    expect(log.events).toContainEqual({ type: "model", model: "claude-haiku-5-5", effort: null });
    const first = readLog(logFile)[0] as { args: string[]; env: { token: string | null } };
    expect(first.env.token).toBeNull();
    expect(first.args).toContain("--dangerously-skip-permissions");
    expect(first.args[first.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(first.args).toContain("--strict-mcp-config");
  });

  it("starts dsh with a patch that only turns off the session log upload", async () => {
    const adapter = dshAdapter(settings(writeFake(directory, "dsh.mjs", fakeDshSource), "deepseek-flash", "low"));
    const log = new EventLog();
    track(adapter.open(workerOptions(), log.listener)).start("work");
    await log.ended();
    const first = readLog(logFile)[0] as { args: string[]; env: { mode: string; token: string | null; conversation: string | null } };
    expect(first.env).toEqual({ mode: "danger-full-access", token: null, conversation: null });
    expect(dshPatch(null)).not.toContain("super-agent-hub");
    expect(dshPatch(null)).toContain("session-log-deepseek");
  });
});

describe("finding and stopping a program", () => {
  it("runs an npm command shim's script with Node directly", () => {
    const shim = join(directory, "codex.cmd");
    const text = '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
    writeFileSync(shim, text);
    expect(npmShimTarget(shim, text)).toBe(join(directory, "node_modules\\@openai\\codex\\bin\\codex.js"));
    expect(invocationOf(shim, ["app-server"])).toEqual({ command: process.execPath, args: [join(directory, "node_modules\\@openai\\codex\\bin\\codex.js"), "app-server"] });
    expect(readFileSync(shim, "utf8")).toBe(text);
    expect(npmShimTarget(shim, "@echo off\r\nsomething.exe %*\r\n")).toBeUndefined();
    expect(invocationOf(join(directory, "tool.exe"), ["a"])).toEqual({ command: join(directory, "tool.exe"), args: ["a"] });
  });

  it("finds every descendant of a process in the process table", () => {
    const table = ["  1     0", " 10     1", " 11    10", " 12    11", " 13    10", " 20     1", " 21    20", "bad line"].join("\n");
    expect(descendantsOf(10, table).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(descendantsOf(99, table)).toEqual([]);
  });
});

describe("Antigravity opened for a worker", () => {
  const fakeProgram = () => writeFake(directory, "agy.mjs", fakeAntigravitySource);

  it("runs a turn per message in one process and reports its session, model, tools and text", async () => {
    const adapter = antigravityAdapter(settings(fakeProgram(), "gemini-3.8-flash", "high"));
    const log = new EventLog();
    const handle = track(adapter.open(workerOptions(), log.listener));
    expect(handle.processId?.()).toEqual(expect.any(Number));
    handle.start("你好");
    await log.ended();
    expect(log.events[0]).toMatchObject({ type: "session", session: expect.stringMatching(/^conv-/) });
    expect(log.events).toContainEqual({ type: "model", model: "gemini-3.8-flash", effort: null });
    expect(log.events).toContainEqual({ type: "tool.started", call: expect.any(String), name: "write_file", input: '{"Path":"out.txt"}' });
    expect(log.events).toContainEqual({ type: "tool.finished", call: expect.any(String), output: "1 lines", ok: true });
    const text = log.events.filter((event) => event.type === "text");
    expect(text.map((event) => (event.type === "text" ? event.delta : "")).join("")).toBe("译文：你好\n");
    expect(new Set(text.map((event) => (event.type === "text" ? event.block : ""))).size).toBe(1);
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "completed" });
    handle.start("再来");
    await log.ended(2);
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "completed" });
    const received = readLog(logFile);
    const launches = received.filter((entry) => "args" in entry) as { args: string[]; cwd: string }[];
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "high",
      "--disable-slash-commands",
      "--print=",
    ]);
    expect(received.filter((entry) => "event" in entry)).toEqual([
      { event: "user", message: { content: "你好" } },
      { event: "user", message: { content: "再来" } },
    ]);
  });

  it("takes a message into the next turn, since it cannot enter a turn that is running", async () => {
    const adapter = antigravityAdapter(settings(fakeProgram(), "gemini-3.8-flash", "high"));
    const log = new EventLog();
    const handle = track(adapter.open(workerOptions(), log.listener));
    handle.start("wait");
    await log.until((events) => events.some((event) => event.type === "text"));
    expect(await handle.steer("more")).toBe("queued");
    expect(readLog(logFile).filter((entry) => "event" in entry)).toHaveLength(1);
  });

  it("interrupts a turn by stopping the process, and resumes the same conversation on the next message", async () => {
    const adapter = antigravityAdapter(settings(fakeProgram(), "gemini-3.8-flash", "high"));
    const log = new EventLog();
    const handle = track(adapter.open(workerOptions(), log.listener));
    handle.start("wait");
    await log.until((events) => events.some((event) => event.type === "text"));
    const session = (log.events[0] as { session: string }).session;
    handle.interrupt();
    await log.ended();
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "interrupted" });
    handle.start("next");
    await log.ended(2);
    expect(log.events.at(-1)).toEqual({ type: "turn.finished", outcome: "completed" });
    const launches = readLog(logFile).filter((entry) => "args" in entry) as { args: string[] }[];
    expect(launches).toHaveLength(2);
    expect(launches[1]?.args).toContain("--conversation");
    expect(launches[1]?.args[launches[1].args.indexOf("--conversation") + 1]).toBe(session);
  });

  it("resumes a conversation given by its id, and reports a conversation it cannot find as a lost session", async () => {
    const adapter = antigravityAdapter(settings(fakeProgram(), "gemini-3.8-flash", "high"));
    const resumed = new EventLog();
    track(adapter.open(workerOptions("known"), resumed.listener)).start("hello");
    await resumed.ended();
    expect(resumed.events.some((event) => event.type === "session")).toBe(false);
    expect(resumed.events.at(-1)).toEqual({ type: "turn.finished", outcome: "completed" });
    const lost = new EventLog();
    track(adapter.open(workerOptions("missing"), lost.listener)).start("hello");
    await lost.ended();
    expect(lost.events.at(-1)).toMatchObject({ type: "failed", lostSession: true });
  });

  it("tells a used-up allowance from any other failure, and reports a process that ends mid-turn", async () => {
    const adapter = antigravityAdapter(settings(fakeProgram(), "gemini-3.8-flash", "high"));
    const quota = new EventLog();
    track(adapter.open(workerOptions(), quota.listener)).start("quota");
    await quota.ended();
    expect(quota.events.at(-1)).toMatchObject({ type: "unavailable", until: null });
    const broken = new EventLog();
    track(adapter.open(workerOptions(), broken.listener)).start("broken");
    await broken.ended();
    expect(broken.events.at(-1)).toEqual({ type: "failed", reason: "the model request failed", lostSession: false });
    const gone = new EventLog();
    track(antigravityAdapter(settings(join(directory, "missing.mjs"), "gemini-3.8-flash", "high")).open(workerOptions(), gone.listener)).start("hello");
    await gone.ended();
    expect(gone.events.at(-1)).toMatchObject({ type: "failed", lostSession: false });
  });

  it("refuses the hub's tools", () => {
    const adapter = antigravityAdapter(settings(fakeProgram(), "gemini-3.8-flash", "high"));
    expect(() => adapter.open({ session: null, tools: { url: "http://hub/brain/mcp", token: "t", conversation: "c" }, workspace: directory }, () => undefined)).toThrow(/not given/);
  });

  it("classifies failures by their text", () => {
    expect(antigravityFailure("conversation x not found")).toMatchObject({ type: "failed", lostSession: true });
    expect(antigravityFailure("RESOURCE_EXHAUSTED")).toMatchObject({ type: "unavailable" });
    expect(antigravityFailure("You are not signed in")).toMatchObject({ type: "unavailable" });
    expect(antigravityFailure("something else")).toMatchObject({ type: "failed", lostSession: false });
    expect(antigravityResult("SUCCESS", undefined, undefined)).toEqual({ type: "turn.finished", outcome: "completed" });
    expect(antigravityResult("SUCCESS", undefined, "interrupted")).toEqual({ type: "turn.finished", outcome: "interrupted" });
    expect(antigravityResult("SUCCESS", undefined, "print_timeout")).toMatchObject({ type: "failed" });
  });
});
