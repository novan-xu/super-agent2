import {
  CodeEngineChoice,
  codeEngineChoices,
  type CommandRecord,
  CommandRequest,
  Difficulty,
  difficulties,
  finishedStates,
  GeneratedText,
  gitHubAccounts,
  defaultGitHubAccount,
  MaterialName,
  maximumMaterialText,
  maximumMaterials,
  Platform,
  platforms,
  RepositoryName,
  TicketKind,
  ticketKinds,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { ArrangeOutcome, ChainArranger, StateOutcome, TicketOutcome } from "./chains.js";
import type { StartDefaults } from "./defaults.js";
import type { CommandService } from "./commands.js";
import type { ConversationService } from "./conversations.js";
import type { FilingOutcome, IssueFiler } from "./filing.js";
import { allowanceReport, choiceText, clip, commandReport, commandSummary, ticketLine, ticketReport } from "./reports.js";
import type { TicketService } from "./tickets.js";
import type { WorkService } from "./work.js";

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

const MaterialArgument = z.object({
  name: MaterialName,
  source: z.string().trim().min(1).max(500),
  text: z.string().max(maximumMaterialText).optional(),
});

const WritingArguments = z.object({
  title: GeneratedText,
  summary: GeneratedText,
  task: z.string().trim().min(1).max(20_000),
  material: z.array(MaterialArgument).max(maximumMaterials).optional(),
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
});

const maximumMaterialTotal = 400_000;

const ListArguments = z.object({
  all: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const ReadTicketArguments = z.object({ ticket: z.number().int().positive() });

const StopTicketArguments = z.object({ ticket: z.number().int().positive(), reason: GeneratedText });

const MessageWorkerArguments = z.object({ ticket: z.number().int().positive(), text: z.string().trim().min(1).max(20_000) });

const ChainArgument = z.object({
  name: z.string().trim().min(1).max(100),
  repository: RepositoryName,
  issues: z.array(z.number().int().positive()).min(1).max(100),
  after: z.array(z.union([z.string().trim().min(1), z.number().int().positive()])).max(100).optional(),
  after_deployment: z.boolean().optional(),
  title: GeneratedText.optional(),
  summary: GeneratedText.optional(),
  kind: TicketKind.optional(),
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
});

const ArrangeArguments = z.object({ chains: z.array(ChainArgument).min(1).max(100) });

const TicketArgument = z.object({ ticket: z.number().int().positive() });

const DefaultsArgument = z.object({
  ticket: z.number().int().positive(),
  kind: TicketKind,
  issues: z.array(z.object({ number: z.number().int().positive(), difficulty: Difficulty })).max(100).optional(),
  difficulty: Difficulty.optional(),
  reason: GeneratedText,
  platform: Platform,
  engine: CodeEngineChoice.optional(),
});

const DefaultsArguments = z.object({ chains: z.array(DefaultsArgument).min(1).max(100) });

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
  readonly chains?: ChainArranger;
  readonly defaults?: StartDefaults;
  readonly work?: WorkService;
}

function defaultsDefinitions() {
  return [
    {
      name: "read_allowance",
      title: "Read what is left on the subscriptions",
      description:
        "Read what is left on the GPT subscription (Codex) and the Claude subscription (Claude Code), as the runners last read it from the programs themselves, and the work machines online with their system, programs and free slots. Read it before choosing a chain's engine with choose_defaults.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "choose_defaults",
      title: "State each chain's kind, difficulty, platform and engine",
      description: [
        "For each chain you arranged, and for each writing ticket you opened (a pending ticket), state once: its kind; the difficulty of each of its issues, of which the chain takes the highest; a one-line reason for that difficulty, in English with a Chinese copy, which the owner sees on the chain's card; its platform (macos, windows or any); and, for code work, its engine, codex or claude, chosen from what read_allowance says is left on each subscription.",
        "Difficulty: mechanical is a fixed procedure with a known result; standard is bounded implementation or diagnosis; complex is reasoning across modules, state or concurrency changes, or an open design decision.",
        "The hub then resolves the rest: the machine from the platform, the engines each runner has and its free slots, and the model and effort from its table by engine and difficulty. dsh is used only when both subscriptions are used up; writing goes to Antigravity.",
        "These are defaults: the owner can change the machine, engine, model and effort on the card, and the owner's choice wins. Rearranging a chain's issues clears what was stated for it; state it again.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          chains: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                ticket: { type: "integer", minimum: 1, description: "The chain's ticket number" },
                kind: { type: "string", enum: [...ticketKinds], description: "parameter: a value, constant or copy change with no logic change; maintenance: dependencies and CI; writing: pure prose" },
                issues: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      number: { type: "integer", minimum: 1 },
                      difficulty: { type: "string", enum: [...difficulties] },
                    },
                    required: ["number", "difficulty"],
                    additionalProperties: false,
                  },
                  description: "Every issue of the chain with its difficulty",
                },
                difficulty: { type: "string", enum: [...difficulties], description: "Only for a chain without issues (writing), where it does not change the model: standard when omitted" },
                reason: generatedSchema("one-line reason for the chain's difficulty"),
                platform: { type: "string", enum: [...platforms], description: "The platform the work needs" },
                engine: { type: "string", enum: [...codeEngineChoices], description: "For code work: codex (GPT) or claude (Claude Code), by what is left on each subscription" },
              },
              required: ["ticket", "kind", "reason", "platform"],
              additionalProperties: false,
            },
          },
        },
        required: ["chains"],
        additionalProperties: false,
      },
    },
  ];
}

function statedText(outcome: StateOutcome, defaults: StartDefaults): ToolResult {
  if (!outcome.ok) {
    return { text: outcome.reason, isError: true };
  }
  const lines = outcome.tickets.map((ticket) => `Ticket ${ticket.id}: ${ticket.kind}, ${ticket.difficulty ?? "?"}, ${ticket.platform ?? "?"}. ${choiceText(defaults.resolve(ticket))}`);
  lines.push("The owner sees these on the cards in 工作台 and can change them before the start.");
  return { text: lines.join("\n") };
}

function chainDefinitions() {
  return [
    {
      name: "arrange_chains",
      title: "Arrange pending tickets into chains",
      description: [
        "State the chains and the order between them, over issues whose tickets are pending (not started). Each chain becomes one ticket: one worker, one branch, one pull request, its issues worked on in the order given.",
        "Put on one chain the issues that depend on one another, and the issues that touch the same code and so cannot be worked on at the same time. Independent issues go on separate chains, which run in parallel.",
        "Cut a chain where the next issue is in another repository, needs another platform, or needs the earlier work merged (or merged and deployed) first: the issues after the cut are a chain of their own whose `after` names the earlier chain, and it begins by itself once that has merged (and, with after_deployment, once you report the deployment with report_deployment).",
        "`after` names other chains of this call by name, or tickets by number; a ticket that has already started can be named, which is how later work follows a started chain. A started chain is closed: its issues cannot be arranged again.",
        "Every issue of a pending ticket you touch must be named. A chain of several issues needs its own title and summary in English and Chinese; a chain that keeps one ticket's issues keeps that ticket's title. Tickets whose issues all went to other chains are closed as joined.",
        "The whole arrangement is checked first: one that has a cycle, or names an issue or ticket that does not exist, is refused and nothing changes. Calling it again with a new arrangement rearranges.",
        "Only the owner starts a chain, with 开始 on its card in 工作台; you cannot start one.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          chains: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "A short name for the chain, used by `after` in this call" },
                repository: { type: "string", description: "The repository as owner/name; every issue of a chain is in it" },
                issues: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, description: "The issue numbers in working order" },
                after: {
                  type: "array",
                  items: { anyOf: [{ type: "string" }, { type: "integer", minimum: 1 }] },
                  description: "What must merge before this chain begins: chain names of this call, or ticket numbers",
                },
                after_deployment: { type: "boolean", description: "Also wait until you report the earlier work deployed" },
                title: generatedSchema("chain title"),
                summary: generatedSchema("one or two sentence chain summary"),
                kind: { type: "string", enum: codeKinds, description: "The chain's kind, if not its first ticket's" },
                ...startChoices,
              },
              required: ["name", "repository", "issues"],
              additionalProperties: false,
            },
          },
        },
        required: ["chains"],
        additionalProperties: false,
      },
    },
    {
      name: "report_deployment",
      title: "Report merged work deployed",
      description:
        "Report that you deployed the merged work of a ticket. Tickets arranged to wait for its deployment begin by themselves once everything else they wait for has merged.",
      inputSchema: {
        type: "object",
        properties: { ticket: { type: "integer", minimum: 1, description: "The merged ticket whose work is deployed" } },
        required: ["ticket"],
        additionalProperties: false,
      },
    },
    {
      name: "proceed_ticket",
      title: "Let a waiting ticket go ahead",
      description:
        "A ticket the owner started waits for others to merge. When one of those stops, you are told, and decide: stop the waiting ticket with stop_ticket, or let it go ahead with this tool, which drops its wait on every stopped ticket; it then begins once what it still waits for has merged.",
      inputSchema: {
        type: "object",
        properties: { ticket: { type: "integer", minimum: 1, description: "The waiting ticket" } },
        required: ["ticket"],
        additionalProperties: false,
      },
    },
  ];
}

function arrangedText(outcome: ArrangeOutcome): ToolResult {
  if (!outcome.ok) {
    return { text: outcome.reason, isError: true };
  }
  const lines = outcome.chains.map(({ name, ticket }) => {
    const issues = ticket.issues.map((issue) => `#${issue.number}`).join(", ");
    const after =
      ticket.waits.length === 0
        ? "nothing before it"
        : `after ${ticket.waits.map((wait) => `ticket ${wait.ticket}${wait.deployment ? " (merged and deployed)" : ""}`).join(", ")}`;
    return `Chain ${name} is ticket ${ticket.id} in ${ticket.repository ?? ""}: ${issues}; ${after}.`;
  });
  if (outcome.joined.length > 0) {
    lines.push(`Closed as joined into other chains: ${outcome.joined.map((id) => `ticket ${id}`).join(", ")}.`);
  }
  lines.push("They wait for the owner to start them with 开始 on their cards in 工作台. Tell the owner, in Chinese, how the work is arranged.");
  return { text: lines.join("\n") };
}

function ticketOutcomeText(outcome: TicketOutcome, done: string): ToolResult {
  if (!outcome.ok) {
    return { text: outcome.reason, isError: true };
  }
  const began = outcome.began.length === 0 ? "Nothing began yet." : `Began: ${outcome.began.map((ticket) => `ticket ${ticket.id}`).join(", ")}.`;
  return { text: `${done}\n${ticketLine(outcome.ticket)}\n${began}` };
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
      name: "open_writing_ticket",
      title: "Open a ticket for writing work",
      description: [
        "Use this first whenever the owner asks you to produce a text for their own use, however short: an email, a letter, a message to someone, a translation, an article, a summary, a rewrite of a text. You never write such a text yourself in the conversation, not even as a draft; Antigravity writes it and it arrives in the conversation.",
        "Open a pending ticket for writing work that is prose unrelated to code: a translation, an article, an email, a summary, a letter, or other text work. It has no repository, no issue, no branch and no pull request; Antigravity does it on a work machine in a scratch folder, and its result, the text and any files, is delivered to the owner in the conversation you opened it from, with no verification.",
        "Decide by purpose and substance, never by file type. A README, developer documentation, code comments, a changelog or release notes for a repository, and the translation of engineering documents (specifications, design documents, API references) are code work: file an issue for them with file_issue and let a code engine do it. A text file is not code work just because it is a file, and a document is not writing work just because it is long.",
        "Give the task in English, with a Chinese title and summary for the owner. State the language of the result and any requirement on tone, length or format. The worker knows only this task and the material, not this conversation.",
        "Give the material in `material`: for each piece, its name (a plain file name), where it comes from (`source`: for example pasted by the owner in this conversation, a link, or a path on a machine), and its text when you have it, verbatim. A piece without `text` is described to the worker by its source only, and the worker gets it from there. Material the owner pasted in the conversation is passed on as `text`; you are the only way it reaches the worker.",
        "Afterwards state its defaults with choose_defaults (kind writing), as for any ticket. The owner starts it with 开始 on its card; you cannot start it.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          title: generatedSchema("ticket title"),
          summary: generatedSchema("one or two sentence summary"),
          task: { type: "string", description: "What to do, in English: the work, the language and form of the result, tone, length, anything the owner said that matters" },
          material: {
            type: "array",
            maxItems: maximumMaterials,
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "A plain file name for the piece, letters, digits, dots, hyphens and underscores, for example notice.txt" },
                source: { type: "string", description: "Where it comes from, in English" },
                text: { type: "string", description: "The text itself, verbatim, when you have it" },
              },
              required: ["name", "source"],
              additionalProperties: false,
            },
            description: "The material to work from",
          },
          difficulty: startChoices.difficulty,
          platform: startChoices.platform,
        },
        required: ["title", "summary", "task"],
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
      name: "message_worker",
      title: "Send a message to a ticket's worker",
      description:
        "Send a message to the worker running a ticket, in English. It reaches the worker in the middle of its work (or as its next turn when its program cannot take a message mid-turn). Use it to correct or guide a worker; the owner can do the same from the page.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: { type: "integer", minimum: 1, description: "The ticket number" },
          text: { type: "string", description: "The message, in English" },
        },
        required: ["ticket", "text"],
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
  return { text: `${first}\n${ticketReport(outcome.ticket)}\nOnce the issues for this need are filed, arrange them into chains with arrange_chains.` };
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
      ...(options.tickets?.chains === undefined ? [] : chainDefinitions()),
      ...(options.tickets?.chains === undefined || options.tickets.defaults === undefined ? [] : defaultsDefinitions()),
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
      case "open_writing_ticket": {
        const parsed = WritingArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const material = parsed.data.material ?? [];
        if (new Set(material.map((piece) => piece.name)).size !== material.length) {
          return { text: "Nothing was opened: two pieces of material have the same name.", isError: true };
        }
        if (material.reduce((total, piece) => total + (piece.text?.length ?? 0), 0) > maximumMaterialTotal) {
          return { text: `Nothing was opened: the material's text is more than ${maximumMaterialTotal} characters in all. Pass a long piece by its source instead of its text, or split the work.`, isError: true };
        }
        try {
          const ticket = tools.tickets.open({
            repository: null,
            issues: [],
            title: parsed.data.title,
            summary: parsed.data.summary,
            kind: "writing",
            difficulty: parsed.data.difficulty,
            platform: parsed.data.platform,
            conversation,
            writing: { task: parsed.data.task, materials: material.map((piece) => ({ name: piece.name, source: piece.source, text: piece.text ?? null })) },
          });
          return {
            text: [
              `Opened writing ticket ${ticket.id}.`,
              ticketReport(ticket),
              "Now state its defaults with choose_defaults (kind writing, its platform, a one-line reason). The owner starts it with 开始 on its card in 工作台; tell them in Chinese what it is and that it waits for their start.",
            ].join("\n"),
          };
        } catch (error) {
          return { text: `Nothing was opened: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
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
        if (detail === undefined) {
          return { text: `There is no ticket ${parsed.data.ticket}.`, isError: true };
        }
        const output = tools.work?.output(detail.ticket.id) ?? "";
        const writing = detail.ticket.kind === "writing" ? tools.tickets.writing(detail.ticket.id) : undefined;
        const report = [
          ticketReport(detail.ticket, detail.moves),
          ...(writing === undefined
            ? []
            : [
                `Task: ${writing.task}`,
                ...writing.materials.map((piece) => `Material ${piece.name}, from ${piece.source}${piece.text === null ? " (by its source only)" : ` (${piece.text.length} characters given)`}`),
              ]),
        ];
        return { text: output === "" ? report.join("\n") : [...report, "The latest worker's output ends with:", output].join("\n") };
      }
      case "message_worker": {
        if (tools.work === undefined) {
          return undefined;
        }
        const parsed = MessageWorkerArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const sent = tools.work.message(parsed.data.ticket, parsed.data.text, "brain");
        return sent.ok
          ? { text: `Sent to the worker of ticket ${parsed.data.ticket}. Read the ticket to see how it answers.` }
          : { text: sent.reason, isError: true };
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
      case "read_allowance": {
        if (tools.defaults === undefined) {
          return undefined;
        }
        return { text: allowanceReport(tools.defaults.subscriptions(), tools.defaults.machines()) };
      }
      case "choose_defaults": {
        if (tools.defaults === undefined || tools.chains === undefined) {
          return undefined;
        }
        const parsed = DefaultsArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return statedText(tools.chains.state(parsed.data.chains), tools.defaults);
      }
      default:
        return chainCall(tools.chains, name, raw);
    }
  };

  const chainCall = (chains: ChainArranger | undefined, name: string, raw: unknown): ToolResult | undefined => {
    if (chains === undefined) {
      return undefined;
    }
    switch (name) {
      case "arrange_chains": {
        const parsed = ArrangeArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return arrangedText(
          chains.arrange(
            parsed.data.chains.map((chain) => ({
              name: chain.name,
              repository: chain.repository,
              issues: chain.issues,
              after: chain.after,
              afterDeployment: chain.after_deployment,
              title: chain.title,
              summary: chain.summary,
              kind: chain.kind,
              difficulty: chain.difficulty,
              platform: chain.platform,
            })),
          ),
        );
      }
      case "report_deployment": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return ticketOutcomeText(chains.deployed(parsed.data.ticket), `Recorded that the work of ticket ${parsed.data.ticket} is deployed.`);
      }
      case "proceed_ticket": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return ticketOutcomeText(chains.proceed(parsed.data.ticket), `Ticket ${parsed.data.ticket} no longer waits for the tickets that stopped.`);
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
