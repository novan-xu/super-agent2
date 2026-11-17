import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProgramEvent } from "../program.js";

export const fakeCodexSource = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.FAKE_LOG;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (entry) => appendFileSync(log, JSON.stringify(entry) + "\\n");
record({ env: { token: process.env.SUPER_AGENT_HUB_TOKEN ?? null } });
let turn = 0;
let active;
let threadId;
const notify = (method, params) => send({ method, params: { threadId, ...params } });
const finish = (status, error = null) => {
  notify("turn/completed", { turn: { id: active, status, error } });
  active = undefined;
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  const { id, method, params } = message;
  if (method === "initialize") return send({ id, result: { userAgent: "fake" } });
  if (method === "thread/start") { threadId = "thread-new"; return send({ id, result: { thread: { id: threadId } } }); }
  if (method === "thread/resume") {
    if (params.threadId === "missing") return send({ id, error: { code: -32600, message: "no rollout found for thread id missing" } });
    threadId = params.threadId;
    return send({ id, result: { thread: { id: threadId } } });
  }
  if (method === "turn/start") {
    turn += 1;
    active = "turn-" + turn;
    send({ id, result: { turn: { id: active, status: "inProgress" } } });
    const text = params.input[0].text;
    const turnId = active;
    notify("turn/started", { turn: { id: turnId } });
    if (text === "limit") {
      notify("account/rateLimits/updated", { rateLimits: { primary: { resetsAt: 1800000000 }, rateLimitReachedType: "rate_limit_reached" } });
      return finish("failed", { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" });
    }
    if (text === "wait") return;
    notify("item/started", { turnId, item: { type: "commandExecution", id: "exec-1", command: "gh pr list", status: "inProgress" } });
    notify("item/commandExecution/outputDelta", { turnId, itemId: "exec-1", delta: "#29 " });
    notify("item/completed", { turnId, item: { type: "commandExecution", id: "exec-1", command: "gh pr list", status: "completed", aggregatedOutput: "#29 open\\n", exitCode: 0 } });
    notify("item/started", { turnId, item: { type: "mcpToolCall", id: "mcp-1", server: "hub", tool: "run_command", arguments: { target: "hub" }, status: "inProgress" } });
    notify("item/completed", { turnId, item: { type: "mcpToolCall", id: "mcp-1", server: "hub", tool: "run_command", arguments: { target: "hub" }, status: "completed", result: { content: [{ type: "text", text: "exited" }] } } });
    notify("item/started", { turnId, item: { type: "agentMessage", id: "msg-1", text: "" } });
    notify("item/agentMessage/delta", { turnId, itemId: "msg-1", delta: "有 " });
    notify("item/agentMessage/delta", { turnId, itemId: "msg-1", delta: "#29" });
    notify("item/completed", { turnId, item: { type: "agentMessage", id: "msg-1", text: "有 #29" } });
    return finish("completed");
  }
  if (method === "turn/steer") {
    if (params.expectedTurnId !== active) return send({ id, error: { code: -32600, message: "no active turn to steer" } });
    send({ id, result: { turnId: active } });
    notify("item/completed", { turnId: active, item: { type: "agentMessage", id: "msg-steer", text: "steered: " + params.input[0].text } });
    return finish("completed");
  }
  if (method === "turn/interrupt") {
    send({ id, result: {} });
    finish("interrupted");
    return notify("item/completed", { turnId: params.turnId, item: { type: "agentMessage", id: "late", text: "late" } });
  }
});
`;

export const fakeDshSource = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.FAKE_LOG;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const record = (entry) => appendFileSync(log, JSON.stringify(entry) + "\\n");
record({ args: process.argv.slice(2), env: { mode: process.env.DSH_PERMISSION_MODE, token: process.env.SUPER_AGENT_HUB_TOKEN ?? null, conversation: process.env.SUPER_AGENT_CONVERSATION ?? null } });
const event = (sessionId, type, data) => send({ method: "session.event", params: { sessionId, event: { type, data } } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  const { id, method, params } = message;
  if (method === "initialize") return send({ id, result: { serverInfo: { name: "fake" } } });
  if (method === "session/resume") {
    if (params.sessionId === "missing") return send({ id, error: { code: -32603, message: "session \\"missing\\" not found" } });
    return send({ id, result: {} });
  }
  if (method === "session/prompt") {
    send({ id, result: { messageId: "m" } });
    const text = params.contentBlocks[0].text;
    const sid = params.sessionId;
    event(sid, "turn/start", { turn: 1 });
    if (text === "wait") return event(sid, "assistant/message", { message: { id: "w", content: [{ type: "text", text: "waiting" }] } });
    if (text === "quota") return event(sid, "turn/end", { reason: { kind: "error", error: { code: "ACCOUNT_QUOTA", message: "quota exhausted" } } });
    event(sid, "assistant/message", { message: { id: "a1", content: [{ type: "reasoning", text: "" }, { type: "tool-call", id: "call-1", name: "bash" }] } });
    event(sid, "tool/call", { callId: "call-1", name: "bash", arguments: "{\\"command\\":\\"echo hi\\"}" });
    event(sid, "tool/result", { message: { toolCallId: "call-1", content: [{ type: "text", text: "hi\\n" }], isError: false } });
    event(sid, "assistant/message", { message: { id: "a2", content: [{ type: "text", text: "回答：" + text }] } });
    return event(sid, "turn/end", { reason: { kind: "completed" } });
  }
});
`;

export const fakeClaudeSource = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.FAKE_LOG;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (entry) => appendFileSync(log, JSON.stringify(entry) + "\\n");
const args = process.argv.slice(2);
record({ args, env: { token: process.env.SUPER_AGENT_HUB_TOKEN ?? null, host: process.env.CLAUDECODE ?? null, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, brainOauth: process.env.BRAIN_CLAUDE_OAUTH_TOKEN ?? null } });
const resumeAt = args.indexOf("--resume");
const session = resumeAt >= 0 ? args[resumeAt + 1] : args[args.indexOf("--session-id") + 1];
if (session === "missing") {
  send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: missing"] });
  process.exit(1);
}
let pending = [];
let mode = "";
const delta = (id, text) => send({ type: "stream_event", parent_tool_use_id: null, api_message_id: id, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const result = (uuids, extra = {}) => send({ type: "result", subtype: "success", is_error: false, user_message_uuids: uuids, ...extra });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } } });
    send({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", errors: ["interrupted"] });
    pending = [];
    mode = "";
    return;
  }
  const text = message.message.content;
  if (mode === "wait") {
    mode = "";
    delta("msg-steer", "也做了：" + text);
    return result([...pending, message.uuid]);
  }
  if (mode === "split") {
    mode = "";
    result(pending);
    send({ type: "system", subtype: "init", session_id: session });
    delta("msg-next", "接着：" + text);
    return result([message.uuid]);
  }
  send({ type: "system", subtype: "init", session_id: session });
  pending = [message.uuid];
  if (text === "wait" || text === "split") {
    mode = text;
    return delta("msg-wait", "working");
  }
  if (text === "limit") {
    send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1800000000 } });
    send({ type: "assistant", error: "rate_limit", message: { id: "x", content: [{ type: "text", text: "You've hit your limit" }] } });
    return send({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit", terminal_reason: "api_error" });
  }
  delta("msg-1", "我来");
  delta("msg-1", "查。");
  send({ type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", content: [{ type: "text", text: "我来查。" }] } });
  send({ type: "assistant", parent_tool_use_id: null, message: { id: "msg-2", content: [{ type: "tool_use", id: "toolu-1", name: "mcp__hub__run_command", input: { target: "hub" } }] } });
  send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: [{ type: "text", text: "exited" }], is_error: false }] } });
  send({ type: "assistant", parent_tool_use_id: null, message: { id: "msg-3", content: [{ type: "text", text: "结果是 exited。" }] } });
  return result([message.uuid]);
});
`;

export function writeFake(directory: string, name: string, source: string): string {
  const path = join(directory, name);
  writeFileSync(path, source);
  return path;
}

export function readLog(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export class EventLog {
  readonly events: ProgramEvent[] = [];
  private waiters: { readonly check: (events: readonly ProgramEvent[]) => boolean; readonly resolve: () => void }[] = [];

  readonly listener = (event: ProgramEvent): void => {
    this.events.push(event);
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.check(this.events)) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  };

  until(check: (events: readonly ProgramEvent[]) => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (check(this.events)) {
        resolve();
        return;
      }
      this.waiters.push({ check, resolve });
    });
  }

  ended(count = 1): Promise<void> {
    return this.until(
      (events) => events.filter((event) => event.type === "turn.finished" || event.type === "failed" || event.type === "unavailable").length >= count,
    );
  }
}
