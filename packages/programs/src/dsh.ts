import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { conversationHeader, isNativeImage, turnHeader } from "@super-agent2/protocol";
import { z } from "zod";
import type { OpenOptions, ProgramAdapter, ProgramEvent, ProgramHandle, ProgramListener, PromptImage, SteerResult } from "./program.js";
import { exitReason, invocationOf, type LineProcess, spawnLines } from "./process.js";
import { createRpc, type Rpc } from "./rpc.js";
import { conversationVariable, extraMcpVariable, type ProgramSettings, toolTokenVariable, turnVariable } from "./settings.js";

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

const RequestContext = z.looseObject({ contextWindow: z.number().int().positive() });

const DshInitialized = z.looseObject({ model: z.string().optional(), reasoningEffort: z.string().nullable().optional() });

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

export interface DshControl {
  readonly plugin: string;
  readonly path: string;
}

export const dshControlPlugin: string = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./dsh-control.ts" : "./dsh-control.js", import.meta.url));

const socketPathLimit = 100;

export function dshControlPath(platform: NodeJS.Platform = process.platform, folder: string = tmpdir()): string {
  const id = randomBytes(8).toString("hex");
  if (platform === "win32") {
    return `\\\\.\\pipe\\super-agent2-dsh-${id}`;
  }
  const path = join(folder, `super-agent2-dsh-${id}.sock`);
  return Buffer.byteLength(path) <= socketPathLimit ? path : `/tmp/super-agent2-dsh-${id}.sock`;
}

function controlRows(control: DshControl | null): string[] {
  if (control === null) {
    return [];
  }
  return [
    "    - id: super-agent2-control",
    `      name: ${JSON.stringify(control.plugin.replaceAll("\\", "/"))}`,
    "      config:",
    `        path: ${JSON.stringify(control.path)}`,
  ];
}

export function dshPatch(url: string | null, control: DshControl | null = null, extra: readonly import("@super-agent2/protocol").ExtraMcpServer[] = []): string {
  const quiet = ["- id: session-log-deepseek", "  config:", "    enabled: false", ""];
  const rows = controlRows(control);
  for (const [index, server] of extra.entries()) {
    rows.push(
      `    - id: super-agent-extra-${index}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      `        serverName: ${JSON.stringify(server.name)}`,
      "        transport: streamable-http",
      `        url: ${JSON.stringify(server.url)}`,
      "        headers:",
      `          Authorization: !!js '\`Bearer \${process.env.${extraMcpVariable(index)}}\`'`,
    );
  }
  if (url === null) {
    return [...(rows.length === 0 ? [] : ["- insert:", ...rows]), ...quiet].join("\n");
  }
  return [
    "- insert:",
    ...rows,
    "    - id: super-agent-hub",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: hub",
    "        transport: streamable-http",
    `        url: ${JSON.stringify(url)}`,
    "        toolCallTimeoutMs: 86400000",
    "        headers:",
    `          Authorization: !!js '\`Bearer \${process.env.${toolTokenVariable}}\`'`,
    `          ${conversationHeader}: !!js 'process.env.${conversationVariable}'`,
    `          ${turnHeader}: !!js 'process.env.${turnVariable}'`,
    ...quiet,
  ].join("\n");
}

export const dshImageBytes = 20 * 1024 * 1024;

export function dshImages(images: readonly PromptImage[]): PromptImage[] {
  return images.filter((image) => isNativeImage(image.mediaType) && image.size <= dshImageBytes);
}

export function dshContent(text: string, images: readonly PromptImage[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: "text", text }];
  for (const image of dshImages(images)) {
    try {
      blocks.push({ type: "image", data: readFileSync(image.path).toString("base64"), mimeType: image.mediaType.toLowerCase() });
    } catch {
      continue;
    }
  }
  return blocks;
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

interface ControlChannel {
  readonly path: string;
  link(): Rpc | undefined;
  close(): Promise<void>;
}

function openControl(path: string): ControlChannel {
  let link: { readonly socket: Socket; readonly rpc: Rpc } | undefined;
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    const rpc = createRpc({
      write: (message) => {
        socket.write(`${JSON.stringify(message)}\n`);
      },
      jsonrpc: true,
      onNotification: () => undefined,
      onRequest: (method) => {
        throw new Error(`The brain does not answer ${method}`);
      },
    });
    const entry = { socket, rpc };
    link?.socket.destroy();
    link = entry;
    createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      rpc.handle(message);
    });
    socket.on("close", () => {
      rpc.failAll("The dsh control connection closed");
      if (link === entry) {
        link = undefined;
      }
    });
  });
  server.on("error", () => undefined);
  server.listen(path);
  return {
    path,
    link: () => link?.rpc,
    close: () =>
      new Promise((resolve) => {
        link?.socket.destroy();
        link = undefined;
        server.close(() => {
          if (process.platform !== "win32") {
            rmSync(path, { force: true });
          }
          resolve();
        });
      }),
  };
}

const SessionStatus = z.looseObject({ sessionId: z.string(), status: z.string() });

function openDsh(settings: ProgramSettings, options: OpenOptions, listener: ProgramListener): ProgramHandle {
  const patch = join(tmpdir(), `super-agent2-dsh-${randomUUID()}.yml`);
  const control = openControl(dshControlPath());
  writeFileSync(patch, dshPatch(options.tools?.url ?? null, { plugin: dshControlPlugin, path: control.path }, options.extraMcp));
  let session = options.session;
  let stored = options.session !== null;
  let current: Running | undefined;
  let running = false;
  let stopping = false;
  let closed = false;
  let reportedModel = false;
  let interruptRequested = false;
  let busy = false;
  let delivered: Promise<boolean> | undefined;

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
      case "request/context": {
        const parsed = RequestContext.safeParse(data);
        if (parsed.success && options.tools !== null) {
          listener({ type: "capacity", tokens: parsed.data.contextWindow });
        }
        return;
      }
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

  const onStatus = (status: string) => {
    if (!running) {
      return;
    }
    if (status === "running") {
      busy = true;
      return;
    }
    if (status === "idle" && busy && interruptRequested) {
      running = false;
      listener({ type: "turn.finished", outcome: "interrupted" });
    }
  };

  const launch = (): Running => {
    let rpc: Rpc | undefined;
    const child = spawnLines(invocationOf(settings.program, ["--profile", "sdk", "--patch", patch]), {
      cwd: options.workspace,
      env: {
        ...settings.environment,
        ...Object.fromEntries((options.extraMcp ?? []).map((server, index) => [extraMcpVariable(index), server.token])),
        DSH_PERMISSION_MODE: "danger-full-access",
        ...(options.tools === null ? {} : {
          [toolTokenVariable]: options.tools.token, [conversationVariable]: options.tools.conversation, [turnVariable]: options.tools.turn,
        }),
      },
      onMessage: (message) => rpc?.handle(message),
      tree: settings.processTree === true,
    });
    rpc = createRpc({
      write: (message) => child.write(message),
      jsonrpc: true,
      onNotification: (method, params) => {
        if (method === "session.status") {
          const parsed = SessionStatus.safeParse(params);
          if (parsed.success && parsed.data.sessionId === session) {
            onStatus(parsed.data.status);
          }
          return;
        }
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
      const initialized = DshInitialized.safeParse(
        await client.request("initialize", {
          cwd: options.workspace,
          provider: dshProvider,
          model: settings.model,
          reasoningEffort: settings.effort,
        }),
      );
      if (initialized.success && initialized.data.model !== undefined && !reportedModel) {
        reportedModel = true;
        listener({ type: "model", model: initialized.data.model, effort: initialized.data.reasoningEffort ?? null });
      }
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
    start: (prompt, images = []) => {
      running = true;
      stopping = false;
      interruptRequested = false;
      busy = false;
      const entry = current ?? launch();
      current = entry;
      const delivery = entry.ready.then(async () => {
        if (interruptRequested) {
          return false;
        }
        const content = dshContent(prompt, images);
        try {
          await entry.rpc.request("session/prompt", { sessionId: session, contentBlocks: content });
        } catch (error) {
          if (content.length === 1 || interruptRequested) {
            throw error;
          }
          await entry.rpc.request("session/prompt", { sessionId: session, contentBlocks: [{ type: "text", text: prompt }] });
        }
        stored = true;
        return true;
      });
      delivered = delivery;
      delivery.then(
        (sent) => {
          if (!sent && running) {
            running = false;
            listener({ type: "turn.finished", outcome: "interrupted" });
          }
        },
        (error: unknown) => {
          if (stopping) {
            return;
          }
          const lost = typeof error === "object" && error !== null && "lostSession" in error && error.lostSession === true;
          fail(error instanceof Error ? error.message : String(error), lost);
        },
      );
    },
    steer: async (text, images = []): Promise<SteerResult> => {
      const link = control.link();
      if (!running || interruptRequested || link === undefined || session === null) {
        return "queued";
      }
      const shown = dshImages(images).map((image) => ({ path: image.path, mediaType: image.mediaType.toLowerCase() }));
      const result = await link.request("steer", { sessionId: session, text, images: shown }).catch(() => undefined);
      return result === "steered" ? "steered" : "queued";
    },
    interrupt: () => {
      const entry = current;
      if (!running || entry === undefined || interruptRequested) {
        return;
      }
      interruptRequested = true;
      const kill = () => {
        if (running && current === entry) {
          stopping = true;
          entry.child.kill();
        }
      };
      void delivered?.then(
        async (sent) => {
          if (!sent) {
            return;
          }
          const link = control.link();
          const result = link === undefined || session === null ? undefined : await link.request("cancel", { sessionId: session }).catch(() => undefined);
          if (result !== "cancelled" && result !== "idle") {
            kill();
          }
        },
        () => undefined,
      );
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
      await control.close();
      rmSync(patch, { force: true });
    },
    processId: () => current?.child.pid,
  };
}
