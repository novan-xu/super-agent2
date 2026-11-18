import {
  Questions,
  CodeEngineChoice,
  ProgramId,
  DifficultyRow,
  ModelChoice,
  unofferedChanges,
  codeEngineChoices,
  codeKinds,
  CommitRef,
  ConversationId,
  type CommandRecord,
  CommandRequest,
  Difficulty,
  difficulties,
  finishedStates,
  GeneratedText,
  gitHubAccounts,
  defaultGitHubAccount,
  deploymentFile,
  MaterialName,
  MessageId,
  mergedCommit,
  AttachmentId,
  type Attachment,
  openIssueNumbers,
  Platform,
  platforms,
  RepositoryName,
  roundCap,
  type TicketRound,
  TicketKind,
  ticketKinds,
  taskKinds,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { ArrangeOutcome, ChainArranger, StateOutcome, TicketOutcome } from "./chains.js";
import type { StartDefaults } from "./defaults.js";
import type { CommandService } from "./commands.js";
import { failureWords, type FailureLoop, type LoopOutcome } from "./failure-loop.js";
import type { ConversationService } from "./conversations.js";
import type { AttachmentStore } from "./attachments.js";
import type { FilingOutcome, IssueFiler } from "./filing.js";
import type { MemoryService } from "./memories.js";
import { memoryCall, memoryDefinitions } from "./memory-tools.js";
import { topicCall, topicDefinitions } from "./topic-tools.js";
import { allowanceReport, chainProgress, choiceText, clip, commandReport, commandSummary, decisionLine, decisionReport, repairReport, repairLines, ticketLine, ticketReport, waitedLine } from "./reports.js";
import type { TicketService } from "./tickets.js";
import { type TicketTurn, TicketWriteRefused } from "./ticket-versions.js";
import type { TaskTickets } from "./task-tickets.js";
import { hubTargetName } from "./targets.js";
import type { SkipOutcome, VerificationService } from "./verification.js";
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
  target: z.string().min(1).optional(),
  command: z.string().min(1),
  account: z.enum(gitHubAccounts).optional(),
  folder: z.string().min(1).optional(),
});

const ReadArguments = z.object({
  id: z.string().min(1),
  after: z.number().int().nonnegative().optional(),
});

const StopArguments = z.object({ id: z.string().min(1) });
const QuoteArguments = z.strictObject({ id: MessageId, offset: z.number().int().nonnegative().default(0) });
const HandoverArguments = z.strictObject({ destination: ConversationId, message: MessageId.optional() });
const AssignRepositoryArguments = z.strictObject({ repository: RepositoryName });

const CodeKind = z.enum(codeKinds);

const FileArguments = z.object({
  repository: RepositoryName,
  title: GeneratedText,
  summary: GeneratedText,
  body: z.string().trim().min(1),
  kind: CodeKind,
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
  account: z.enum(gitHubAccounts).optional(),
});

const OpenArguments = z.object({
  repository: RepositoryName,
  issue: z.number().int().positive(),
  title_zh: z.string().trim().min(1),
  summary: GeneratedText,
  kind: CodeKind,
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
  account: z.enum(gitHubAccounts).optional(),
});

const MaterialArgument = z.object({
  name: MaterialName,
  source: z.string().trim().min(1),
  text: z.string().optional(),
  attachment: AttachmentId.optional(),
});

const TaskArguments = z.object({
  title: GeneratedText,
  summary: GeneratedText,
  task: z.string().trim().min(1),
  kind: z.enum(taskKinds),
  material: z.array(MaterialArgument).optional(),
  repository: RepositoryName.optional(),
  commit: z.union([z.literal(mergedCommit), CommitRef]).optional(),
  deploy: z.boolean().optional(),
  after: z.array(z.number().int().positive()).optional(),
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
});

const ListArguments = z.object({
  all: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const ReadTicketArguments = z.object({ ticket: z.number().int().positive() });

const StopTicketArguments = z.object({ ticket: z.number().int().positive(), reason: GeneratedText });

const DecisionArguments = z.object({ ticket: z.number().int().positive(), chosen: GeneratedText, why: GeneratedText, other_options: GeneratedText });

const MessageWorkerArguments = z.object({ ticket: z.number().int().positive(), text: z.string().trim().min(1), attachments: z.array(AttachmentId).optional() });

const ChainArgument = z.object({
  name: z.string().trim().min(1).max(100),
  repository: RepositoryName,
  issues: z.array(z.number().int().positive()).min(1),
  after: z.array(z.union([z.string().trim().min(1), z.number().int().positive()])).optional(),
  after_deployment: z.boolean().optional(),
  title: GeneratedText.optional(),
  summary: GeneratedText.optional(),
  kind: CodeKind.optional(),
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
});

const ArrangeArguments = z.object({ chains: z.array(ChainArgument).min(1) });

const TicketArgument = z.object({ ticket: z.number().int().positive() });

const GuideArguments = z.object({ ticket: z.number().int().positive(), guidance: GeneratedText });

const StuckArguments = z.object({ ticket: z.number().int().positive(), where: GeneratedText });

const MergeArguments = z.object({ ticket: z.number().int().positive(), reason: z.string().trim().min(1) });

const DefaultsArgument = z.object({
  ticket: z.number().int().positive(),
  kind: TicketKind,
  issues: z.array(z.object({ number: z.number().int().positive(), difficulty: Difficulty })).optional(),
  difficulty: Difficulty.optional(),
  reason: GeneratedText,
  platform: Platform,
  engine: CodeEngineChoice.optional(),
});

const DefaultsArguments = z.object({ chains: z.array(DefaultsArgument).min(1) });

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
  readonly turn: string | undefined;
  readonly aborted: AbortSignal;
}

export interface ToolServer {
  handle(call: ToolCall): Promise<ToolReply>;
}

export interface ToolServerOptions {
  readonly commands: CommandService;
  readonly conversations: ConversationService;
  readonly tickets?: TicketTools;
  readonly memories?: MemoryService;
  readonly attachments?: AttachmentStore;
}

export interface TicketTools {
  readonly tickets: TicketService;
  readonly filer: IssueFiler;
  readonly tasks?: TaskTickets;
  readonly chains?: ChainArranger;
  readonly defaults?: StartDefaults;
  readonly work?: WorkService;
  readonly verification?: VerificationService;
  readonly loop?: FailureLoop;
}

function loopDefinitions() {
  return [
    {
      name: "guide_ticket",
      title: "Guide a failed ticket's worker into another round",
      description: [
        `When the hub tells you a ticket failed (a red workflow, a worker that ended without a pull request, a task worker that handed back that its task failed, a worker that crashed or was lost), read the failure and write guidance for its worker: what failed and why, and what to change. The worker then tries again, on the same branch or in the same folders, resuming its session where it can. That is one guided round. After ${roundCap} guided rounds without passing, the hub stops the ticket for the owner, and this tool refuses it; nothing you call can start a ${roundCap + 1}th round or lower the count.`,
        "A failure of the machine (lost, prepare) starts a retry that is not counted, once in a row.",
        "Refused for a ticket whose worker still runs (use message_worker), for a ticket with nothing failed, and for a ticket stopped for the owner.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          ticket: { type: "integer", minimum: 1, description: "The failed ticket" },
          guidance: generatedSchema("guidance to the worker: what failed and why, and what to change; the worker gets the English, the owner sees the Chinese in the ticket's timeline"),
        },
        required: ["ticket", "guidance"],
        additionalProperties: false,
      },
    },
    {
      name: "describe_stuck",
      title: "Say where a stopped ticket is stuck",
      description:
        "For a ticket the hub stopped for the owner at the retry cap: say in a few sentences where it is stuck, what each round tried, and what you think the owner should decide. The owner reads the Chinese on the ticket's card in 等你. It does not resume the ticket; only the owner does, on the card.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: { type: "integer", minimum: 1, description: "The ticket stopped for the owner" },
          where: generatedSchema("description of where the ticket is stuck"),
        },
        required: ["ticket", "where"],
        additionalProperties: false,
      },
    },
  ];
}

function roundLines(rounds: readonly TicketRound[]): string[] {
  return rounds.map(
    (round) =>
      `${round.round === null ? "Retry not counted" : `Guided round ${round.round}`} (attempt ${round.attempt}, ${new Date(round.at).toISOString()}) after ${failureWords[round.failure.kind]}${round.failure.detail === "" ? "" : ` (${round.failure.detail})`}. Your guidance: ${round.guidance.en}`,
  );
}

function loopText(outcome: LoopOutcome, done: (ticket: number) => string): ToolResult {
  if (!outcome.ok) {
    return { text: `Nothing was changed: ${outcome.reason}`, isError: true };
  }
  return { text: `${done(outcome.ticket.id)}\n${ticketLine(outcome.ticket)}` };
}

function verificationDefinitions() {
  return [
    {
      name: "merge_ticket",
      title: "Merge a ticket with the verification rules skipped",
      description: [
        "Merge the pull request of a ticket in verifying now, skipping the verification rules. Use it only when the owner asked for the rules to be skipped.",
        "The pull request's current head is merged once, as an ordinary merge: the issues it closes are closed. When that closes the last open issue of the chain, the ticket is merged: its worktree is removed, the tickets that wait for it begin, and you are told whether the change needs deploying. Otherwise its worker continues with the open issues, and the rules apply again to its next pull request.",
        "A conflict with the default branch still goes back to the worker; once it hands back again the rules apply, and you call this again if the owner still wants them skipped.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          ticket: { type: "integer", minimum: 1, description: "The ticket in verifying" },
          reason: { type: "string", description: "Why the rules are skipped: what the owner asked, in English" },
        },
        required: ["ticket", "reason"],
        additionalProperties: false,
      },
    },
  ];
}

function mergedText(outcome: SkipOutcome): ToolResult {
  if (!outcome.ok) {
    return { text: `Nothing was merged: ${outcome.reason}`, isError: true };
  }
  const ticket = outcome.ticket;
  const reason = ticket.verification?.reason ?? null;
  const commit = ticket.verification?.mergeCommit ?? null;
  if (ticket.state === "merged") {
    return { text: `Merged ticket ${ticket.id} with the rules skipped${commit === null ? "" : ` as commit ${commit}`}.\n${ticketLine(ticket)}\nYou are told separately what was closed and whether it needs deploying.` };
  }
  const last = ticket.pullRequests.at(-1);
  if (ticket.state === "working" && last?.state === "merged") {
    return {
      text: `Merged pull request #${last.number} of ticket ${ticket.id} with the rules skipped${last.mergeCommit === null ? "" : ` as commit ${last.mergeCommit}`}. The chain is not done: its worker continues with ${openIssueNumbers(ticket).map((number) => `#${number}`).join(", ")}, and the rules apply again to its next pull request.\n${ticketLine(ticket)}`,
    };
  }
  if (ticket.state === "working") {
    return { text: `Ticket ${ticket.id} was not merged: ${reason ?? "it went back to its worker"}. When the worker hands back the pull request again, the rules apply again.\n${ticketLine(ticket)}` };
  }
  return { text: `Ticket ${ticket.id} is not merged yet: ${reason ?? "it is still being checked"}. The hub keeps trying.\n${ticketLine(ticket)}`, isError: ticket.verification?.state === "conflict" };
}

function defaultsDefinitions() {
  return [
    {
      name: "set_engine_row",
      title: "Change one start-defaults row",
      description: "Change one engine row only after the owner agrees in this conversation. Changed model and effort pairs must be offered by an online machine.",
      inputSchema: { type: "object", properties: { engine: { type: "string", enum: ["codex", "claude", "dsh", "antigravity"] }, row: { type: "object", description: "For codex, claude or dsh: mechanical, standard and complex, each with model and effort. For antigravity: model and effort." } }, required: ["engine", "row"], additionalProperties: false },
    },
    {
      name: "read_allowance",
      title: "Read provider allowances",
      description:
        "Read what is left on the GPT subscription (Codex) and the Claude subscription (Claude Code), and the DeepSeek balance from dsh, as the runners last read it from the programs themselves, the worker programs the hub has marked unavailable because they reported it when really called, and the work machines online with their system, programs and free slots. Read it before choosing a chain's engine with choose_defaults.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "choose_defaults",
      title: "State each chain's kind, difficulty, platform and engine",
      description: [
        "For each chain you arranged, and for each task ticket you opened (a pending ticket), state once: its kind; the difficulty of each of its issues, of which the chain takes the highest, or for a task ticket its difficulty; a one-line reason for that difficulty, in English with a Chinese copy, which the owner sees on the card; its platform (macos, windows or any); and, for anything but writing, its engine, codex or claude, chosen from what read_allowance says is left on each subscription.",
        "Difficulty: mechanical is a fixed procedure with a known result; standard is bounded implementation or diagnosis; complex is reasoning across modules, state or concurrency changes, or an open design decision.",
        "The hub then resolves the rest: the machine from the platform (a deployment's machine is the one its deployment file names, and only that one), the engines each runner has and its free slots, and the model and effort from its table by engine and difficulty. dsh is used only when both subscriptions are used up; writing goes to Antigravity, which never runs a code ticket.",
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
                kind: {
                  type: "string",
                  enum: [...ticketKinds],
                  description: "For a code ticket: parameter (a value, constant or copy change with no logic change), fix, feature, refactor, maintenance (dependencies and CI). For a task ticket: writing (prose with nothing to do with code) or operation (anything done on a machine)",
                },
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
                difficulty: { type: "string", enum: [...difficulties], description: "For a task ticket, which has no issues: its difficulty (standard when omitted for writing, whose model does not depend on it)" },
                reason: generatedSchema("one-line reason for the chain's difficulty"),
                platform: { type: "string", enum: [...platforms], description: "The platform the work needs" },
                engine: { type: "string", enum: [...codeEngineChoices], description: "For anything but writing: codex (GPT) or claude (Claude Code), by what is left on each subscription" },
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
        "State the chains and the order between them, over issues whose tickets are pending (not started). Each chain becomes one ticket: its issues, worked on in the order given, handed once to one worker, which opens as many pull requests for them as it sees fit; the hub merges each one and gives the worker the rest, and the chain is merged when every issue of it is closed.",
        "Put on one chain the issues that depend on one another, and the issues that touch the same code and so cannot be worked on at the same time. Independent issues go on separate chains, which run in parallel.",
        "Cut a chain where the next issue is in another repository, needs another platform, or needs the earlier work merged (or merged and deployed) first: the issues after the cut are a chain of their own whose `after` names the earlier chain, and it begins by itself once that has merged (and, with after_deployment, once a task ticket that deploys it is done, or you record the deployment with report_deployment). A chain may also come after a task ticket, such as the deployment, by its number: it begins once that ticket is done.",
        "`after` names other chains of this call by name, or tickets by number; a ticket that has already started can be named, which is how later work follows a started chain. A started chain is closed: its issues cannot be arranged again. A task ticket arranged after a chain you rearrange follows the chains its issues went to.",
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
                  description: "What must merge, or be done, before this chain begins: chain names of this call, or ticket numbers",
                },
                after_deployment: { type: "boolean", description: "Also wait until the earlier work is deployed: a task ticket that deploys it is done, or you record it with report_deployment" },
                title: generatedSchema("chain title"),
                summary: generatedSchema("one or two sentence chain summary"),
                kind: { type: "string", enum: [...codeKinds], description: "The chain's kind, if not its first ticket's" },
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
      title: "Record merged work as deployed",
      description:
        "Record that the merged work of a code ticket is deployed by other means than a task ticket that deploys it (which marks what it deploys by itself): the owner deployed it by hand, say. Tickets arranged to wait for its deployment begin by themselves once everything else they wait for has merged.",
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
        "A ticket the owner started waits for others to merge or be done. When one of those stops, you are told, and decide: stop the waiting ticket with stop_ticket, or let it go ahead with this tool, which drops its wait on every stopped ticket; it then begins once what it still waits for has merged or is done.",
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
        "Usually one issue per piece of work. Write the title and body in English so the issue stands alone: the worker knows only its issues and the repository. The body is a fairly complete plan in advising language (suggested, recommended), with firm wording only for what the owner explicitly required. Record what you decided on the owner's behalf with record_decision against the ticket this opens.",
        "The title and the summary also carry a Chinese copy, which is what the owner sees.",
        "Calling it again with the same repository, title and body after a failure does not create a second issue: an issue already there is used.",
        "This is a shortcut over run_command with gh; anything it does not cover can still be done that way, and open_ticket makes a ticket for an issue filed otherwise. A code ticket is for repository work that ends in pull requests; anything else a worker does on a machine is a task ticket (open_task_ticket).",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: "The repository as owner/name" },
          title: generatedSchema("issue title"),
          summary: generatedSchema("one or two sentence summary"),
          body: { type: "string", description: "The issue body in English Markdown, a plan: background, goal, a suggested approach, what is in and out of scope, open points each with a recommended option, and what done means" },
          kind: { type: "string", enum: [...codeKinds], description: "parameter: a value, constant or copy change with no logic change; maintenance: dependencies and CI" },
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
          kind: { type: "string", enum: [...codeKinds], description: "parameter: a value, constant or copy change with no logic change; maintenance: dependencies and CI" },
          ...startChoices,
        },
        required: ["repository", "issue", "title_zh", "summary", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "open_task_ticket",
      title: "Open a task ticket",
      description: [
        "Open a pending task ticket: anything a worker does on a work machine that is not a code ticket's pull requests. Prose (a translation, an article, an email, a summary), an operation on a machine (deploying a repository, running a script, setting something up, checking something there), and anything else in words. A worker does it on a machine, in a scratch folder, and hands back an outcome (done or failed), a report, and any text and files; the result is delivered to the owner in the conversation you opened it from, and nothing is verified. A task ticket whose worker hands back failed goes through the failure loop like any failed work.",
        "Decide by purpose and substance, never by file type. A README, developer documentation, code comments, a changelog or release notes for a repository, and the translation of engineering documents (specifications, design documents, API references) are code work: file an issue for them with file_issue. A text file is not code work just because it is a file, and a document is not prose just because it is long.",
        "kind is writing for prose with nothing to do with code, which Antigravity does by default, or operation for anything done on a machine, which a code engine does by default.",
        "Give the task in English, with a Chinese title and summary for the owner: what to do, the result wanted, what done means, and anything the owner said that matters. The worker knows only this task, the material and, when one is named, the repository; not this conversation.",
        "Give the material in `material`: for each piece, its name (a plain file name), where it comes from (`source`), and its text when you have it, verbatim; a piece without `text` is described by its source only. A file the owner attached in this conversation is passed on as the file itself, by its attachment id in `attachment`, with a name that keeps its extension.",
        `When the task needs a repository (a deployment, a script that lives in it), name it in \`repository\`, and the worker gets a checkout of it beside its scratch folder, at \`commit\`: a SHA, a branch (its head when the work begins), or "${mergedCommit}", the final merge commit of the code chain of that repository this ticket comes \`after\`, filled in by the hub when the work begins. Without \`commit\`, the default branch's head when the work begins.`,
        `With \`deploy\` true the task is to deploy the repository by its ${deploymentFile} (where it runs, how to deploy, how to check health, how to roll back): the hub reads the file on the default branch and runs the ticket only on the machine it names; the worker deploys, checks health, rolls back when the new version does not come up, and reports what happened. Opened after a code chain of that repository, its commit is "${mergedCommit}" unless you name another.`,
        "`after` names tickets this one waits for, by number: it begins by itself once they have merged or are done. Arranged after a chain that is not started yet, the owner's one 开始 on that chain starts both, and the work begins when the chain has merged. Arranged after a ticket already started, it waits for its own 开始.",
        "Afterwards state its defaults with choose_defaults (kind writing or operation), as for any ticket. The owner starts it; you cannot start it.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          title: generatedSchema("ticket title"),
          summary: generatedSchema("one or two sentence summary"),
          task: { type: "string", description: "What to do, in English: the work, the result wanted and what done means, anything the owner said that matters" },
          kind: { type: "string", enum: [...taskKinds], description: "writing: prose with nothing to do with code; operation: anything done on a machine" },
          material: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "A plain file name for the piece, letters, digits, dots, hyphens and underscores, for example notice.txt" },
                source: { type: "string", description: "Where it comes from, in English" },
                text: { type: "string", description: "The text itself, verbatim, when you have it" },
                attachment: { type: "string", description: "The attachment id of a file the owner attached in this conversation, to pass on the file itself" },
              },
              required: ["name", "source"],
              additionalProperties: false,
            },
            description: "The material to work from",
          },
          repository: { type: "string", description: "The repository as owner/name, when the task needs a checkout of it" },
          commit: { type: "string", description: `The commit of the checkout: a SHA, a branch, or "${mergedCommit}" for the final merge commit of the code chain it comes after` },
          deploy: { type: "boolean", description: `Deploy the repository by its ${deploymentFile}` },
          after: { type: "array", items: { type: "integer", minimum: 1 }, description: "Ticket numbers this one waits for" },
          difficulty: startChoices.difficulty,
          platform: startChoices.platform,
        },
        required: ["title", "summary", "task", "kind"],
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
      description: "Read a ticket and remember its current version for this topic. Use this before making changes to the ticket. Shows its issues, state, choices, branch, pull request, dependencies, history, and decisions with the owner's reviews.",
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
          attachments: {
            type: "array",
            items: { type: "string", description: "An attachment id" },
            description: "Files the owner attached in this conversation to pass on to the worker, by their attachment ids; each reaches the worker's machine as the file itself",
          },
        },
        required: ["ticket", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "record_decision",
      title: "Record a decision made on the owner's behalf",
      description: [
        "Record, against a ticket, something you chose on the owner's behalf where the owner might have chosen differently: an assumption you made when filing its issues or task, what you told its worker in a guided round or a message, how you arranged, cut or joined the work. The test is whether the owner would have wanted to be asked.",
        "The record lives in the hub, not in this conversation, so a new conversation or another model loses nothing. The owner sees each decision on the ticket's page, with 可以 and a box for an opinion; it is listed in the ticket's end report (merged, done, stuck or stopped); and once the owner has gone through the ticket's decisions, every opinion comes back to you in one message. Nothing waits on the review.",
        "You can record at any time, in any state of the ticket. The same decision recorded twice is kept once. Workers record their own decisions when they hand in; do not record those again.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          ticket: { type: "integer", minimum: 1, description: "The ticket the decision belongs to" },
          chosen: generatedSchema("statement of what was chosen"),
          why: generatedSchema("reason it was chosen"),
          other_options: generatedSchema("the other options there were, and why they were not taken"),
        },
        required: ["ticket", "chosen", "why", "other_options"],
        additionalProperties: false,
      },
    },
    {
      name: "stop_ticket",
      title: "Stop a ticket",
      description: "Stop an open ticket and record why. A stopped ticket does not start again; if the owner later wants its work finished, open_repair_ticket opens a new ticket that continues it.",
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
    {
      name: "open_repair_ticket",
      title: "Open a repair ticket for a stopped ticket",
      description: [
        "Open a pending repair ticket that carries on the work a stopped ticket left, when the owner asks for that in conversation: the work of a ticket the owner stopped, or one you stopped, and that they now want finished.",
        "For a code ticket the repair holds the issues still open and continues on the same branch (its worker hands in the open pull request again, or a new one); what is merged stays merged. For a task ticket it is the same task. The repair keeps the kind, difficulty, platform and repository; what waited for the stopped ticket waits for the repair; its worker is given what the earlier workers did and what failed.",
        "Refused when the ticket has not stopped (a stuck ticket is the owner's to decide on its card, where giving it up opens a repair by itself), when it was joined into another ticket, when it already has a repair (repair that one instead, if it stopped too), or when nothing remains.",
        "Afterwards state its defaults with choose_defaults, as for any ticket. The owner starts it; you cannot start it.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: { ticket: { type: "integer", minimum: 1, description: "The stopped ticket whose work should go on" } },
        required: ["ticket"],
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
        : outcome.reason,
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

export function createToolServer(options: ToolServerOptions): ToolServer {
  const { commands, conversations } = options;

  const definitions = () => {
    return [
      {
        name: "run_command",
        title: "Run a shell command",
        description: [
          "Run a shell command in the hub's own container on the NAS, with the owner's credentials, and wait until it ends.",
          "It is the only place a command of yours runs: nothing runs on the NAS host, and nothing on a work machine. Work on a machine is a task ticket for a worker there, which the owner starts.",
          `The chosen GitHub account's token is in GH_TOKEN and GITHUB_TOKEN (default ${defaultGitHubAccount}).`,
          "A command that cannot be undone is held until the owner confirms it; the answer then says so, and the outcome is told later.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: [hubTargetName], description: "Where it runs: always hub, the hub's own container" },
            command: { type: "string", description: "The shell command line" },
            account: { type: "string", enum: [...gitHubAccounts], description: "The GitHub account whose token the command gets" },
            folder: { type: "string", description: "The working folder on the target" },
          },
          required: ["command"],
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
      {
        name: "read_quote",
        title: "Read a quoted message",
        description: "Read a quote referenced by an owner message in this topic. Start at offset 0 and use each returned next offset until it is null.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0, default: 0 } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "set_topic_repository",
        title: "Set the repository for this topic",
        description: "Assign the repository for a code topic waiting for one, after the owner identifies it.",
        inputSchema: {
          type: "object",
          properties: { repository: { type: "string", description: "A GitHub repository in owner/name form" } },
          required: ["repository"],
          additionalProperties: false,
        },
      },
      {
        name: "handover",
        title: "Hand over an owner message",
        description: "Move the current owner message to another topic when the owner asks or the message belongs there. The current turn stops and the destination answers it.",
        inputSchema: {
          type: "object",
          properties: {
            destination: { type: "string", description: "The destination topic id from the topic board" },
            message: { type: "string", description: "An owner message id in this turn. Defaults to the most recent owner message in the turn." },
          },
          required: ["destination"],
          additionalProperties: false,
        },
      },
      ...(options.tickets === undefined ? [] : ticketDefinitions()),
      ...(options.tickets?.chains === undefined ? [] : chainDefinitions()),
      ...(options.tickets?.chains === undefined || options.tickets.defaults === undefined ? [] : defaultsDefinitions()),
      ...(options.tickets?.verification === undefined ? [] : verificationDefinitions()),
      ...(options.tickets?.loop === undefined ? [] : loopDefinitions()),
      ...(options.memories === undefined ? [] : memoryDefinitions()),
      { name: "ask_owner", title: "Ask the owner", description: "Show all questions of a choice together. The owner's answer arrives later in this topic.", inputSchema: z.toJSONSchema(z.object({ questions: Questions }), { io: "input" }) },
      ...topicDefinitions(),
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
    const target = parsed.data.target ?? hubTargetName;
    if (target !== hubTargetName) {
      return {
        text: `Nothing was run: ${target} is not where your commands run. run_command runs only in the hub's container (target hub). Work on a machine is done by a worker through a task ticket (open_task_ticket), which the owner starts.`,
        isError: true,
      };
    }
    const request: CommandRequest = {
      target,
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

  const ticketCall = async (name: string, raw: unknown, scope: TicketTurn | undefined): Promise<ToolResult | undefined> => {
    const tools = options.tickets;
    if (tools === undefined) {
      return undefined;
    }
    const writeTurn = (): TicketTurn => {
      if (scope === undefined) {
        throw new TicketWriteRefused("Ticket changes require an active topic turn.");
      }
      tools.tickets.versions.requireActive(scope);
      return scope;
    };
    switch (name) {
      case "file_issue": {
        const parsed = FileArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const turn = writeTurn();
        return filingText(await tools.filer.file({ ...parsed.data, conversation: turn.conversation }, turn));
      }
      case "open_ticket": {
        const parsed = OpenArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const { issue, title_zh, ...rest } = parsed.data;
        const turn = writeTurn();
        return filingText(await tools.filer.open({ ...rest, number: issue, titleZh: title_zh, conversation: turn.conversation }, turn));
      }
      case "open_task_ticket": {
        if (tools.tasks === undefined) {
          return undefined;
        }
        const parsed = TaskArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const material = parsed.data.material ?? [];
        if (new Set(material.map((piece) => piece.name)).size !== material.length) {
          return { text: "Nothing was opened: two pieces of material have the same name.", isError: true };
        }
        const attached = new Map<string, Attachment>();
        for (const piece of material) {
          if (piece.attachment === undefined) {
            continue;
          }
          if (piece.text !== undefined) {
            return { text: `Nothing was opened: the material ${piece.name} has both text and an attachment; give one.`, isError: true };
          }
          const chosen = options.attachments?.choose([piece.attachment]);
          if (chosen === undefined || !chosen.ok || chosen.attachments[0] === undefined) {
            return { text: `Nothing was opened: ${chosen?.ok === false ? chosen.reason : `there is no attachment ${piece.attachment}`}.`, isError: true };
          }
          attached.set(piece.name, chosen.attachments[0]);
        }
        const turn = writeTurn();
        const opened = await tools.tasks.open({
          title: parsed.data.title,
          summary: parsed.data.summary,
          task: parsed.data.task,
          kind: parsed.data.kind,
          repository: parsed.data.repository,
          commit: parsed.data.commit,
          deploy: parsed.data.deploy,
          after: parsed.data.after,
          difficulty: parsed.data.difficulty,
          platform: parsed.data.platform,
          conversation: turn.conversation,
          materials: material.map((piece) => {
            const attachment = attached.get(piece.name);
            return { name: piece.name, source: piece.source, text: piece.text ?? null, ...(attachment === undefined ? {} : { attachment }) };
          }),
        }, turn);
        if (!opened.ok) {
          return { text: opened.reason, isError: true };
        }
        const ticket = opened.ticket;
        const pendingBefore = ticket.waits.some((wait) => tools.tickets.get(wait.ticket)?.state === "pending");
        return {
          text: [
            `Opened task ticket ${ticket.id}.`,
            ticketReport(ticket),
            ...opened.notes,
            `Now state its defaults with choose_defaults (kind ${ticket.kind}, its difficulty and platform, a one-line reason${ticket.kind === "writing" ? "" : ", and its engine"}).`,
            pendingBefore
              ? "It is arranged after a ticket that is not started: the owner's 开始 on that ticket's card starts both, and this one begins once what it waits for has merged. Tell the owner in Chinese what you arranged; do not ask for a second start."
              : "The owner starts it with 开始 on its card in 工作台; tell them in Chinese what it is and that it waits for their start.",
          ].join("\n"),
        };
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
        if (scope !== undefined) {
          tools.tickets.versions.seen(scope, detail.ticket.id);
        }
        const output = tools.work?.output(detail.ticket.id) ?? "";
        const task = detail.ticket.form === "task" ? tools.tickets.task(detail.ticket.id) : undefined;
        const logs = tools.verification?.logs(detail.ticket.id) ?? [];
        const waited = tools.verification?.waitedFor(detail.ticket.id) ?? null;
        const stuck = detail.ticket.stuck;
        const report = [
          ticketReport(detail.ticket, detail.moves),
          ...repairLines(detail.ticket, (id) => tools.tickets.get(id)),
          ...(waited === null ? [] : [waitedLine(waited)]),
          ...roundLines(detail.rounds),
          ...(stuck === null
            ? []
            : [
                `Stopped for the owner at the retry cap after ${stuck.round} guided rounds, on: ${failureWords[stuck.failure.kind]}${stuck.failure.detail === "" ? "" : ` (${stuck.failure.detail})`}. It waits for the owner's answer on its card.`,
                stuck.where === null ? "You have not said where it is stuck yet; do it with describe_stuck." : `Where it is stuck, as you said: ${stuck.where.en}`,
              ]),
          ...logs.flatMap((log) => [`The log of the failing workflow ${log.workflow}, step ${log.step}, ends with:`, clip(log.log || "(empty)", 8_000)]),
          ...(task === undefined
            ? []
            : [
                `Task: ${task.task}`,
                ...(detail.ticket.repository === null
                  ? []
                  : [
                      `Checkout of ${detail.ticket.repository} at ${task.commit ?? (task.commitRef === null ? "the default branch's head when the work begins" : task.commitRef === mergedCommit ? "the final merge commit of the chain it comes after, once that has merged" : `${task.commitRef} when the work begins`)}${task.deploys ? `; it deploys it by its ${deploymentFile}` : ""}.`,
                    ]),
                ...task.materials.map(
                  (piece) =>
                    `Material ${piece.name}, from ${piece.source}${piece.attachment !== null && piece.attachment !== undefined ? ` (the attached file ${piece.attachment.name}, ${piece.attachment.size} bytes)` : piece.text === null ? " (by its source only)" : ` (${piece.text.length} characters given)`}`,
                ),
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
        const chosen = options.attachments?.choose(parsed.data.attachments ?? []) ?? { ok: true as const, attachments: [] };
        if (!chosen.ok) {
          return { text: `Nothing was sent: ${chosen.reason}.`, isError: true };
        }
        const sent = tools.work.message(parsed.data.ticket, parsed.data.text, "brain", chosen.attachments, writeTurn());
        if (!sent.ok) {
          return { text: sent.reason, isError: true };
        }
        return {
          text: sent.delivered
            ? `Sent to the worker of ticket ${parsed.data.ticket}. Read the ticket to see how it answers.`
            : `The worker of ticket ${parsed.data.ticket} cannot take it right now (its machine is away, or the ticket is between attempts); the message is kept and reaches the worker when it next runs.`,
        };
      }
      case "stop_ticket": {
        const parsed = StopTicketArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        if (tools.tickets.get(parsed.data.ticket)?.state === "stuck") {
          return { text: `Ticket ${parsed.data.ticket} is stopped for the owner at the retry cap; only the owner decides now, on its card in 等你, whether to resume it or give it up. Tell the owner.`, isError: true };
        }
        const result = tools.tickets.stop(parsed.data.ticket, parsed.data.reason, writeTurn());
        if (result.ok) {
          return { text: [`Stopped ticket ${result.ticket.id}.`, ticketLine(result.ticket), ...chainProgress(result.ticket), ...decisionReport(result.ticket)].join("\n") };
        }
        return result.error === "not_found"
          ? { text: `There is no ticket ${parsed.data.ticket}.`, isError: true }
          : { text: `Ticket ${parsed.data.ticket} is ${result.ticket?.state ?? "finished"} and cannot be stopped.`, isError: true };
      }
      case "open_repair_ticket": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const before = tools.tickets.get(parsed.data.ticket);
        if (before === undefined) {
          return { text: `There is no ticket ${parsed.data.ticket}.`, isError: true };
        }
        if (before.state === "stuck") {
          return { text: `Ticket ${before.id} is stopped for the owner at the retry cap; only the owner decides now, on its card in 等你: giving it up there opens its repair ticket. Tell the owner.`, isError: true };
        }
        const repaired = tools.tickets.repair(before.id, "brain", "", writeTurn());
        if (!repaired.ok) {
          return { text: `No repair ticket was opened: ${repaired.reason}`, isError: true };
        }
        return { text: [`Opened repair ticket ${repaired.ticket.id}.`, ticketReport(repaired.ticket), ...repairReport(before, repaired.ticket, repaired.followers, true), ...chainProgress(before)].join("\n") };
      }
      case "record_decision": {
        const parsed = DecisionArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const { ticket, chosen, why, other_options } = parsed.data;
        if (tools.tickets.get(ticket) === undefined) {
          return { text: `There is no ticket ${ticket}; nothing was recorded.`, isError: true };
        }
        const recorded = tools.tickets.change((writes) => writes.recordDecisions(ticket, "brain", [{ chosen, why, otherOptions: other_options }]), writeTurn());
        const decision = recorded[0];
        return {
          text:
            decision === undefined
              ? `Ticket ${ticket} already has this decision recorded; nothing new was recorded.`
              : `Recorded on ticket ${ticket}. ${decisionLine(decision, false)} The owner sees it on the ticket's page and reviews it there.`,
        };
      }
      case "set_engine_row": {
        if (tools.defaults === undefined) return undefined;
        const args = z.object({ engine: ProgramId, row: z.unknown() }).strict().safeParse(raw);
        if (!args.success) return invalid(args.error);
        const { engine, row } = args.data;
        const parsed = (engine === "antigravity" ? ModelChoice : DifficultyRow).safeParse(row);
        if (!parsed.success) return invalid(parsed.error);
        const current = tools.defaults.table();
        const next = { ...current, [engine]: parsed.data };
        if (unofferedChanges(next, current, tools.defaults.machines()).length > 0) return { text: "A changed model and effort pair is not offered by any online machine; nothing was changed.", isError: true };
        tools.defaults.setTable(next);
        return { text: `Updated ${engine}: ${JSON.stringify(parsed.data)}` };
      }
      case "read_allowance": {
        if (tools.defaults === undefined) {
          return undefined;
        }
        return { text: allowanceReport(tools.defaults.subscriptions(), tools.defaults.machines(), tools.defaults.unavailable(), tools.defaults.balance()) };
      }
      case "choose_defaults": {
        if (tools.defaults === undefined || tools.chains === undefined) {
          return undefined;
        }
        const parsed = DefaultsArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return statedText(tools.chains.state(parsed.data.chains, writeTurn()), tools.defaults);
      }
      case "guide_ticket": {
        if (tools.loop === undefined) {
          return undefined;
        }
        const parsed = GuideArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const outcome = tools.loop.guide(parsed.data.ticket, parsed.data.guidance, writeTurn());
        if (!outcome.ok) {
          return { text: `No round was started: ${outcome.reason}`, isError: true };
        }
        const round = outcome.round;
        return {
          text: `${round === undefined || round.round === null ? `Ticket ${outcome.ticket.id} went back to its worker for a retry not counted as a guided round.` : `Ticket ${outcome.ticket.id} went back to its worker for guided round ${round.round} of ${roundCap}.`} You are told how it ends.\n${ticketLine(outcome.ticket)}`,
        };
      }
      case "describe_stuck": {
        if (tools.loop === undefined) {
          return undefined;
        }
        const parsed = StuckArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return loopText(tools.loop.describe(parsed.data.ticket, parsed.data.where, writeTurn()), (ticket) => `The card of ticket ${ticket} now says where it is stuck. It waits for the owner.`);
      }
      case "merge_ticket": {
        if (tools.verification === undefined) {
          return undefined;
        }
        const parsed = MergeArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return mergedText(await tools.verification.skip(parsed.data.ticket, parsed.data.reason, writeTurn()));
      }
      default:
        return chainCall(tools.chains, name, raw, writeTurn);
    }
  };

  const chainCall = (chains: ChainArranger | undefined, name: string, raw: unknown, writeTurn: () => TicketTurn): ToolResult | undefined => {
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
            writeTurn(),
          ),
        );
      }
      case "report_deployment": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return ticketOutcomeText(chains.deployed(parsed.data.ticket, writeTurn()), `Recorded that the work of ticket ${parsed.data.ticket} is deployed.`);
      }
      case "proceed_ticket": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return ticketOutcomeText(chains.proceed(parsed.data.ticket, writeTurn()), `Ticket ${parsed.data.ticket} no longer waits for the tickets that stopped.`);
      }
      default:
        return undefined;
    }
  };

  const call = async (id: JsonRpcId, params: unknown, conversation: string | undefined, turn: string | undefined, aborted: AbortSignal): Promise<ToolReply> => {
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
      case "read_quote": {
        const args = QuoteArguments.safeParse(parsed.data.arguments);
        const part = conversation === undefined || !args.success ? undefined : conversations.readQuote(conversation, args.data.id, args.data.offset);
        result = part === undefined ? { text: "No quote at that offset in this topic.", isError: true } : { text: JSON.stringify(part) };
        break;
      }
      case "ask_owner": {
        const args = z.object({ questions: Questions }).safeParse(parsed.data.arguments);
        const id = conversation !== undefined && turn !== undefined && !aborted.aborted && args.success ? conversations.askOwner(conversation, turn, args.data.questions) : undefined;
        result = id === undefined ? { text: "An active topic turn and valid questions are required.", isError: true } : { text: `Question card ${id} shown. The answer will arrive as the owner's next input in this topic.` };
        break;
      }
      case "handover": {
        const args = HandoverArguments.safeParse(parsed.data.arguments);
        const moved = conversation !== undefined && turn !== undefined && !aborted.aborted && conversations.brainReady() && args.success
          ? conversations.handover(conversation, turn, args.data.destination, args.data.message) : undefined;
        result = moved?.ok === true ? { text: `Owner message ${moved.value} belongs to the destination topic now and will be delivered after withdrawal.` }
          : { text: "An active turn with an owner message and an existing destination topic are required.", isError: true };
        break;
      }
      case "set_topic_repository": {
        const args = AssignRepositoryArguments.safeParse(parsed.data.arguments);
        const assigned = conversation !== undefined && turn !== undefined && !aborted.aborted && args.success
          && conversations.assignRepository(conversation, turn, args.data.repository);
        result = assigned ? { text: "Repository assigned to this topic." } : { text: "An active turn in a pending code topic and a repository in owner/name form are required.", isError: true };
        break;
      }
      default: {
        const scope = conversation === undefined || turn === undefined ? undefined : {
          conversation,
          id: turn,
          available: () => !aborted.aborted && conversations.brainReady(),
        };
        const ticketResult =
          topicCall(conversations.topics, options.memories, parsed.data.name, parsed.data.arguments ?? {}, conversation) ??
          (options.memories === undefined ? undefined : memoryCall(options.memories, parsed.data.name, parsed.data.arguments ?? {}, conversation)) ??
          (await ticketCall(parsed.data.name, parsed.data.arguments ?? {}, scope).catch((error: unknown) => {
            if (error instanceof TicketWriteRefused) {
              return { text: error.message, isError: true };
            }
            throw error;
          }));
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
    handle: async ({ body, conversation, turn, aborted }) => {
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
          return call(id, message.params, conversation, turn, aborted);
        default:
          return { status: 200, body: errorBody(id, -32601, `Method not found: ${method}`) };
      }
    },
  };
}
