import { z } from "zod";
import { ScreenshotSet } from "./ui-screenshots.js";
import { ConversationId } from "./conversations.js";
import { RepositoryName } from "./repositories.js";
import { TicketDecision, TicketReviewCount } from "./decisions.js";
import { GeneratedText } from "./generated.js";
import { ProgramId } from "./runner.js";
import { TicketRound, TicketStuck } from "./rounds.js";
import { TicketVerification } from "./verification.js";
import { TicketCode, TicketCodeDate, TicketReference } from "./ticket-reference.js";
import { WorkStatus } from "./work.js";

export const ticketForms = ["code", "task"] as const;
export const TicketForm = z.enum(ticketForms);
export type TicketForm = z.infer<typeof TicketForm>;

export const ticketKinds = ["writing", "operation", "parameter", "fix", "feature", "refactor", "maintenance"] as const;
export const TicketKind = z.enum(ticketKinds);
export type TicketKind = z.infer<typeof TicketKind>;

export const taskKinds = ["writing", "operation"] as const satisfies readonly TicketKind[];
export const codeKinds = ["parameter", "fix", "feature", "refactor", "maintenance"] as const satisfies readonly TicketKind[];

export function kindsOf(form: TicketForm): readonly TicketKind[] {
  return form === "task" ? taskKinds : codeKinds;
}

export function fitsForm(form: TicketForm, kind: TicketKind): boolean {
  return kindsOf(form).includes(kind);
}

export const ticketStates = ["pending", "waiting", "working", "verifying", "stuck", "merged", "delivered", "stopped"] as const;
export const TicketState = z.enum(ticketStates);
export type TicketState = z.infer<typeof TicketState>;

export const difficulties = ["mechanical", "standard", "complex"] as const;
export const Difficulty = z.enum(difficulties);
export type Difficulty = z.infer<typeof Difficulty>;

export const platforms = ["macos", "windows", "any"] as const;
export const Platform = z.enum(platforms);
export type Platform = z.infer<typeof Platform>;

export const ticketMoves: Readonly<Record<TicketState, readonly TicketState[]>> = {
  pending: ["waiting", "working", "stopped"],
  waiting: ["working", "stopped"],
  working: ["verifying", "merged", "delivered", "stuck", "stopped"],
  verifying: ["working", "merged", "stuck", "stopped"],
  stuck: ["working", "verifying", "stopped"],
  merged: [],
  delivered: [],
  stopped: [],
};

export const statesOutsideForm: Readonly<Record<TicketForm, readonly TicketState[]>> = {
  task: ["verifying", "merged"],
  code: ["delivered"],
};

export const doneTicketStates: readonly TicketState[] = ["merged", "delivered"];

export function isDoneTicket(state: TicketState): boolean {
  return doneTicketStates.includes(state);
}

export const openTicketStates: readonly TicketState[] = ticketStates.filter((state) => ticketMoves[state].length > 0);

export const finishedTicketStates: readonly TicketState[] = ticketStates.filter((state) => ticketMoves[state].length === 0);

export function isOpenTicket(state: TicketState): boolean {
  return openTicketStates.includes(state);
}

export function canMoveTicket(form: TicketForm, from: TicketState, to: TicketState): boolean {
  return ticketMoves[from].includes(to) && !statesOutsideForm[form].includes(to);
}

export { RepositoryName } from "./repositories.js";

export const IssueNumber = z.number().int().positive();

export const TicketId = z.number().int().positive();

export const TicketIssue = z.object({
  repository: RepositoryName,
  number: IssueNumber,
  url: z.string().min(1),
  title: GeneratedText,
  summary: GeneratedText,
});
export type TicketIssue = z.infer<typeof TicketIssue>;

export const TicketWait = z.object({
  ticket: TicketId,
  reference: TicketReference.optional(),
  deployment: z.boolean(),
  waived: z.boolean(),
});
export type TicketWait = z.infer<typeof TicketWait>;

export const choosers = ["default", "owner"] as const;
export const Chooser = z.enum(choosers);
export type Chooser = z.infer<typeof Chooser>;

export const choiceFields = ["machine", "engine", "model", "effort"] as const;
export type ChoiceField = (typeof choiceFields)[number];

export const ModelName = z.string().trim().min(1).max(200).regex(/^[^\s]+$/);
export const EffortName = z.string().trim().min(1).max(50).regex(/^[^\s]+$/);

export const OwnerChoice = z.object({
  machine: z.string().min(1).max(63).nullable(),
  engine: ProgramId.nullable(),
  model: ModelName.nullable(),
  effort: EffortName.nullable(),
});
export type OwnerChoice = z.infer<typeof OwnerChoice>;

export const noOwnerChoice: OwnerChoice = { machine: null, engine: null, model: null, effort: null };

export const ChosenBy = z.object({
  machine: Chooser,
  engine: Chooser,
  model: Chooser,
  effort: Chooser,
});
export type ChosenBy = z.infer<typeof ChosenBy>;

export const TicketRun = z.object({
  machine: z.string().min(1),
  engine: ProgramId,
  model: z.string().min(1),
  effort: z.string().min(1),
  at: z.number().int(),
});
export type TicketRun = z.infer<typeof TicketRun>;

export const ticketPullRequestStates = ["open", "merged", "closed"] as const;
export const TicketPullRequestState = z.enum(ticketPullRequestStates);
export type TicketPullRequestState = z.infer<typeof TicketPullRequestState>;

export const TicketPullRequest = z.object({
  number: IssueNumber,
  url: z.string().min(1),
  branch: z.string(),
  state: TicketPullRequestState,
  closes: z.array(IssueNumber),
  mergeCommit: z.string().nullable(),
  deployment: z.boolean().nullable(),
  handedAt: z.number().int(),
  mergedAt: z.number().int().nullable(),
  screenshots: ScreenshotSet.optional(),
});
export type TicketPullRequest = z.infer<typeof TicketPullRequest>;

export const ClosedChainIssue = z.object({
  number: IssueNumber,
  stateReason: z.string().nullable(),
  comment: z.string().nullable(),
});
export type ClosedChainIssue = z.infer<typeof ClosedChainIssue>;

export interface ChainProgress {
  readonly issues: readonly Pick<TicketIssue, "number">[];
  readonly pullRequests: readonly Pick<TicketPullRequest, "state" | "closes">[];
  readonly closedOutside?: readonly Pick<ClosedChainIssue, "number">[];
}

export function mergedIssueNumbers(ticket: ChainProgress): number[] {
  const closed = new Set(ticket.pullRequests.filter((pull) => pull.state === "merged").flatMap((pull) => pull.closes));
  return ticket.issues.filter((issue) => closed.has(issue.number)).map((issue) => issue.number);
}

export function openIssueNumbers(ticket: ChainProgress): number[] {
  const settled = new Set([...mergedIssueNumbers(ticket), ...(ticket.closedOutside ?? []).map((issue) => issue.number)]);
  return ticket.issues.filter((issue) => !settled.has(issue.number)).map((issue) => issue.number);
}

export function openPullRequest<T extends Pick<TicketPullRequest, "state">>(pullRequests: readonly T[]): T | undefined {
  return pullRequests.filter((pull) => pull.state === "open").at(-1);
}

export function hasRemainingWork(ticket: ChainProgress & { readonly form: TicketForm }): boolean {
  return ticket.form === "task" || openIssueNumbers(ticket).length > 0;
}

export const repairOpeners = ["owner", "brain"] as const;
export const RepairOpener = z.enum(repairOpeners);
export type RepairOpener = z.infer<typeof RepairOpener>;

export const CommitName = z.string().regex(/^[0-9a-f]{7,40}$/i);

export const mergedCommit = "merged";

export const CommitRef = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((ref) => !ref.startsWith("-") && !ref.includes(".."), { message: "is not a commit or a branch" });

export const LightTaskMode = z.enum(["transfer", "agent_wring"]);
export type LightTaskMode = z.infer<typeof LightTaskMode>;

export const Ticket = z.object({
  id: TicketId,
  code: TicketCode,
  codeDate: TicketCodeDate,
  form: TicketForm.default("code"),
  light: LightTaskMode.optional(),
  repository: RepositoryName.nullable(),
  project: RepositoryName.optional(),
  scheduleRun: z.uuid().optional(),
  issues: z.array(TicketIssue),
  title: GeneratedText,
  summary: GeneratedText,
  kind: TicketKind,
  difficulty: Difficulty.nullable(),
  difficultyReason: GeneratedText.nullable(),
  platform: Platform.nullable(),
  requiredMachine: z.string().nullable().default(null),
  commitRef: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
  deploys: z.boolean().default(false),
  brainEngine: ProgramId.nullable(),
  ownerChoice: OwnerChoice,
  state: TicketState,
  machine: z.string().nullable(),
  engine: ProgramId.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  chosenBy: ChosenBy.nullable(),
  chosenAt: z.number().int().nullable(),
  ran: TicketRun.nullable(),
  branch: z.string().nullable(),
  pullRequest: IssueNumber.nullable(),
  pullRequests: z.array(TicketPullRequest),
  closedOutside: z.array(ClosedChainIssue).optional(),
  decisions: z.array(TicketDecision).default([]),
  report: GeneratedText.nullable(),
  work: WorkStatus.nullable(),
  verification: TicketVerification.nullable(),
  round: z.number().int().nonnegative(),
  freeRetry: z.boolean(),
  stuck: TicketStuck.nullable(),
  waitsFor: z.array(TicketId),
  waits: z.array(TicketWait),
  deployedAt: z.number().int().nullable(),
  beginFailure: z.string().nullable(),
  startBlock: z.object({ en: z.string(), zh: z.string(), provider: z.literal(true).optional() }).nullable().optional(),
  stopReason: GeneratedText.nullable(),
  joinedInto: TicketId.nullable(),
  repairs: TicketId.nullable().default(null),
  repairedBy: TicketId.nullable().default(null),
  repairsReference: TicketReference.optional(),
  repairedByReference: TicketReference.optional(),
  conversation: ConversationId.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type Ticket = z.infer<typeof Ticket>;

export function ticketProject(ticket: Pick<Ticket, "repository" | "project">): string | null {
  return ticket.repository ?? ticket.project ?? null;
}

export const TicketMove = z.object({
  ticket: TicketId,
  seq: z.number().int().positive(),
  from: TicketState.nullable(),
  to: TicketState,
  reason: GeneratedText.nullable(),
  at: z.number().int(),
});
export type TicketMove = z.infer<typeof TicketMove>;

export const ticketSwitchKinds = ["switched", "waiting", "resumed"] as const;
export const TicketSwitchKind = z.enum(ticketSwitchKinds);
export type TicketSwitchKind = z.infer<typeof TicketSwitchKind>;

export const TicketSwitch = z.object({
  ticket: TicketId,
  seq: z.number().int().positive(),
  kind: TicketSwitchKind,
  at: z.number().int(),
  from: ProgramId,
  fromModel: z.string().optional(),
  to: ProgramId.nullable(),
  machine: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  reason: z.string(),
  until: z.number().int().nullable(),
  owner: z.boolean(),
  attempt: z.number().int().positive().nullable(),
});
export type TicketSwitch = z.infer<typeof TicketSwitch>;

export const TicketResponse = z.object({
  ticket: Ticket,
});
export type TicketResponse = z.infer<typeof TicketResponse>;

export const TicketList = z.object({
  tickets: z.array(Ticket),
});
export type TicketList = z.infer<typeof TicketList>;

export const TicketDetail = z.object({
  ticket: Ticket,
  moves: z.array(TicketMove),
  attempts: z.array(WorkStatus),
  rounds: z.array(TicketRound),
  switches: z.array(TicketSwitch).default([]),
});
export type TicketDetail = z.infer<typeof TicketDetail>;

export const TicketsUpdate = z.object({
  type: z.literal("tickets"),
  tickets: z.array(Ticket),
  reviews: z.array(TicketReviewCount).default([]),
});
export type TicketsUpdate = z.infer<typeof TicketsUpdate>;

export const TicketUpdate = z.object({
  type: z.literal("ticket"),
  ticket: Ticket,
});
export type TicketUpdate = z.infer<typeof TicketUpdate>;
