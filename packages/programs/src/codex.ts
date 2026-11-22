import { conversationHeader, isNativeImage, turnHeader } from "@super-agent2/protocol";
import { z } from "zod";
import type { OpenOptions, ProgramAdapter, ProgramHandle, ProgramListener, PromptImage, SteerResult } from "./program.js";
import { exitReason, invocationOf, type LineProcess, spawnLines } from "./process.js";
import { createRpc, type Rpc } from "./rpc.js";
import { extraMcpVariable, type ProgramSettings, toolTokenVariable } from "./settings.js";

const ThreadResult = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
});
const TurnResult = z.looseObject({ turn: z.looseObject({ id: z.string() }) });

const Item = z.looseObject({
  type: z.string(),
  id: z.string(),
  text: z.string().optional(),
  command: z.string().optional(),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  status: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.looseObject({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional() }).nullable().optional(),
  error: z.looseObject({ message: z.string().optional() }).nullable().optional(),
  changes: z.unknown().optional(),
  query: z.string().optional(),
});
type Item = z.infer<typeof Item>;

const ItemEvent = z.looseObject({ item: Item, turnId: z.string().optional() });
const DeltaEvent = z.looseObject({ itemId: z.string(), delta: z.string(), turnId: z.string().optional() });
const TurnError = z.looseObject({ message: z.string().optional(), codexErrorInfo: z.unknown().optional() }).nullable().optional();
const TurnCompleted = z.looseObject({
  turn: z.looseObject({ id: z.string(), status: z.string(), error: TurnError }),
});
const TokenUsage = z.looseObject({
  threadId: z.string(),
  turnId: z.string().optional(),
  tokenUsage: z.looseObject({
    modelContextWindow: z.number().int().positive().nullable().optional(),
    last: z.object({ inputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(), cacheWriteInputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative(), reasoningOutputTokens: z.number().int().nonnegative() }).optional().catch(undefined),
  }),
});
const RateLimits = z.looseObject({
  rateLimits: z.looseObject({
    primary: z.looseObject({ resetsAt: z.number().nullable().optional() }).nullable().optional(),
    secondary: z.looseObject({ resetsAt: z.number().nullable().optional() }).nullable().optional(),
    rateLimitReachedType: z.string().nullable().optional(),
  }),
});

const limitInfos = new Set(["usageLimitExceeded", "rateLimitExceeded"]);

const unavailableInfos = new Set(["unauthorized", "serverOverloaded", "sessionBudgetExceeded", "flexUnavailable"]);

export type CodexOutcome =
  | { readonly kind: "limit"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

function statusOf(info: unknown): number | undefined {
  if (typeof info !== "object" || info === null) {
    return undefined;
  }
  for (const value of Object.values(info)) {
    if (typeof value === "object" && value !== null && "httpStatusCode" in value && typeof value.httpStatusCode === "number") {
      return value.httpStatusCode;
    }
  }
  return undefined;
}

export function classifyCodexError(error: { readonly message?: string | undefined; readonly codexErrorInfo?: unknown } | null | undefined): CodexOutcome {
  const reason = error?.message ?? "Codex reported a failed turn";
  const info = error?.codexErrorInfo;
  if (typeof info === "string" && limitInfos.has(info)) {
    return { kind: "limit", reason };
  }
  const status = statusOf(info);
  if (status === 429 || status === 402) {
    return { kind: "limit", reason };
  }
  if ((typeof info === "string" && unavailableInfos.has(info)) || status === 401 || status === 403 || (status ?? 0) >= 500) {
    return { kind: "unavailable", reason };
  }
  return { kind: "failed", reason };
}

function itemOutput(item: Item): string | null {
  if (item.type === "commandExecution") {
    return item.aggregatedOutput ?? null;
  }
  if (item.type === "mcpToolCall") {
    const texts = (item.result?.content ?? []).map((part) => part.text ?? "").filter((text) => text !== "");
    return texts.length > 0 ? texts.join("\n") : (item.error?.message ?? null);
  }
  return null;
}

function itemOk(item: Item): boolean {
  if (item.type === "commandExecution") {
    return item.status === "completed" && (item.exitCode ?? 0) === 0;
  }
  return item.status === undefined || item.status === "completed";
}

function toolOf(item: Item): { readonly name: string; readonly input: string } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { name: "shell", input: item.command ?? "" };
    case "mcpToolCall":
      return { name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, input: JSON.stringify(item.arguments ?? {}) };
    case "fileChange":
      return { name: "edit", input: JSON.stringify(item.changes ?? []) };
    case "webSearch":
      return { name: "web_search", input: item.query ?? "" };
    default:
      return undefined;
  }
}

export function codexInput(text: string, images: readonly PromptImage[]): Record<string, unknown>[] {
  return [{ type: "text", text, text_elements: [] }, ...images.filter((image) => isNativeImage(image.mediaType)).map((image) => ({ type: "localImage", path: image.path }))];
}

export function codexAdapter(settings: ProgramSettings): ProgramAdapter {
  return {
    provider: "gpt",
    model: settings.model,
    effort: settings.effort,
    open: (options, listener) => openCodex(settings, options, listener),
  };
}

function openCodex(settings: ProgramSettings, options: OpenOptions, listener: ProgramListener): ProgramHandle {
  let closed = false;
  let threadId: string | undefined = options.session ?? undefined;
  let activeTurn: string | undefined;
  let turnStarting: Promise<string | undefined> | undefined;
  let running = false;
  let interruptRequested = false;
  let limitUntil: number | null = null;
  const finishedTurns = new Set<string>();
  const streamed = new Set<string>();

  const tools = options.tools;
  const config = {
    model_reasoning_effort: settings.effort,
    ...(tools === null
      ? {}
      : {
          "mcp_servers.hub": {
            url: tools.url,
            bearer_token_env_var: toolTokenVariable,
            http_headers: { [conversationHeader]: tools.conversation, [turnHeader]: tools.turn },
            tool_timeout_sec: 86_400,
            startup_timeout_sec: 60,
          },
        }),
    ...settings.codexConfig,
    ...(options.toolset === "brain" || options.toolset === "mail" ? {
      "tools.update_plan.enabled": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.skill_search": false,
      "features.skip_host_skill_discovery": true,
      "features.sleep_tool": false,
      "features.apps": false,
    } : {}),
    ...(options.toolset === "mail" ? {
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.plugins": false,
      web_search: "disabled",
    } : {}),
    ...Object.fromEntries((options.extraMcp ?? []).map((server, index) => [`mcp_servers.${server.name}`, { url: server.url, bearer_token_env_var: extraMcpVariable(index) }])),
  };

  const emitEnd = (outcome: "completed" | "interrupted") => {
    running = false;
    activeTurn = undefined;
    listener({ type: "turn.finished", outcome });
  };

  const fail = (reason: string, lostSession = false) => {
    if (closed) {
      return;
    }
    running = false;
    activeTurn = undefined;
    listener({ type: "failed", reason, lostSession });
  };

  const relevant = (turnId: string | undefined) => turnId === undefined || !finishedTurns.has(turnId);

  const onNotification = (method: string, params: unknown) => {
    switch (method) {
      case "item/agentMessage/delta": {
        const event = DeltaEvent.safeParse(params);
        if (event.success && relevant(event.data.turnId)) {
          streamed.add(event.data.itemId);
          listener({ type: "text", block: event.data.itemId, delta: event.data.delta });
        }
        return;
      }
      case "item/commandExecution/outputDelta": {
        const event = DeltaEvent.safeParse(params);
        if (event.success && relevant(event.data.turnId)) {
          listener({ type: "tool.output", call: event.data.itemId, delta: event.data.delta });
        }
        return;
      }
      case "item/started": {
        const event = ItemEvent.safeParse(params);
        if (!event.success || !relevant(event.data.turnId)) {
          return;
        }
        const tool = toolOf(event.data.item);
        if (tool !== undefined) {
          listener({ type: "tool.started", call: event.data.item.id, name: tool.name, input: tool.input });
        }
        return;
      }
      case "item/completed": {
        const event = ItemEvent.safeParse(params);
        if (!event.success || !relevant(event.data.turnId)) {
          return;
        }
        const { item } = event.data;
        if (item.type === "agentMessage") {
          if (!streamed.has(item.id) && item.text !== undefined && item.text !== "") {
            listener({ type: "text", block: item.id, delta: item.text });
          }
          return;
        }
        if (toolOf(item) !== undefined) {
          listener({ type: "tool.finished", call: item.id, output: itemOutput(item), ok: itemOk(item) });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const event = TokenUsage.safeParse(params);
        if (event.success && event.data.threadId === threadId && relevant(event.data.turnId)) {
          const { modelContextWindow, last } = event.data.tokenUsage;
          if (modelContextWindow != null) listener({ type: "capacity", tokens: modelContextWindow });
          if (last !== undefined) listener({ type: "usage", input: Math.max(0, last.inputTokens - last.cachedInputTokens), cacheRead: last.cachedInputTokens, cacheWrite: last.cacheWriteInputTokens ?? null, output: last.outputTokens, reasoning: last.reasoningOutputTokens, costUsd: null });
        }
        return;
      }
      case "account/rateLimits/updated": {
        const event = RateLimits.safeParse(params);
        if (!event.success) {
          return;
        }
        const limits = event.data.rateLimits;
        const resetsAt = limits.primary?.resetsAt ?? limits.secondary?.resetsAt ?? null;
        limitUntil = limits.rateLimitReachedType !== null && limits.rateLimitReachedType !== undefined && resetsAt !== null ? resetsAt * 1000 : null;
        return;
      }
      case "turn/completed": {
        const event = TurnCompleted.safeParse(params);
        if (!event.success) {
          return;
        }
        const { turn } = event.data;
        finishedTurns.add(turn.id);
        if (activeTurn !== undefined && turn.id !== activeTurn) {
          return;
        }
        if (turn.status === "completed") {
          emitEnd("completed");
          return;
        }
        if (turn.status === "interrupted") {
          emitEnd("interrupted");
          return;
        }
        if (interruptRequested) {
          emitEnd("interrupted");
          return;
        }
        const outcome = classifyCodexError(turn.error);
        running = false;
        activeTurn = undefined;
        if (outcome.kind === "failed") {
          listener({ type: "failed", reason: outcome.reason, lostSession: false });
        } else {
          listener({ type: "unavailable", reason: outcome.reason, until: outcome.kind === "limit" ? limitUntil : null, category: outcome.kind === "limit" ? "limit" : turn.error?.codexErrorInfo === "serverOverloaded" ? "overload" : "problem" });
        }
        return;
      }
    }
  };

  const onRequest = (method: string): unknown => {
    if (options.toolset === "mail") {
      throw new Error("Mail review declines server requests");
    }
    if (method.endsWith("requestApproval")) {
      return { decision: "accept" };
    }
    if (method === "mcpServer/elicitation/request") {
      return { action: "accept", content: {}, _meta: null };
    }
    throw new Error(`The brain does not answer ${method}`);
  };

  let rpc: Rpc | undefined;
  const child: LineProcess = spawnLines(invocationOf(settings.program, ["app-server"]), {
    cwd: options.workspace,
    env: { ...settings.environment, ...(tools === null ? {} : { [toolTokenVariable]: tools.token }), ...Object.fromEntries((options.extraMcp ?? []).map((server, index) => [extraMcpVariable(index), server.token])) },
    onMessage: (message) => rpc?.handle(message),
    tree: settings.processTree === true,
  });
  rpc = createRpc({ write: (message) => child.write(message), jsonrpc: false, onNotification, onRequest });
  const client = rpc;

  void child.exited.then((exit) => {
    const reason = exitReason("codex", exit, child.stderr());
    client.failAll(reason);
    if (!closed) {
      fail(reason);
    }
  });

  const ready = (async () => {
    await client.request("initialize", {
      clientInfo: { name: settings.client ?? "super-agent2-brain", title: settings.client ?? "Super Agent brain", version: "0.0.0" },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    });
    client.notify("initialized");
    const common = { model: settings.model, cwd: options.workspace, approvalPolicy: "never",
      sandbox: options.toolset === "mail" ? "read-only" : "danger-full-access", config };
    const reportModel = (result: z.infer<typeof ThreadResult>) => {
      if (result.model !== undefined) {
        listener({ type: "model", model: result.model, effort: result.reasoningEffort ?? null });
      }
    };
    if (threadId === undefined) {
      const result = ThreadResult.parse(await client.request("thread/start", options.toolset === "mail" ? { ...common, ephemeral: true } : common));
      threadId = result.thread.id;
      listener({ type: "session", session: threadId });
      reportModel(result);
      return threadId;
    }
    try {
      const resumed = ThreadResult.safeParse(await client.request("thread/resume", { ...common, threadId, excludeTurns: true }));
      if (resumed.success) {
        reportModel(resumed.data);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), { lostSession: /no rollout found|not found/i.test(message) });
    }
    return threadId;
  })();
  ready.catch(() => undefined);

  return {
    start: (prompt, images = []) => {
      running = true;
      interruptRequested = false;
      const starting = ready
        .then(async (thread) => {
          const result = TurnResult.parse(
            await client.request("turn/start", { threadId: thread, input: codexInput(prompt, images), effort: settings.effort, model: settings.model }),
          );
          if (!finishedTurns.has(result.turn.id)) {
            activeTurn = result.turn.id;
          }
          if (interruptRequested && activeTurn !== undefined) {
            client.request("turn/interrupt", { threadId: thread, turnId: activeTurn }).catch(() => undefined);
          }
          return activeTurn;
        })
        .catch((error: unknown) => {
          const lost = typeof error === "object" && error !== null && "lostSession" in error && error.lostSession === true;
          fail(error instanceof Error ? error.message : String(error), lost);
          return undefined;
        });
      turnStarting = starting;
    },
    steer: async (text, images = []): Promise<SteerResult> => {
      const turn = activeTurn ?? (await turnStarting);
      if (!running || turn === undefined || threadId === undefined) {
        return "queued";
      }
      try {
        await client.request("turn/steer", { threadId, expectedTurnId: turn, input: codexInput(text, images) });
        return "steered";
      } catch {
        return "queued";
      }
    },
    interrupt: () => {
      interruptRequested = true;
      if (activeTurn !== undefined && threadId !== undefined) {
        client.request("turn/interrupt", { threadId, turnId: activeTurn }).catch(() => undefined);
      }
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
