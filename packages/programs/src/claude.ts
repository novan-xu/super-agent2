import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { conversationHeader, isNativeImage, turnHeader } from "@super-agent2/protocol";
import { z } from "zod";
import type { OpenOptions, ProgramAdapter, ProgramEvent, ProgramHandle, ProgramListener, PromptImage, SteerResult } from "./program.js";
import { exitReason, invocationOf, type LineProcess, spawnLines } from "./process.js";
import { extraMcpVariable, type ProgramSettings, toolTokenVariable } from "./settings.js";

const keptVariables = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);

export const claudeTokenVariable = "BRAIN_CLAUDE_OAUTH_TOKEN";

export function claudeEnvironment(environment: Readonly<Record<string, string | undefined>>, token: string | null): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (/^(CLAUDE|ANTHROPIC|MCP_)/.test(name) && !keptVariables.has(name)) {
      continue;
    }
    result[name] = value;
  }
  const oauth = environment[claudeTokenVariable];
  if (oauth !== undefined && oauth !== "") {
    result["CLAUDE_CODE_OAUTH_TOKEN"] = oauth;
  }
  delete result[claudeTokenVariable];
  if (token !== null) {
    result[toolTokenVariable] = token;
  }
  if (process.platform !== "win32" && process.getuid?.() === 0) {
    result["IS_SANDBOX"] = "1";
  }
  return result;
}

export function claudeToolConfig(url: string, conversation: string, turn: string): string {
  return JSON.stringify({
    mcpServers: {
      hub: {
        type: "http",
        url,
        headers: { Authorization: `Bearer \${${toolTokenVariable}}`, [conversationHeader]: conversation, [turnHeader]: turn },
        alwaysLoad: true,
      },
    },
  });
}

export function claudeExtraConfig(options: OpenOptions): string {
  const hub = options.tools === null ? {} : JSON.parse(claudeToolConfig(options.tools.url, options.tools.conversation, options.tools.turn)).mcpServers;
  const extra = Object.fromEntries((options.extraMcp ?? []).map((server, index) => [server.name, { type: "http", url: server.url, headers: { Authorization: `Bearer \${${extraMcpVariable(index)}}` } }]));
  return JSON.stringify({ mcpServers: { ...hub, ...extra } });
}

export function claudeArguments(settings: ProgramSettings, options: OpenOptions, session: { readonly id: string; readonly resume: boolean }): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    settings.model,
    "--effort",
    settings.effort,
    "--setting-sources",
    "project",
    "--dangerously-skip-permissions",
    "--mcp-config",
    claudeExtraConfig(options),
    "--strict-mcp-config",
    session.resume ? "--resume" : "--session-id",
    session.id,
  ];
}

const Block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const Output = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  api_message_id: z.string().optional(),
  event: z
    .looseObject({
      type: z.string(),
      index: z.number().optional(),
      delta: z.looseObject({ type: z.string(), text: z.string().optional() }).optional(),
    })
    .optional(),
  message: z.looseObject({ id: z.string().optional(), content: z.union([z.string(), z.array(Block)]).optional() }).optional(),
  error: z.string().optional(),
  is_api_error_message: z.boolean().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  modelUsage: z.record(z.string(), z.looseObject({ contextWindow: z.number().int().positive().optional() })).optional().catch(undefined),
  errors: z.array(z.string()).optional(),
  terminal_reason: z.string().optional(),
  user_message_uuid: z.string().optional(),
  user_message_uuids: z.array(z.string()).optional(),
  rate_limit_info: z.looseObject({ status: z.string().optional(), resetsAt: z.number().optional() }).optional(),
});
type Output = z.infer<typeof Output>;

const limitErrors = new Set(["rate_limit", "billing_error", "usage_limit_reached", "model_requires_usage_credits"]);

const unavailableErrors = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "overloaded",
  "server_error",
  "cloud_credential_error",
  "connection_failed",
]);

export function claudeFailure(result: Output, lastError: string | undefined, limitUntil: number | null): ProgramEvent {
  const reason = result.result !== undefined && result.result !== "" ? result.result : (result.errors ?? []).join("; ") || "Claude Code reported an error";
  if ((result.errors ?? []).some((error) => error.includes("No conversation found"))) {
    return { type: "failed", reason, lostSession: true };
  }
  if (lastError !== undefined && limitErrors.has(lastError)) {
    return { type: "unavailable", reason, until: limitUntil, category: "limit" };
  }
  if (limitUntil !== null) {
    return { type: "unavailable", reason, until: limitUntil, category: "limit" };
  }
  if (lastError !== undefined && unavailableErrors.has(lastError)) {
    return { type: "unavailable", reason, until: null, category: lastError === "overloaded" || lastError === "server_error" ? "overload" : "problem" };
  }
  return { type: "failed", reason, lostSession: false };
}

export const claudeImageBytes = 20 * 1024 * 1024;

export function claudeContent(text: string, images: readonly PromptImage[]): string | Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const image of images) {
    if (!isNativeImage(image.mediaType) || image.size > claudeImageBytes) {
      continue;
    }
    try {
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mediaType.toLowerCase(), data: readFileSync(image.path).toString("base64") } });
    } catch {
      continue;
    }
  }
  return blocks.length === 0 ? text : [{ type: "text", text }, ...blocks];
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export function claudeAdapter(settings: ProgramSettings): ProgramAdapter {
  return {
    provider: "claude",
    model: settings.model,
    effort: settings.effort,
    open: (options, listener) => openClaude(settings, options, listener),
  };
}

function openClaude(settings: ProgramSettings, options: OpenOptions, listener: ProgramListener): ProgramHandle {
  const session = options.session ?? randomUUID();
  const fresh = options.session === null;
  let announced = false;
  let running = false;
  let interruptRequested = false;
  let closed = false;
  let lastError: string | undefined;
  let limitUntil: number | null = null;
  const outstanding = new Set<string>();
  const streamed = new Set<string>();
  let blocks = 0;
  let reportedModel: string | undefined;

  const finish = (event: ProgramEvent) => {
    running = false;
    outstanding.clear();
    listener(event);
  };

  const onOutput = (raw: unknown) => {
    const parsed = Output.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const output = parsed.data;
    if (output.type === "system" && output.subtype === "init") {
      if (fresh && !announced) {
        announced = true;
        listener({ type: "session", session });
      }
      if (output.model !== undefined && output.model !== reportedModel) {
        reportedModel = output.model;
        listener({ type: "model", model: output.model, effort: null });
      }
      return;
    }
    if (output.type === "rate_limit_event") {
      const info = output.rate_limit_info;
      limitUntil = info?.status === "rejected" && info.resetsAt !== undefined ? info.resetsAt * 1000 : null;
      return;
    }
    if (!running) {
      return;
    }
    if (output.type === "stream_event") {
      const event = output.event;
      if (output.parent_tool_use_id === null || output.parent_tool_use_id === undefined) {
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text !== undefined) {
          const message = output.api_message_id ?? "message";
          streamed.add(message);
          listener({ type: "text", block: `${message}:${event.index ?? 0}`, delta: event.delta.text });
        }
      }
      return;
    }
    if (output.type === "assistant") {
      if (output.error !== undefined || output.is_api_error_message === true) {
        lastError = output.error ?? "unknown";
        return;
      }
      const content = output.message?.content;
      if (!Array.isArray(content)) {
        return;
      }
      const message = output.message?.id ?? "message";
      for (const block of content) {
        if (block.type === "tool_use" && block.id !== undefined) {
          listener({ type: "tool.started", call: block.id, name: block.name ?? "tool", input: JSON.stringify(block.input ?? {}) });
        } else if (block.type === "text" && block.text !== undefined && block.text !== "" && !streamed.has(message) && output.parent_tool_use_id == null) {
          blocks += 1;
          listener({ type: "text", block: `${message}:whole:${blocks}`, delta: block.text });
        }
      }
      return;
    }
    if (output.type === "user") {
      const content = output.message?.content;
      if (!Array.isArray(content)) {
        return;
      }
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id !== undefined) {
          listener({ type: "tool.finished", call: block.tool_use_id, output: resultText(block.content), ok: block.is_error !== true });
        }
      }
      return;
    }
    if (output.type === "result") {
      if (interruptRequested) {
        finish({ type: "turn.finished", outcome: "interrupted" });
        return;
      }
      if (output.is_error === true) {
        const failure = claudeFailure(output, lastError, limitUntil);
        lastError = undefined;
        finish(failure);
        return;
      }
      const tokens = (output.modelUsage?.[reportedModel ?? settings.model] ?? output.modelUsage?.[settings.model])?.contextWindow;
      if (tokens !== undefined && options.tools !== null) {
        listener({ type: "capacity", tokens });
      }
      const covered = output.user_message_uuids ?? (output.user_message_uuid === undefined ? [...outstanding] : [output.user_message_uuid]);
      for (const id of covered) {
        outstanding.delete(id);
      }
      if (outstanding.size === 0) {
        finish({ type: "turn.finished", outcome: "completed" });
      }
    }
  };

  const child: LineProcess = spawnLines(invocationOf(settings.program, claudeArguments(settings, options, { id: session, resume: !fresh })), {
    cwd: options.workspace,
    env: { ...claudeEnvironment(settings.environment, options.tools?.token ?? null), ...Object.fromEntries((options.extraMcp ?? []).map((server, index) => [extraMcpVariable(index), server.token])) },
    onMessage: onOutput,
    tree: settings.processTree === true,
  });

  void child.exited.then((exit) => {
    if (closed || !running) {
      running = false;
      return;
    }
    finish({ type: "failed", reason: exitReason("claude", exit, child.stderr()), lostSession: /No conversation found/.test(child.stderr()) });
  });

  const send = (text: string, images: readonly PromptImage[]): string => {
    const uuid = randomUUID();
    outstanding.add(uuid);
    child.write({ type: "user", message: { role: "user", content: claudeContent(text, images) }, parent_tool_use_id: null, uuid });
    return uuid;
  };

  return {
    start: (prompt, images = []) => {
      if (!child.alive()) {
        throw new Error(exitReason("claude", { code: null, signal: null }, child.stderr()));
      }
      running = true;
      interruptRequested = false;
      lastError = undefined;
      send(prompt, images);
    },
    steer: (text, images = []): Promise<SteerResult> => {
      if (!running || interruptRequested || !child.alive()) {
        return Promise.resolve("queued");
      }
      send(text, images);
      return Promise.resolve("steered");
    },
    interrupt: () => {
      if (!running) {
        return;
      }
      interruptRequested = true;
      child.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt", cancel_queued: true } });
    },
    close: async () => {
      closed = true;
      child.end();
      child.kill();
      await child.exited;
    },
    processId: () => child.pid,
  };
}
