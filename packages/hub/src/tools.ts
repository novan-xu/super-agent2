import {
  Questions,
  CodeEngineChoice,
  LightTaskMode,
  ProgramId,
  AntigravityRow,
  DifficultyRow,
  unofferedChanges,
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
  TopicRename,
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
  TicketReference,
  ticketReference,
  ticketReferencePattern,
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
import { LightTaskRequest, type LightTasks } from "./light-tasks.js";
import { ScheduleFields, ScheduleId } from "@super-agent2/protocol";
import { ScheduleRefused, type Schedules } from "./schedules.js";
import type { TaskTickets } from "./task-tickets.js";
import { hubTargetName } from "./targets.js";
import type { SkipOutcome, VerificationService } from "./verification.js";
import type { WorkService } from "./work.js";
import type { Runners } from "./runners.js";

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
const HandoverArguments = z.strictObject({
  destination: z.union([
    ConversationId.describe("A destination topic id from the topic board"),
    TopicRename.extend({ title: TopicRename.shape.title.describe("A new topic title in the owner's language") }),
  ]),
  message: MessageId.describe("An owner message id from this turn. Defaults to the latest owner message in the turn.").optional(),
  ownerRequested: z.literal(true).describe("Set only when the owner explicitly asks to move the message.").optional(),
});
const AssignRepositoryArguments = z.strictObject({ repository: RepositoryName.nullable(), topic: ConversationId.optional() });
const SetTopicTitleArguments = z.strictObject({
  title: z.string().trim().min(1).max(80).describe("A short, single-line title in the owner's language"),
});
const ArchiveTopicsArguments = z.strictObject({ topics: z.array(z.string().min(1)).min(1).max(100) });

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
  project: RepositoryName.optional(),
  commit: z.union([z.literal(mergedCommit), CommitRef]).optional(),
  deploy: z.boolean().optional(),
  after: z.array(TicketReference).optional(),
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
});

const ScheduledLightArguments = LightTaskRequest.omit({ materials: true }).extend({
  material: z.array(MaterialArgument).optional(),
});
const StartLightArguments = ScheduledLightArguments.extend({
  ownerEngine: ProgramId.optional(),
});
const LegacyLightEngine = { engine: CodeEngineChoice.optional() };

const ScheduleProposalArguments = ScheduleFields.extend({
  confirmation: z.string().trim().min(1).max(2_000),
  schedule: ScheduleId.optional(),
});
const ScheduleConfirmArguments = z.strictObject({ proposal: MessageId });
const ScheduleIdArguments = z.strictObject({ schedule: ScheduleId });


const ListArguments = z.object({
  all: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const ReadTicketArguments = z.object({ ticket: TicketReference });

const StopTicketArguments = z.object({ ticket: TicketReference, reason: GeneratedText });

const DecisionArguments = z.object({ ticket: TicketReference, chosen: GeneratedText, why: GeneratedText, other_options: GeneratedText });

const MessageWorkerArguments = z.object({ ticket: TicketReference, text: z.string().trim().min(1), attachments: z.array(AttachmentId).optional() });

const ChainArgument = z.object({
  name: z.string().trim().min(1).max(100),
  repository: RepositoryName,
  issues: z.array(z.number().int().positive()).min(1),
  after: z.array(z.string().trim().min(1)).optional(),
  after_deployment: z.boolean().optional(),
  title: GeneratedText.optional(),
  summary: GeneratedText.optional(),
  kind: CodeKind.optional(),
  difficulty: Difficulty.optional(),
  platform: Platform.optional(),
});

const ArrangeArguments = z.object({ chains: z.array(ChainArgument).min(1) });

const TicketArgument = z.object({ ticket: TicketReference });

const GuideArguments = z.object({ ticket: TicketReference, guidance: GeneratedText });

const StuckArguments = z.object({ ticket: TicketReference, where: GeneratedText });

const MergeArguments = z.object({ ticket: TicketReference, reason: z.string().trim().min(1) });

const DefaultsArgument = z.object({
  ticket: TicketReference,
  kind: TicketKind,
  issues: z.array(z.object({ number: z.number().int().positive(), difficulty: Difficulty })).optional(),
  difficulty: Difficulty.optional(),
  reason: GeneratedText,
  platform: Platform,
});

const DefaultsArguments = z.object({ chains: z.array(DefaultsArgument).min(1) });

const ticketCodeSchema = (what: string) => ({
  type: "string",
  pattern: ticketReferencePattern,
  description: what,
});

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

const materialSchema = {
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
  readonly light?: LightTasks;
  readonly schedules?: Schedules;
  readonly chains?: ChainArranger;
  readonly defaults?: StartDefaults;
  readonly runners?: Runners;
  readonly work?: WorkService;
  readonly verification?: VerificationService;
  readonly loop?: FailureLoop;
}

function loopDefinitions() {
  return [
    {
      name: "guide_ticket",
      title: "Guide a failed ticket's worker into another round",
      description: "Retry a failed ticket with guidance. Use message_worker while its worker is still running.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: ticketCodeSchema("The failed ticket"),
          guidance: generatedSchema("guidance to the worker"),
        },
        required: ["ticket", "guidance"],
        additionalProperties: false,
      },
    },
    {
      name: "describe_stuck",
      title: "Say where a stopped ticket is stuck",
      description: "Record the diagnosis of a ticket stuck at the retry cap for the owner's card.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: ticketCodeSchema("The ticket stopped for the owner"),
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

function loopText(outcome: LoopOutcome, done: (ticket: string) => string): ToolResult {
  if (!outcome.ok) {
    return { text: `Nothing was changed: ${outcome.reason}`, isError: true };
  }
  return { text: `${done(ticketReference(outcome.ticket))}\n${ticketLine(outcome.ticket)}` };
}

function verificationDefinitions() {
  return [
    {
      name: "merge_ticket",
      title: "Merge a ticket with the verification rules skipped",
      description: "Skip verification for one verifying pull request only when the owner asks. A merge conflict still goes back to the worker.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: ticketCodeSchema("The ticket in verifying"),
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
    return { text: `Merged ticket ${ticketReference(ticket)} with the rules skipped${commit === null ? "" : ` as commit ${commit}`}.\n${ticketLine(ticket)}\nYou are told separately what was closed and whether it needs deploying.` };
  }
  const last = ticket.pullRequests.at(-1);
  if (ticket.state === "working" && last?.state === "merged") {
    return {
      text: `Merged pull request #${last.number} of ticket ${ticketReference(ticket)} with the rules skipped${last.mergeCommit === null ? "" : ` as commit ${last.mergeCommit}`}. The chain is not done: its worker continues with ${openIssueNumbers(ticket).map((number) => `#${number}`).join(", ")}, and the rules apply again to its next pull request.\n${ticketLine(ticket)}`,
    };
  }
  if (ticket.state === "working") {
    return { text: `Ticket ${ticketReference(ticket)} was not merged: ${reason ?? "it went back to its worker"}. When the worker hands back the pull request again, the rules apply again.\n${ticketLine(ticket)}` };
  }
  return { text: `Ticket ${ticketReference(ticket)} is not merged yet: ${reason ?? "it is still being checked"}. The hub keeps trying.\n${ticketLine(ticket)}`, isError: ticket.verification?.state === "conflict" };
}

function defaultsDefinitions() {
  return [
    {
      name: "set_engine_row",
      title: "Change one start-defaults row",
      description: "Change one engine row after owner agreement in this conversation. Use model and effort pairs offered by an online machine.",
      inputSchema: {
        type: "object",
        properties: {
          engine: { type: "string", enum: ["codex", "claude", "dsh", "antigravity"] },
          row: {
            description: "For code engines, give the mechanical, standard and complex choices. For Antigravity, give pairs in the order they should be tried.",
            anyOf: [z.toJSONSchema(DifficultyRow), z.toJSONSchema(AntigravityRow)],
          },
        },
        required: ["engine", "row"],
        additionalProperties: false,
      },
    },
    {
      name: "read_allowance",
      title: "Read provider allowances",
      description: "Read subscription quotas, DeepSeek balance, unavailable providers and online worker capacity.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "recheck_machines",
      title: "Recheck worker programs",
      description: "Reprobe worker programs on the named machine or all machines. Report offline machines and timeouts to the owner.",
      inputSchema: { type: "object", properties: { machine: { type: "string", minLength: 1 } }, additionalProperties: false },
    },
    {
      name: "choose_defaults",
      title: "State each chain's kind, difficulty and platform",
      description: [
        "Give each issue's difficulty for code chains and one difficulty for a task.",
        "Use mechanical for fixed procedures, standard for bounded work, and complex for cross-module, state, concurrency or open design work.",
        "Writing defaults to Antigravity. Other work follows the owner's worker order.",
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
                ticket: ticketCodeSchema("The chain's ticket code"),
                kind: {
                  type: "string",
                  enum: [...ticketKinds],
                  description: "Code kinds include parameter for copy or value changes without logic, and maintenance for dependencies or CI. Task kinds are writing and operation.",
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
                difficulty: { type: "string", enum: [...difficulties], description: "Task difficulty, defaulting to standard for writing" },
                reason: generatedSchema("one-line reason for the chain's difficulty"),
                platform: { type: "string", enum: [...platforms], description: "The platform the work needs" },
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

function statedText(outcome: StateOutcome, defaults: StartDefaults, scheduled: boolean): ToolResult {
  if (!outcome.ok) {
    return { text: outcome.reason, isError: true };
  }
  const lines = outcome.tickets.map((ticket) => `Ticket ${ticketReference(ticket)}: ${ticket.kind}, ${ticket.difficulty ?? "?"}, ${ticket.platform ?? "?"}. ${choiceText(defaults.resolve(ticket))}`);
  lines.push(scheduled ? "The hub will use these defaults when it starts the scheduled work after this turn." : "The owner sees these on the cards in 工作台 and can change them before the start.");
  return { text: lines.join("\n") };
}

function chainDefinitions() {
  return [
    {
      name: "arrange_chains",
      title: "Arrange pending tickets into chains",
      description: [
        "Include every issue of each pending ticket you rearrange.",
        "Give a multi-issue chain a bilingual title and summary. A chain keeping one ticket's issues can keep its title and summary.",
        "Fix refused arrangements before retrying.",
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
                  items: { type: "string" },
                  description: "Chain names in this call or existing ticket codes, including started tickets. Use a dated code to avoid a name collision.",
                },
                after_deployment: { type: "boolean", description: "Also wait for the earlier work to be deployed" },
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
      description: "Mark merged work deployed after a deployment outside a deployment task. This satisfies deployment dependencies.",
      inputSchema: {
        type: "object",
        properties: { ticket: ticketCodeSchema("The merged ticket whose work is deployed") },
        required: ["ticket"],
        additionalProperties: false,
      },
    },
    {
      name: "proceed_ticket",
      title: "Let a waiting ticket go ahead",
      description: "Drop all stopped prerequisites of a waiting ticket. Other prerequisites still apply.",
      inputSchema: {
        type: "object",
        properties: { ticket: ticketCodeSchema("The waiting ticket") },
        required: ["ticket"],
        additionalProperties: false,
      },
    },
  ];
}

function arrangedText(outcome: ArrangeOutcome, reference: TicketService["reference"], scheduled: boolean): ToolResult {
  if (!outcome.ok) {
    return { text: outcome.reason, isError: true };
  }
  const lines = outcome.chains.map(({ name, ticket }) => {
    const issues = ticket.issues.map((issue) => `#${issue.number}`).join(", ");
    const after =
      ticket.waits.length === 0
        ? "nothing before it"
        : `after ${ticket.waits.map((wait) => `ticket ${wait.reference ?? "(unavailable)"}${wait.deployment ? " (merged and deployed)" : ""}`).join(", ")}`;
    return `Chain ${name} is ticket ${ticketReference(ticket)} in ${ticket.repository ?? ""}: ${issues}; ${after}.`;
  });
  if (outcome.joined.length > 0) {
    lines.push(`Closed as joined into other chains: ${outcome.joined.map((id) => `ticket ${reference(id) ?? "(unavailable)"}`).join(", ")}.`);
  }
  lines.push(scheduled
    ? "State the defaults for each chain and arrange any deployment in this turn. The hub will start scheduled work when the turn completes."
    : "They wait for the owner to start them with 开始 on their cards in 工作台. Tell the owner, in Chinese, how the work is arranged.");
  return { text: lines.join("\n") };
}

function ticketOutcomeText(outcome: TicketOutcome, done: string): ToolResult {
  if (!outcome.ok) {
    return { text: outcome.reason, isError: true };
  }
  const began = outcome.began.length === 0 ? "Nothing began yet." : `Began: ${outcome.began.map((ticket) => `ticket ${ticketReference(ticket)}`).join(", ")}.`;
  return { text: `${done}\n${ticketLine(outcome.ticket)}\n${began}` };
}

function ticketDefinitions() {
  return [
    {
      name: "file_issue",
      title: "File an issue and open its ticket",
      description: "Create a GitHub issue and pending ticket. On partial failure retry with the same arguments to reuse the issue.",
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: "The repository as owner/name" },
          title: generatedSchema("issue title"),
          summary: generatedSchema("one or two sentence summary"),
          body: { type: "string", description: "Issue plan in English Markdown" },
          kind: { type: "string", enum: [...codeKinds] },
          ...startChoices,
        },
        required: ["repository", "title", "summary", "body", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "open_ticket",
      title: "Open a ticket for an existing issue",
      description: "Open or reuse a ticket for a GitHub issue. The English title comes from GitHub.",
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: "The repository as owner/name" },
          issue: { type: "integer", minimum: 1, description: "The issue number" },
          title_zh: { type: "string", description: "The issue title in Simplified Chinese, for the owner" },
          summary: generatedSchema("one or two sentence summary"),
          kind: { type: "string", enum: [...codeKinds] },
          ...startChoices,
        },
        required: ["repository", "issue", "title_zh", "summary", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "open_task_ticket",
      title: "Open a task ticket",
      description: "Open a visible worker task in scratch, optionally with a checkout or deployment.",
      inputSchema: {
        type: "object",
        properties: {
          title: generatedSchema("ticket title"),
          summary: generatedSchema("one or two sentence summary"),
          task: { type: "string", description: "Standalone work instructions in English" },
          kind: { type: "string", enum: [...taskKinds] },
          material: materialSchema,
          repository: { type: "string", description: "The repository as owner/name, when the task needs a checkout of it" },
          project: { type: "string", description: "The related repository as owner/name, when the task needs no checkout" },
          commit: { type: "string", description: `SHA, branch, or "${mergedCommit}" for the preceding chain's final merge commit. If omitted, use the default branch at start, or "${mergedCommit}" for a deployment after its code chain.` },
          deploy: { type: "boolean", description: `Deploy the repository by its ${deploymentFile}` },
          after: { type: "array", items: ticketCodeSchema("Ticket to wait for until merged or done. A dependency already started does not authorize this task.") },
          difficulty: startChoices.difficulty,
          platform: startChoices.platform,
        },
        required: ["title", "summary", "task", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "start_light_task",
      title: "Start an everyday task",
      description: "Start a light worker task in this topic. Writing tries Antigravity first, then the configured worker order.",
      inputSchema: {
        type: "object",
        properties: {
          title: generatedSchema("task title"),
          summary: generatedSchema("short task summary"),
          task: { type: "string", description: "Full standalone work instructions in English for the worker, including what to deliver" },
          kind: { type: "string", enum: [...taskKinds] },
          project: { type: "string", description: "The related repository as owner/name, used as a task label" },
          mode: { type: "string", enum: LightTaskMode.options, description: "Defaults to transfer" },
          material: materialSchema,
          difficulty: startChoices.difficulty,
          platform: startChoices.platform,
          reason: generatedSchema("one-line reason for the difficulty"),
          ownerEngine: { type: "string", enum: ProgramId.options, description: "Provider explicitly requested by the owner" },
        },
        required: ["title", "summary", "task", "kind", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "answer_light_task",
      title: "Relay the owner's answer to a light-task worker",
      description: "Relay the owner's original answer and attachments to the waiting light-task worker.",
      inputSchema: { type: "object", properties: { ticket: ticketCodeSchema("The internal light task reference") }, required: ["ticket"], additionalProperties: false },
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
      description: "Read ticket details, including progress, verification wait and reviewed decisions.",
      inputSchema: {
        type: "object",
        properties: { ticket: ticketCodeSchema("The ticket code") },
        required: ["ticket"],
        additionalProperties: false,
      },
    },
    {
      name: "message_worker",
      title: "Send a message to a ticket's worker",
      description: "Send a correction, guidance or attachments to a running worker.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: ticketCodeSchema("The ticket code"),
          text: { type: "string", description: "The message, in English" },
          attachments: {
            type: "array",
            items: { type: "string", description: "An attachment id" },
            description: "Owner attachment IDs",
          },
        },
        required: ["ticket", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "record_decision",
      title: "Record a decision made on the owner's behalf",
      description: "Record a choice for the owner's later review in any ticket state.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: ticketCodeSchema("The ticket the decision belongs to"),
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
      description: "Stop an open ticket and record why.",
      inputSchema: {
        type: "object",
        properties: {
          ticket: ticketCodeSchema("The ticket code"),
          reason: generatedSchema("reason for stopping"),
        },
        required: ["ticket", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "open_repair_ticket",
      title: "Open a repair ticket for a stopped ticket",
      description: "Open a pending repair for stopped work with a remainder. Repair the latest stopped ticket in its lineage. The owner handles stuck tickets on their card.",
      inputSchema: {
        type: "object",
        properties: { ticket: ticketCodeSchema("The stopped ticket whose work should go on") },
        required: ["ticket"],
        additionalProperties: false,
      },
    },
  ];
}

function scheduleDefinitions() {
  return [
    {
      name: "propose_schedule",
      description: [
        "Read list_schedules first for existing plans and the hub time zone.",
        "Write the run's scope and limits in English. In the Chinese confirmation, state what runs, where, and when or from which service.",
        "Use a five-field numeric cron in hub time, an epoch timestamp in milliseconds, or a registered service name. Pass schedule to revise a plan.",
        "End the turn after proposing.",
      ].join(" "),
      inputSchema: z.toJSONSchema(ScheduleProposalArguments, { io: "input" }),
    },
    {
      name: "create_schedule",
      description: "Activate a proposal after explicit owner agreement in a newer message in this topic within 24 hours. Propose again if scope changed or it expired.",
      inputSchema: z.toJSONSchema(ScheduleConfirmArguments, { io: "input" }),
    },
    {
      name: "list_schedules",
      description: "Read schedules, their IDs and the hub time zone.",
      inputSchema: z.toJSONSchema(z.strictObject({}), { io: "input" }),
    },
    ...(["pause", "resume", "delete"] as const).map((action) => ({
      name: `${action}_schedule`,
      description: `${action} a schedule when the owner asks in the current turn.`,
      inputSchema: z.toJSONSchema(ScheduleIdArguments, { io: "input" }),
    })),
    {
      name: "run_scheduled_light_task",
      description: "Stage a light task in the current scheduled run with the same task inputs as start_light_task.",
      inputSchema: z.toJSONSchema(ScheduledLightArguments, { io: "input" }),
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
    ? `This issue already has ticket ${ticketReference(outcome.ticket)}; nothing new was opened.`
    : outcome.issueCreated
      ? `Filed ${where} and opened ticket ${ticketReference(outcome.ticket)}.`
      : `Used the existing issue ${where} and opened ticket ${ticketReference(outcome.ticket)}.`;
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

  const materialsOf = (material: readonly z.infer<typeof MaterialArgument>[]) => {
    if (new Set(material.map((piece) => piece.name)).size !== material.length) {
      return { ok: false as const, result: { text: "Nothing was opened: two pieces of material have the same name.", isError: true } };
    }
    const attached = new Map<string, Attachment>();
    for (const piece of material) {
      if (piece.attachment === undefined) {
        continue;
      }
      if (piece.text !== undefined) {
        return { ok: false as const, result: { text: `Nothing was opened: the material ${piece.name} has both text and an attachment; give one.`, isError: true } };
      }
      const chosen = options.attachments?.choose([piece.attachment]);
      if (chosen === undefined || !chosen.ok || chosen.attachments[0] === undefined) {
        return { ok: false as const, result: { text: `Nothing was opened: ${chosen?.ok === false ? chosen.reason : `there is no attachment ${piece.attachment}`}.`, isError: true } };
      }
      attached.set(piece.name, chosen.attachments[0]);
    }
    return { ok: true as const, materials: material.map((piece) => {
      const attachment = attached.get(piece.name);
      return { name: piece.name, source: piece.source, text: piece.text ?? null, ...(attachment === undefined ? {} : { attachment }) };
    }) };
  };

  const definitions = () => {
    return [
      {
        name: "run_command",
        title: "Run a shell command",
        description: `Run a command and wait for its result in the hub container. gh uses the selected account's GH_TOKEN (default ${defaultGitHubAccount}).`,
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
        description: "Read an owner message's quote in this topic using the returned offsets.",
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
        description: "Assign a compatible daily or pending code topic to a repository. Pass null for daily. Light tasks do not constrain the move. Supply another topic ID only at the owner's request.",
        inputSchema: z.toJSONSchema(AssignRepositoryArguments, { io: "input" }),
      },
      {
        name: "set_topic_title",
        title: "Set the title of this topic",
        description: "Name this topic at turn end. Use one line with up to 20 Chinese or 40 Latin characters. Leave owner titles alone.",
        inputSchema: z.toJSONSchema(SetTopicTitleArguments, { io: "input" }),
      },
      {
        name: "archive_topics",
        title: "Archive topics",
        description: "Archive topics only at the owner's request. Idle topics archive automatically.",
        inputSchema: z.toJSONSchema(ArchiveTopicsArguments, { io: "input" }),
      },
      {
        name: "handover",
        title: "Hand over an owner message",
        description: "Move the latest owner message or the given message ID in this turn, with attachments and quote. Set ownerRequested for an explicit move. The turn stops and the destination answers.",
        inputSchema: z.toJSONSchema(HandoverArguments, { io: "input" }),
      },
      ...(options.tickets === undefined ? [] : ticketDefinitions()),
      ...(options.tickets?.schedules === undefined ? [] : scheduleDefinitions()),
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
        text: `Nothing was run: ${target} is not where your commands run. run_command runs only in the hub's container (target hub). Work on a machine is done by a worker. Use start_light_task for everyday work in 日常 or open_task_ticket for a visible ticket.`,
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
      if (tools.tickets.scheduleForTurn(scope)?.authorized === false) throw new TicketWriteRefused("This scheduled run is no longer authorized.");
      return scope;
    };
    const resolve = (reference: string): number => {
      const id = tools.tickets.resolve(reference);
      if (id === undefined) throw new TicketWriteRefused(`There is no ticket ${reference.toUpperCase()}.`);
      return id;
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
        const material = materialsOf(parsed.data.material ?? []);
        if (!material.ok) return material.result;
        const turn = writeTurn();
        const opened = await tools.tasks.open({
          title: parsed.data.title,
          summary: parsed.data.summary,
          task: parsed.data.task,
          kind: parsed.data.kind,
          repository: parsed.data.repository,
          project: parsed.data.project,
          commit: parsed.data.commit,
          deploy: parsed.data.deploy,
          after: parsed.data.after?.map(resolve),
          difficulty: parsed.data.difficulty,
          platform: parsed.data.platform,
          conversation: turn.conversation,
          materials: material.materials,
        }, turn);
        if (!opened.ok) {
          return { text: opened.reason, isError: true };
        }
        const ticket = opened.ticket;
        const pendingBefore = ticket.waits.some((wait) => tools.tickets.get(wait.ticket)?.state === "pending");
        return {
          text: [
            `Opened task ticket ${ticketReference(ticket)}.`,
            ticketReport(ticket),
            ...opened.notes,
            `Now state its defaults with choose_defaults (kind ${ticket.kind}, its difficulty and platform, and a one-line reason).`,
            ticket.scheduleRun !== undefined
              ? "This work starts after this scheduled turn with its defaults."
              : pendingBefore
              ? "It is arranged after a ticket that is not started: the owner's 开始 on that ticket's card starts both, and this one begins once what it waits for has merged. Tell the owner in Chinese what you arranged; do not ask for a second start."
              : "The owner starts it with 开始 on its card in 工作台; tell them in Chinese what it is and that it waits for their start.",
          ].join("\n"),
        };
      }
      case "list_schedules": {
        return tools.schedules === undefined ? undefined : { text: JSON.stringify(tools.schedules.list()) };
      }
      case "propose_schedule": {
        if (tools.schedules === undefined) return undefined;
        const parsed = ScheduleProposalArguments.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        const { confirmation, schedule, ...fields } = parsed.data;
        const proposal = tools.schedules.propose(fields, confirmation, writeTurn(), schedule);
        return { text: `Schedule proposal ${proposal}. The confirmation is visible in the topic. End this turn and wait for the owner's agreement.` };
      }
      case "create_schedule": {
        if (tools.schedules === undefined) return undefined;
        const parsed = ScheduleConfirmArguments.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        const schedule = tools.schedules.confirm(parsed.data.proposal, writeTurn());
        return { text: `Schedule ${schedule} was saved. The hub launches each run automatically. Confirm this briefly to the owner in Chinese.` };
      }
      case "pause_schedule":
      case "resume_schedule":
      case "delete_schedule": {
        if (tools.schedules === undefined) return undefined;
        const parsed = ScheduleIdArguments.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        const action = name === "pause_schedule" ? "pause" : name === "resume_schedule" ? "resume" : "delete";
        tools.schedules.changeFromTurn(parsed.data.schedule, action, writeTurn());
        return { text: `Schedule ${parsed.data.schedule}: ${action} applied.` };
      }
      case "run_scheduled_light_task": {
        if (tools.schedules === undefined || tools.light === undefined) return undefined;
        const parsed = ScheduledLightArguments.extend(LegacyLightEngine).safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        const { material, engine: _engine, ...request } = parsed.data;
        const chosen = materialsOf(material ?? []);
        if (!chosen.ok) return chosen.result;
        tools.light.scheduled({ ...request, materials: chosen.materials }, writeTurn());
        return { text: "The light task is ready for this run. Its result arrives in the topic after the turn." };
      }
      case "start_light_task": {
        if (tools.light === undefined) return undefined;
        const parsed = StartLightArguments.extend(LegacyLightEngine).safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        const { material, ownerEngine, engine: _engine, ...request } = parsed.data;
        const chosen = materialsOf(material ?? []);
        if (!chosen.ok) return chosen.result;
        const ticket = tools.light.start({ ...request, materials: chosen.materials }, ownerEngine, writeTurn());
        return { text: `Light task ${ticketReference(ticket)} (internal only) is ${ticket.state}. Acknowledge in one short Chinese line what was started and that the result comes back here. ${ticket.state === "waiting" ? "Say it starts automatically when a suitable machine and provider are available." : ""}` };
      }
      case "answer_light_task": {
        if (tools.work === undefined) return undefined;
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        const result = tools.work.answerLightQuestion(resolve(parsed.data.ticket), writeTurn());
        return result.ok ? { text: "The owner's answer was forwarded to the worker. The result comes back here." } : { text: result.reason, isError: true };
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
        const detail = tools.tickets.detail(resolve(parsed.data.ticket));
        if (detail === undefined) {
          return { text: `There is no ticket ${parsed.data.ticket.toUpperCase()}.`, isError: true };
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
                ...(detail.ticket.project === undefined ? [] : [`Related repository: ${detail.ticket.project}. The worker uses a scratch folder.`]),
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
        const id = resolve(parsed.data.ticket);
        const turn = writeTurn();
        const ticket = tools.tickets.get(id);
        if (ticket?.light !== undefined && ticket.conversation !== turn.conversation) return { text: "A light task can only be messaged from its own topic.", isError: true };
        const sent = tools.work.message(id, parsed.data.text, "brain", chosen.attachments, turn);
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
        const id = resolve(parsed.data.ticket);
        const turn = writeTurn();
        const ticket = tools.tickets.get(id);
        if (ticket?.light !== undefined && ticket.conversation !== turn.conversation) return { text: "A light task can only be stopped from its own topic.", isError: true };
        if (ticket?.state === "stuck") {
          return { text: `Ticket ${parsed.data.ticket} is stopped for the owner at the retry cap; only the owner decides now, on its card in 等你, whether to resume it or give it up. Tell the owner.`, isError: true };
        }
        const result = tools.tickets.stop(id, parsed.data.reason, turn);
        if (result.ok) {
          if (result.ticket.light !== undefined) return { text: "Stopped the light task. A short stop message is already visible in chat." };
          return { text: [`Stopped ticket ${ticketReference(result.ticket)}.`, ticketLine(result.ticket), ...chainProgress(result.ticket), ...decisionReport(result.ticket)].join("\n") };
        }
        return result.error === "not_found"
          ? { text: `There is no ticket ${parsed.data.ticket.toUpperCase()}.`, isError: true }
          : { text: `Ticket ${parsed.data.ticket} is ${result.ticket?.state ?? "finished"} and cannot be stopped.`, isError: true };
      }
      case "open_repair_ticket": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const before = tools.tickets.get(resolve(parsed.data.ticket));
        if (before === undefined) {
          return { text: `There is no ticket ${parsed.data.ticket.toUpperCase()}.`, isError: true };
        }
        if (before.state === "stuck") {
          return { text: `Ticket ${ticketReference(before)} is stopped for the owner at the retry cap; only the owner decides now, on its card in 等你: giving it up there opens its repair ticket. Tell the owner.`, isError: true };
        }
        const repaired = tools.tickets.repair(before.id, "brain", "", writeTurn());
        if (!repaired.ok) {
          return { text: `No repair ticket was opened: ${repaired.reason}`, isError: true };
        }
        return { text: [`Opened repair ticket ${ticketReference(repaired.ticket)}.`, ticketReport(repaired.ticket), ...repairReport(before, repaired.ticket, repaired.followers, true), ...chainProgress(before)].join("\n") };
      }
      case "record_decision": {
        const parsed = DecisionArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const { ticket, chosen, why, other_options } = parsed.data;
        const id = resolve(ticket);
        const recorded = tools.tickets.change((writes) => writes.recordDecisions(id, "brain", [{ chosen, why, otherOptions: other_options }]), writeTurn());
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
        const parsed = (engine === "antigravity" ? AntigravityRow : DifficultyRow).safeParse(row);
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
      case "recheck_machines": {
        if (tools.runners === undefined) return undefined;
        const parsed = z.strictObject({ machine: z.string().trim().min(1).optional() }).safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        const results = await tools.runners.refreshPrograms(parsed.data.machine);
        if (results.length === 0) return { text: "No machines are registered." };
        return { text: results.map((result) => result.report === undefined
          ? `${result.name}: ${result.status}.`
          : `${result.name}: refreshed\n${result.report.programs.map((program) => `- ${program.id}: ${program.installed ? `version ${program.version ?? "unknown"}, ${program.models.length} models${program.problem === null ? "" : `, problem: ${program.problem}`}${program.update?.note == null ? "" : `, update note: ${program.update.note}`}` : "not installed"}`).join("\n")}`).join("\n") };
      }
      case "choose_defaults": {
        if (tools.defaults === undefined || tools.chains === undefined) {
          return undefined;
        }
        const parsed = DefaultsArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const turn = writeTurn();
        const scheduled = tools.tickets.scheduleForTurn(turn) !== undefined;
        return statedText(tools.chains.state(parsed.data.chains.map((chain) => ({ ...chain, ticket: resolve(chain.ticket) })), turn), tools.defaults, scheduled);
      }
      case "guide_ticket": {
        if (tools.loop === undefined) {
          return undefined;
        }
        const parsed = GuideArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const outcome = tools.loop.guide(resolve(parsed.data.ticket), parsed.data.guidance, writeTurn());
        if (!outcome.ok) {
          return { text: `No round was started: ${outcome.reason}`, isError: true };
        }
        const round = outcome.round;
        return {
          text: `${round === undefined || round.round === null ? `Ticket ${ticketReference(outcome.ticket)} went back to its worker for a retry not counted as a guided round.` : `Ticket ${ticketReference(outcome.ticket)} went back to its worker for guided round ${round.round} of ${roundCap}.`} You are told how it ends.\n${ticketLine(outcome.ticket)}`,
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
        return loopText(tools.loop.describe(resolve(parsed.data.ticket), parsed.data.where, writeTurn()), (ticket) => `The card of ticket ${ticket} now says where it is stuck. It waits for the owner.`);
      }
      case "merge_ticket": {
        if (tools.verification === undefined) {
          return undefined;
        }
        const parsed = MergeArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return mergedText(await tools.verification.skip(resolve(parsed.data.ticket), parsed.data.reason, writeTurn()));
      }
      default:
        return chainCall(tools, name, raw, writeTurn, resolve);
    }
  };

  const chainCall = ({ chains, tickets }: TicketTools, name: string, raw: unknown, writeTurn: () => TicketTurn, resolve: (reference: string) => number): ToolResult | undefined => {
    if (chains === undefined) {
      return undefined;
    }
    switch (name) {
      case "arrange_chains": {
        const parsed = ArrangeArguments.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        const names = new Set(parsed.data.chains.map((chain) => chain.name));
        const turn = writeTurn();
        return arrangedText(
          chains.arrange(
            parsed.data.chains.map((chain) => ({
              name: chain.name,
              repository: chain.repository,
              issues: chain.issues,
              after: chain.after?.map((before) => names.has(before) || !TicketReference.safeParse(before).success ? before : resolve(before)),
              afterDeployment: chain.after_deployment,
              title: chain.title,
              summary: chain.summary,
              kind: chain.kind,
              difficulty: chain.difficulty,
              platform: chain.platform,
            })),
            turn,
          ),
          tickets.reference,
          tickets.scheduleForTurn(turn) !== undefined,
        );
      }
      case "report_deployment": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return ticketOutcomeText(chains.deployed(resolve(parsed.data.ticket), writeTurn()), `Recorded that the work of ticket ${parsed.data.ticket} is deployed.`);
      }
      case "proceed_ticket": {
        const parsed = TicketArgument.safeParse(raw);
        if (!parsed.success) {
          return invalid(parsed.error);
        }
        return ticketOutcomeText(chains.proceed(resolve(parsed.data.ticket), writeTurn()), `Ticket ${parsed.data.ticket} no longer waits for the tickets that stopped.`);
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
        result = conversation !== undefined && turn !== undefined && options.tickets?.tickets.scheduleForTurn({ conversation, id: turn })?.authorized === false
          ? { text: "This scheduled run is no longer authorized.", isError: true }
          : await run(parsed.data.arguments ?? {}, conversation, aborted);
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
      case "archive_topics": {
        const args = ArchiveTopicsArguments.safeParse(parsed.data.arguments);
        if (!args.success || conversation === undefined || turn === undefined || aborted.aborted) {
          result = { text: "An active topic turn and 1 to 100 topic IDs are required.", isError: true };
          break;
        }
        result = { text: JSON.stringify(args.data.topics.map((topic) => ({ topic, result: conversations.archiveForBrain(topic, conversation) }))) };
        break;
      }
      case "handover": {
        const args = HandoverArguments.safeParse(parsed.data.arguments);
        const moved = conversation !== undefined && turn !== undefined && !aborted.aborted && conversations.brainReady() && args.success
          ? conversations.handover(conversation, turn, args.data.destination, args.data.message, args.data.ownerRequested) : undefined;
        result = moved?.ok === true ? { text: `Owner message ${moved.value} belongs to the destination topic now and will be delivered after withdrawal.` }
          : { text: "An active turn, a message eligible for handover, and a valid destination are required.", isError: true };
        break;
      }
      case "set_topic_repository": {
        const args = AssignRepositoryArguments.safeParse(parsed.data.arguments);
        if (conversation === undefined || turn === undefined || aborted.aborted || !args.success) {
          result = { text: "An active topic turn and a repository in owner/name form or null are required.", isError: true };
          break;
        }
        const error = conversations.assignRepository(conversation, turn, args.data.repository, args.data.topic);
        result = error === undefined ? { text: args.data.topic === undefined || args.data.topic === conversation ? "Repository assigned to this topic." : `Repository assigned to topic ${args.data.topic}.` } : { text: error, isError: true };
        break;
      }
      case "set_topic_title": {
        const args = SetTopicTitleArguments.safeParse(parsed.data.arguments);
        if (!args.success || /[\r\n\v\f\u0085\u2028\u2029]/u.test(args.data.title)
          || [...args.data.title].reduce((width, character) => width + (/\p{Script=Han}/u.test(character) ? 2 : 1), 0) > 40) {
          result = { text: "Pass only a title in the owner's language on one line. Use up to 20 Chinese or 40 Latin characters. Each Han character counts as two toward the limit of 40.", isError: true };
          break;
        }
        const proposed = conversation !== undefined && turn !== undefined && !aborted.aborted
          && conversations.proposeTitle(conversation, turn, args.data.title);
        result = proposed ? { text: "This topic's title will be updated if the turn completes and the title is still eligible." }
          : { text: "Only an active turn can set its own topic title. Owner titles are protected.", isError: true };
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
            if (error instanceof TicketWriteRefused || error instanceof ScheduleRefused) {
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
