import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { OpenOptions, ProgramAdapter, ProgramEvent, ProgramHandle, ProgramListener } from "../program.js";
import { exitReason, invocationOf, type LineProcess, spawnLines } from "./process.js";
import { createRpc, type Rpc } from "./rpc.js";
import { conversationVariable, type ProgramSettings, toolTokenVariable } from "./settings.js";

export const dshProvider = "deepseek-account";

const SessionEvent = z.looseObject({
  sessionId: z.string(),
  event: z.looseObject({ type: z.string(), data: z.unknown().optional() }),
});

const AssistantMessage = z.looseObject({
  message: z.looseObject({
    id: z.string().optional(),
    content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
  }),
});

const ToolCall = z.looseObject({ callId: z.string(), name: z.string(), arguments: z.unknown().optional() });

const ToolResult = z.looseObject({
  message: z.looseObject({
    toolCallId: z.string(),
    content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
    isError: z.boolean().optional(),
  }),
});

const TurnEnd = z.looseObject({
  reason: z.looseObject({
    kind: z.string(),
    error: z
      .looseObject({ code: z.string().optional(), message: z.string().optional(), providerRetryAfterMs: z.number().optional() })
      .optional(),
  }),
});

const limitCodes = new Set(["ACCOUNT_QUOTA", "QUOTA", "RATE_LIMIT"]);

const unavailableCodes = new Set([
  "ACCOUNT_SIGN_IN_REQUIRED",
  "ACCOUNT_TOKEN_INVALID",
  "AUTH",
  "MISSING_CREDENTIAL",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "CLIENT_UPGRADE_REQUIRED",
]);

export function dshTurnEnd(data: unknown, now: number): ProgramEvent | undefined {
  const parsed = TurnEnd.safeParse(data);
  if (!parsed.success) {
    return undefined;
  }
  const { reason } = parsed.data;
  switch (reason.kind) {
    case "completed":
    case "max-tokens":
      return { type: "turn.finished", outcome: "completed" };
    case "aborted":
    case "interrupted":
      return { type: "turn.finished", outcome: "interrupted" };
    case "error": {
      const code = reason.error?.code ?? "UNKNOWN";
      const message = `${code}: ${reason.error?.message ?? "dsh reported an error"}`;
      if (limitCodes.has(code)) {
        const after = reason.error?.providerRetryAfterMs;
        return { type: "unavailable", reason: message, until: after === undefined ? null : now + after };
      }
      if (unavailableCodes.has(code)) {
        return { type: "unavailable", reason: message, until: null };
      }
      return { type: "failed", reason: message, lostSession: false };
    }
    default:
      return { type: "failed", reason: `dsh ended the turn: ${reason.kind}`, lostSession: false };
  }
}

export function dshPatch(url: string): string {
  return [
    "- insert:",
    "    - id: super-agent-hub",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: hub",
    "        transport: streamable-http",
    `        url: ${JSON.stringify(url)}`,
    "        toolCallTimeoutMs: 86400000",
    "        headers:",
    `          Authorization: !!js '\`Bearer \${process.env.${toolTokenVariable}}\`'`,
    `          x-super-agent-conversation: !!js 'process.env.${conversationVariable}'`,
    "- id: session-log-deepseek",
    "  config:",
    "    enabled: false",
    "",
  ].join("\n");
}

function textOf(content: readonly { readonly type: string; readonly text?: string | undefined }[] | undefined): string {
  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

export function dshAdapter(settings: ProgramSettings): ProgramAdapter {
  return {
    provider: "deepseek",
    model: settings.model,
    effort: settings.effort,
    open: (options, listener) => openDsh(settings, options, listener),
  };
}

interface Running {
  readonly child: LineProcess;
  readonly rpc: Rpc;
  readonly ready: Promise<void>;
}

function openDsh(settings: ProgramSettings, options: OpenOptions, listener: ProgramListener): ProgramHandle {
  const patch = join(tmpdir(), `super-agent2-dsh-${randomUUID()}.yml`);
  writeFileSync(patch, dshPatch(options.tools.url));
  let session = options.session;
  let stored = options.session !== null;
  let current: Running | undefined;
  let running = false;
  let stopping = false;
  let closed = false;

  const fail = (reason: string, lostSession = false) => {
    if (closed) {
      return;
    }
    running = false;
    listener({ type: "failed", reason, lostSession });
  };

  const onEvent = (type: string, data: unknown) => {
    if (!running) {
      return;
    }
    switch (type) {
      case "assistant/message": {
        const parsed = AssistantMessage.safeParse(data);
        if (!parsed.success) {
          return;
        }
        const text = textOf(parsed.data.message.content);
        if (text !== "") {
          listener({ type: "text", block: parsed.data.message.id ?? randomUUID(), delta: text });
        }
        return;
      }
      case "tool/call": {
        const parsed = ToolCall.safeParse(data);
        if (parsed.success) {
          const input = typeof parsed.data.arguments === "string" ? parsed.data.arguments : JSON.stringify(parsed.data.arguments ?? {});
          listener({ type: "tool.started", call: parsed.data.callId, name: parsed.data.name, input });
        }
        return;
      }
      case "tool/result": {
        const parsed = ToolResult.safeParse(data);
        if (parsed.success) {
          const { message } = parsed.data;
          listener({ type: "tool.finished", call: message.toolCallId, output: textOf(message.content), ok: message.isError !== true });
        }
        return;
      }
      case "turn/end": {
        const event = dshTurnEnd(data, settings.clock.now());
        if (event !== undefined) {
          running = false;
          stored = true;
          listener(event);
        }
        return;
      }
    }
  };

  const launch = (): Running => {
    let rpc: Rpc | undefined;
    const child = spawnLines(invocationOf(settings.program, ["--profile", "sdk", "--patch", patch]), {
      cwd: options.workspace,
      env: {
        ...settings.environment,
        DSH_PERMISSION_MODE: "danger-full-access",
        [toolTokenVariable]: options.tools.token,
        [conversationVariable]: options.tools.conversation,
      },
      onMessage: (message) => rpc?.handle(message),
    });
    rpc = createRpc({
      write: (message) => child.write(message),
      jsonrpc: true,
      onNotification: (method, params) => {
        if (method !== "session.event") {
          return;
        }
        const parsed = SessionEvent.safeParse(params);
        if (parsed.success && parsed.data.sessionId === session) {
          onEvent(parsed.data.event.type, parsed.data.event.data);
        }
      },
      onRequest: (method) => {
        throw new Error(`The brain does not answer ${method}`);
      },
    });
    const client = rpc;
    const ready = (async () => {
      await client.request("initialize", {
        cwd: options.workspace,
        provider: dshProvider,
        model: settings.model,
        reasoningEffort: settings.effort,
      });
      if (session === null) {
        session = randomUUID();
        listener({ type: "session", session });
        return;
      }
      if (stored) {
        try {
          await client.request("session/resume", { sessionId: session });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(message), { lostSession: /not found/i.test(message) });
        }
      }
    })();
    ready.catch(() => undefined);
    const entry: Running = { child, rpc: client, ready };
    void child.exited.then((exit) => {
      const reason = exitReason("dsh", exit, child.stderr());
      client.failAll(reason);
      if (current === entry) {
        current = undefined;
      }
      if (closed) {
        return;
      }
      if (stopping) {
        stopping = false;
        if (running) {
          running = false;
          listener({ type: "turn.finished", outcome: "interrupted" });
        }
        return;
      }
      if (running) {
        fail(reason);
      }
    });
    return entry;
  };

  return {
    start: (prompt) => {
      running = true;
      stopping = false;
      const entry = current ?? launch();
      current = entry;
      entry.ready
        .then(() => entry.rpc.request("session/prompt", { sessionId: session, contentBlocks: [{ type: "text", text: prompt }] }))
        .then(() => {
          stored = true;
        })
        .catch((error: unknown) => {
          if (stopping) {
            return;
          }
          const lost = typeof error === "object" && error !== null && "lostSession" in error && error.lostSession === true;
          fail(error instanceof Error ? error.message : String(error), lost);
        });
    },
    steer: () => Promise.resolve("queued"),
    interrupt: () => {
      if (!running || current === undefined) {
        return;
      }
      stopping = true;
      current.child.kill();
    },
    close: async () => {
      closed = true;
      const entry = current;
      current = undefined;
      if (entry !== undefined) {
        entry.child.end();
        entry.child.kill();
        await entry.child.exited;
      }
      rmSync(patch, { force: true });
    },
  };
}
