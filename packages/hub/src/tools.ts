import {
  type CommandRecord,
  CommandRequest,
  finishedStates,
  gitHubAccounts,
  defaultGitHubAccount,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { CommandService } from "./commands.js";
import type { ConversationService } from "./conversations.js";
import { clip, commandReport, commandSummary } from "./reports.js";

export const supportedMcpVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const toolServerName = "hub";

const JsonRpcId = z.union([z.string(), z.number()]);

const JsonRpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

const InitializeParams = z.looseObject({ protocolVersion: z.string().optional() });

const CallParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

const RunArguments = z.object({
  target: z.string().min(1),
  command: z.string().min(1),
  account: z.enum(gitHubAccounts).optional(),
  folder: z.string().min(1).optional(),
});

const ReadArguments = z.object({
  id: z.string().min(1),
  after: z.number().int().nonnegative().optional(),
});

const StopArguments = z.object({ id: z.string().min(1) });

type JsonRpcId = z.infer<typeof JsonRpcId>;

export type ToolReply =
  | { readonly status: 200; readonly body: Readonly<Record<string, unknown>> }
  | { readonly status: 202 }
  | { readonly status: 400; readonly body: Readonly<Record<string, unknown>> };

export interface ToolCall {
  readonly body: string;
  readonly conversation: string | undefined;
  readonly aborted: AbortSignal;
}

export interface ToolServer {
  handle(call: ToolCall): Promise<ToolReply>;
}

export interface ToolServerOptions {
  readonly commands: CommandService;
  readonly conversations: ConversationService;
  readonly targets: () => readonly string[];
}

interface ToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

function errorBody(id: JsonRpcId | null, code: number, message: string): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultBody(id: JsonRpcId, result: unknown): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, result };
}

function settled(command: CommandRecord): boolean {
  return command.state === "held" || finishedStates.includes(command.state);
}

function outputText(commands: CommandService, id: string, after = 0): { text: string; last: number } {
  const chunks = commands.output(id, after);
  return { text: chunks.map((chunk) => chunk.data).join(""), last: chunks.at(-1)?.seq ?? after };
}

function heldText(command: CommandRecord): string {
  return [
    `${commandSummary(command)} It is held until the owner confirms it on the web page.`,
    `Command: ${command.command}`,
    `Why it is held: ${command.reason ?? ""}`,
    "It has not run. You cannot confirm it yourself. Tell the owner it is waiting for their confirmation.",
    "You will be told the outcome in this conversation once the owner has answered.",
  ].join("\n");
}

export function createToolServer(options: ToolServerOptions): ToolServer {
  const { commands, conversations } = options;

  const definitions = () => {
    const targets = options.targets();
    return [
      {
        name: "run_command",
        title: "Run a shell command",
        description: [
          "Run a shell command on a target through the hub, with the owner's credentials, and wait until it ends.",
          `Targets now: ${targets.join(", ")}. "hub" runs in the hub's own container; "nas" runs on the NAS host.`,
          `The chosen GitHub account's token is in GH_TOKEN and GITHUB_TOKEN (default ${defaultGitHubAccount}).`,
          "A command that cannot be undone is held until the owner confirms it; the answer then says so, and the outcome is told later.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: `Where to run it: ${targets.join(", ")}` },
            command: { type: "string", description: "The shell command line" },
            account: { type: "string", enum: [...gitHubAccounts], description: "The GitHub account whose token the command gets" },
            folder: { type: "string", description: "The working folder on the target" },
          },
          required: ["target", "command"],
          additionalProperties: false,
        },
      },
      {
        name: "read_command",
        title: "Read a command",
        description: "Read a command's state and its output after the given output chunk number.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The command id" },
            after: { type: "integer", minimum: 0, description: "Read output chunks after this number" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "stop_command",
        title: "Stop a command",
        description: "Stop a running or held command at once.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "The command id" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    ];
  };

  const wait = (id: string, aborted: AbortSignal): Promise<CommandRecord | undefined> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (record: CommandRecord | undefined) => {
        if (done) {
          return;
        }
        done = true;
        unsubscribe();
        aborted.removeEventListener("abort", onAbort);
        resolve(record);
      };
      const onAbort = () => {
        const current = commands.get(id);
        if (current !== undefined && !settled(current)) {
          commands.stop(id);
        }
        finish(undefined);
      };
      const unsubscribe = commands.subscribe((event) => {
        if (event.type === "command" && event.command.id === id && settled(event.command)) {
          finish(event.command);
        }
      });
      aborted.addEventListener("abort", onAbort, { once: true });
      const current = commands.get(id);
      if (aborted.aborted) {
        onAbort();
      } else if (current === undefined || settled(current)) {
        finish(current);
      }
    });

  const run = async (raw: unknown, conversation: string | undefined, aborted: AbortSignal): Promise<ToolResult> => {
    const parsed = RunArguments.safeParse(raw);
    if (!parsed.success) {
      return { text: `The arguments are not valid: ${parsed.error.message}`, isError: true };
    }
    const request: CommandRequest = {
      target: parsed.data.target,
      command: parsed.data.command,
      ...(parsed.data.account === undefined ? {} : { account: parsed.data.account }),
      ...(parsed.data.folder === undefined ? {} : { cwd: parsed.data.folder }),
    };
    const checked = CommandRequest.safeParse(request);
    if (!checked.success) {
      return { text: `The arguments are not valid: ${checked.error.message}`, isError: true };
    }
    const started = commands.start(request);
    if (conversation !== undefined) {
      conversations.recordCommand(started.id, conversation);
    }
    const record = await wait(started.id, aborted);
    if (record === undefined) {
      return { text: `Command ${started.id} was stopped because the call was cancelled.`, isError: true };
    }
    if (record.state === "held") {
      return { text: heldText(record) };
    }
    return { text: commandReport(record, outputText(commands, record.id).text), isError: record.state !== "exited" };
  };

  const read = (raw: unknown): ToolResult => {
    const parsed = ReadArguments.safeParse(raw);
    if (!parsed.success) {
      return { text: `The arguments are not valid: ${parsed.error.message}`, isError: true };
    }
    const record = commands.get(parsed.data.id);
    if (record === undefined) {
      return { text: `There is no command ${parsed.data.id}.`, isError: true };
    }
    const output = outputText(commands, record.id, parsed.data.after ?? 0);
    return { text: `${commandReport(record, output.text)}\nLast output chunk: ${output.last}` };
  };

  const stop = (raw: unknown): ToolResult => {
    const parsed = StopArguments.safeParse(raw);
    if (!parsed.success) {
      return { text: `The arguments are not valid: ${parsed.error.message}`, isError: true };
    }
    const record = commands.stop(parsed.data.id);
    if (record === undefined) {
      return { text: `There is no command ${parsed.data.id}.`, isError: true };
    }
    return { text: commandSummary(record) };
  };

  const call = async (id: JsonRpcId, params: unknown, conversation: string | undefined, aborted: AbortSignal): Promise<ToolReply> => {
    const parsed = CallParams.safeParse(params);
    if (!parsed.success) {
      return { status: 200, body: errorBody(id, -32602, "Invalid tool call") };
    }
    let result: ToolResult;
    switch (parsed.data.name) {
      case "run_command":
        result = await run(parsed.data.arguments ?? {}, conversation, aborted);
        break;
      case "read_command":
        result = read(parsed.data.arguments ?? {});
        break;
      case "stop_command":
        result = stop(parsed.data.arguments ?? {});
        break;
      default:
        return { status: 200, body: errorBody(id, -32602, `Unknown tool: ${parsed.data.name}`) };
    }
    return {
      status: 200,
      body: resultBody(id, { content: [{ type: "text", text: clip(result.text, 60_000) }], isError: result.isError ?? false }),
    };
  };

  return {
    handle: async ({ body, conversation, aborted }) => {
      let message: z.infer<typeof JsonRpcMessage>;
      try {
        const parsed = JsonRpcMessage.safeParse(JSON.parse(body));
        if (!parsed.success) {
          return { status: 400, body: errorBody(null, -32600, "Invalid request") };
        }
        message = parsed.data;
      } catch {
        return { status: 400, body: errorBody(null, -32700, "Parse error") };
      }
      const { id, method } = message;
      if (id === undefined || method === undefined) {
        return { status: 202 };
      }
      switch (method) {
        case "initialize": {
          const requested = InitializeParams.safeParse(message.params).data?.protocolVersion;
          const version = supportedMcpVersions.find((known) => known === requested) ?? supportedMcpVersions[0];
          return {
            status: 200,
            body: resultBody(id, {
              protocolVersion: version,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: toolServerName, version: "0.0.0" },
            }),
          };
        }
        case "ping":
          return { status: 200, body: resultBody(id, {}) };
        case "tools/list":
          return { status: 200, body: resultBody(id, { tools: definitions() }) };
        case "tools/call":
          return call(id, message.params, conversation, aborted);
        default:
          return { status: 200, body: errorBody(id, -32601, `Method not found: ${method}`) };
      }
    },
  };
}
