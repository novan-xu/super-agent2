import {
  type CommandRecord,
  CommandRequest,
  Difficulty,
  difficulties,
  finishedStates,
  GeneratedText,
  gitHubAccounts,
  defaultGitHubAccount,
  Platform,
  platforms,
  RepositoryName,
  TicketKind,
  ticketKinds,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { CommandService } from "./commands.js";
import type { ConversationService } from "./conversations.js";
import type { FilingOutcome, IssueFiler } from "./filing.js";
import { clip, commandReport, commandSummary, ticketLine, ticketReport } from "./reports.js";
import type { TicketService } from "./tickets.js";

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

const codeKinds = ticketKinds.filter((kind) => kind !== "writing");

const FileArguments = z.object({
  repository: RepositoryName,
  title: GeneratedText,
  summary: GeneratedText,
  body: z.string().trim().min(1),
  kind: TicketKind,
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
  account: z.enum(gitHubAccounts).optional(),
});

const OpenArguments = z.object({
  repository: RepositoryName,
  issue: z.number().int().positive(),
  title_zh: z.string().trim().min(1),
  summary: GeneratedText,
  kind: TicketKind,
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
  account: z.enum(gitHubAccounts).optional(),
});

const ListArguments = z.object({
  all: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const ReadTicketArguments = z.object({ ticket: z.number().int().positive() });

const StopTicketArguments = z.object({ ticket: z.number().int().positive(), reason: GeneratedText });

const generatedSchema = (what: string) => ({
  type: "object",
  properties: {
    en: { type: "string", description: `The ${what} in English` },
    zh: { type: "string", description: `The same ${what} in Simplified Chinese, for the owner` },
  },
  required: ["en", "zh"],
  additionalProperties: false,
});

const startChoices = {
  difficulty: { type: "string", enum: [...difficulties], description: "How hard the work is, if already judged" },
  platform: { type: "string", enum: [...platforms], description: "The platform the work needs, if it needs one" },
  account: { type: "string", enum: [...gitHubAccounts], description: "The GitHub account to act as; by default the account that owns the repository" },
};

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
  readonly machines?: () => string;
  readonly tickets?: TicketTools;
}

export interface TicketTools {
  readonly tickets: TicketService;
  readonly filer: IssueFiler;
}

function ticketDefinitions() {
  return [
    {
      name: "file_issue",
      title: "File an issue and open its ticket",
      description: [
        "Create a GitHub issue in a repository, as the account that owns it, and open a pending ticket for it.",
        "One issue per piece of work. Write the title and body in English so the issue stands alone: the worker knows only its issues and the repository. Put the assumptions you made in the body.",
        "The title and the summary also carry a Chinese copy, which is what the owner sees.",
        "Calling it again with the same repository, title and body after a failure does not create a second issue: an issue already there is used.",
        "This is a shortcut over run_command with gh; anything it does not cover can still be done that way, and open_ticket makes a ticket for an issue filed otherwise.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: "The repository as owner/name" },
          title: generatedSchema("issue title"),
          summary: generatedSchema("one or two sentence summary"),
          body: { type: "string", description: "The issue body in English Markdown: goal, scope, assumptions and when it is done" },
          kind: { type: "string", enum: codeKinds, description: "parameter: a value, constant or copy change with no logic change; maintenance: dependencies and CI" },
          ...startChoices,
        },
        required: ["repository", "title", "summary", "body", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "open_ticket",
      title: "Open a ticket for an existing issue",
      description:
        "Open a pending ticket for an issue that already exists on GitHub, for example one filed with gh through run_command. The English title is read from GitHub. If the issue already has a ticket that has not stopped, that ticket is returned.",
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: "The repository as owner/name" },
          issue: { type: "integer", minimum: 1, description: "The issue number" },
          title_zh: { type: "string", description: "The issue title in Simplified Chinese, for the owner" },
          summary: generatedSchema("one or two sentence summary"),
          kind: { type: "string", enum: codeKinds, description: "parameter: a value, constant or copy change with no logic change; maintenance: dependencies and CI" },
          ...startChoices,
        },
        required: ["repository", "issue", "title_zh", "summary", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "list_tickets",
      title: "List tickets",
      description: "List tickets, newest first: the open ones (pending, waiting, working, verifying), or all of them.",
      inputSchema: {
        type: "object",
        properties: {
          all: { type: "boolean", description: "Also list merged, delivered and stopped tickets" },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "At most this many" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "read_ticket",
      title: "Read a ticket",
      description: "Read a ticket: its repository, issues in order, kind, state, choices, branch, pull request, guided round, what it waits for, and its history of states.",
      inputSchema: {
        type: "object",
        properties: { ticket: { type: "integer", minimum: 1, description: "The ticket number" } },
        required: ["ticket"],
        additionalProperties: false,
      },
    },
    {
      name: "stop_ticket",
      title: "Stop a ticket",
      description: "Stop an open ticket and record why. A stopped ticket does not start again.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: { type: "integer", minimum: 1, description: "The ticket number" },
          reason: generatedSchema("reason for stopping"),
        },
        required: ["ticket", "reason"],
        additionalProperties: false,
      },
    },
  ];
}

function filingText(outcome: FilingOutcome): ToolResult {
  if (!outcome.ok) {
    return {
      text: outcome.held
        ? `${outcome.reason}\nNothing was filed yet. Tell the owner it waits for their confirmation; after they confirm, call the tool again with the same arguments.`
        : `Nothing was filed: ${outcome.reason}`,
      isError: !outcome.held,
    };
  }
  const issue = outcome.ticket.issues[0];
  const where = issue === undefined ? "" : `${issue.repository}#${issue.number} ${issue.url}`;
  const first = outcome.ticketExisted
    ? `This issue already has ticket ${outcome.ticket.id}; nothing new was opened.`
    : outcome.issueCreated
      ? `Filed ${where} and opened ticket ${outcome.ticket.id}.`
      : `Used the existing issue ${where} and opened ticket ${outcome.ticket.id}.`;
  return { text: `${first}\n${ticketReport(outcome.ticket)}` };
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

function machineText(described: string): string[] {
  return described === ""
    ? []
    : [
        `${described}.`,
        "A work machine runs the command as its user through its own shell (cmd.exe on Windows, /bin/sh on macOS), with no sandbox; a machine that is offline cannot run it.",
      ];
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
          ...machineText(options.machines?.() ?? ""),
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
      ...(options.tickets === undefined ? [] : ticketDefinitions()),
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

  const invalid = (error: z.ZodError): ToolResult => ({ text: `The arguments are not valid: ${error.message}`, isError: true });

  const ticketCall = async (name: string, raw: unknown, conversation: string | undefined): Promise<ToolResult | undefined> => {
    const tools = options.tickets;
    if (tools === undefined) {
      return undefined;
    }
    switch (name) {
      case "file_issue": {
        const parsed = FileArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return filingText(await tools.filer.file({ ...parsed.data, conversation }));
      }
      case "open_ticket": {
        const parsed = OpenArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const { issue, title_zh, ...rest } = parsed.data;
        return filingText(await tools.filer.open({ ...rest, number: issue, titleZh: title_zh, conversation }));
      }
      case "list_tickets": {
        const parsed = ListArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const listed = tools.tickets.list({ open: parsed.data.all !== true, ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }) });
        return { text: listed.length === 0 ? "There are no tickets." : listed.map(ticketLine).join("\n") };
      }
      case "read_ticket": {
        const parsed = ReadTicketArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const detail = tools.tickets.detail(parsed.data.ticket);
        return detail === undefined
          ? { text: `There is no ticket ${parsed.data.ticket}.`, isError: true }
          : { text: ticketReport(detail.ticket, detail.moves) };
      }
      case "stop_ticket": {
        const parsed = StopTicketArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const result = tools.tickets.stop(parsed.data.ticket, parsed.data.reason);
        if (result.ok) {
          return { text: `Stopped ticket ${result.ticket.id}.\n${ticketLine(result.ticket)}` };
        }
        return result.error === "not_found"
          ? { text: `There is no ticket ${parsed.data.ticket}.`, isError: true }
          : { text: `Ticket ${parsed.data.ticket} is ${result.ticket?.state ?? "finished"} and cannot be stopped.`, isError: true };
      }
      default:
        return undefined;
    }
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
      default: {
        const ticketResult = await ticketCall(parsed.data.name, parsed.data.arguments ?? {}, conversation);
        if (ticketResult === undefined) {
          return { status: 200, body: errorBody(id, -32602, `Unknown tool: ${parsed.data.name}`) };
        }
        result = ticketResult;
      }
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
