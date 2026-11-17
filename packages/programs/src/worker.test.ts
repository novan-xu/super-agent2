import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { dshAdapter, dshPatch } from "./dsh.js";
import { invocationOf, npmShimTarget } from "./process.js";
import type { OpenOptions, ProgramHandle } from "./program.js";
import type { ProgramSettings } from "./settings.js";
import { EventLog, fakeClaudeSource, fakeCodexSource, fakeDshSource, readLog, writeFake } from "./testing/programs.js";
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
