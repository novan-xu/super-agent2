import { ExtraMcpServer } from "./extra-mcp.js";
import { z } from "zod";
import { Attachment, AttachmentId } from "./attachments.js";
import { GitHubAccount } from "./commands.js";
import { Decision } from "./decisions.js";
import { GeneratedText } from "./generated.js";
import { TicketReference } from "./ticket-reference.js";

export const workEngines = ["codex", "claude", "dsh", "antigravity"] as const;
export const WorkEngine = z.enum(workEngines);
export type WorkEngine = z.infer<typeof WorkEngine>;

const Ticket = z.number().int().positive();
const Attempt = z.number().int().positive();
const Seq = z.number().int().positive();

export const workPhases = ["preparing", "prepared", "started", "resumed", "turn", "checking", "saving", "removed"] as const;
export const WorkPhase = z.enum(workPhases);
export type WorkPhase = z.infer<typeof WorkPhase>;

export const workFailures = ["prepare", "program", "no-pull-request", "lost", "task-failed"] as const;
export const WorkFailure = z.enum(workFailures);
export type WorkFailure = z.infer<typeof WorkFailure>;

export const filePartBytes = 8 * 1024 * 1024;

export const DeliveryFileName = z
  .string()
  .regex(/^[^/\\:*?"<>|\u0000-\u001f]{1,120}$/u)
  .refine((name) => name !== "." && name !== "..", { message: "is not a file name" });

export const MaterialName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);

export const taskOutcomes = ["done", "failed"] as const;
export const TaskOutcome = z.enum(taskOutcomes);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

export const workSenders = ["owner", "brain", "hub"] as const;
export const WorkSender = z.enum(workSenders);
export type WorkSender = z.infer<typeof WorkSender>;

export const DeliveredFile = z.object({
  name: DeliveryFileName,
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
});
export type DeliveredFile = z.infer<typeof DeliveredFile>;

export const WorkEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phase"), phase: WorkPhase, detail: z.string() }),
  z.object({ kind: z.literal("session"), session: z.string().min(1) }),
  z.object({ kind: z.literal("ran"), model: z.string().min(1), effort: z.string().min(1) }),
  z.object({ kind: z.literal("text"), block: z.string(), delta: z.string() }),
  z.object({ kind: z.literal("question"), id: z.uuid(), text: z.string().trim().min(1) }),
  z.object({ kind: z.literal("tool.started"), call: z.string(), name: z.string(), input: z.string() }),
  z.object({ kind: z.literal("tool.output"), call: z.string(), delta: z.string() }),
  z.object({ kind: z.literal("tool.finished"), call: z.string(), output: z.string().nullable(), ok: z.boolean() }),
  z.object({
    kind: z.literal("message"),
    id: z.string().min(1),
    from: WorkSender,
    text: z.string(),
    attachments: z.array(Attachment).optional(),
    delivery: z.enum(["steered", "queued"]),
  }),
  z.object({
    kind: z.literal("finished"),
    pullRequest: z.number().int().positive(),
    url: z.string().min(1),
    closes: z.array(z.number().int().positive()).optional(),
    report: GeneratedText,
    decisions: z.array(Decision).optional(),
  }),
  z.object({
    kind: z.literal("delivered"),
    outcome: TaskOutcome.optional(),
    commit: z.string().optional(),
    text: z.string().nullable(),
    files: z.array(DeliveredFile),
    report: GeneratedText,
    decisions: z.array(Decision).optional(),
  }),
  z.object({ kind: z.literal("settled") }),
  z.object({ kind: z.literal("failed"), failure: WorkFailure, reason: z.string(), report: GeneratedText.optional() }),
  z.object({ kind: z.literal("stopped"), saved: z.boolean(), detail: z.string() }),
  z.object({ kind: z.literal("unavailable"), reason: z.string(), until: z.number().int().nullable(), unsent: z.array(z.string()).default([]) }),
]);
export type WorkEvent = z.infer<typeof WorkEvent>;

export const endingWorkEvents: readonly WorkEvent["kind"][] = ["finished", "delivered", "failed", "stopped", "unavailable", "settled"];

export function endsWork(event: WorkEvent): boolean {
  return endingWorkEvents.includes(event.kind);
}

export const workStates = ["queued", "preparing", "running", "finished", "failed", "stopped", "replaced", "unavailable"] as const;
export const WorkState = z.enum(workStates);
export type WorkState = z.infer<typeof WorkState>;

export const activeWorkStates: readonly WorkState[] = ["preparing", "running"];

export const WorkStatus = z.object({
  attempt: Attempt,
  state: WorkState,
  machine: z.string().min(1),
  engine: WorkEngine,
  model: z.string().min(1),
  effort: z.string().min(1),
  session: z.string().nullable(),
  failure: WorkFailure.nullable(),
  reason: z.string().nullable(),
  unreachableSince: z.number().int().nullable(),
  last: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
});
export type WorkStatus = z.infer<typeof WorkStatus>;

export const WorkIssue = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().min(1),
});
export type WorkIssue = z.infer<typeof WorkIssue>;

export const WorkTask = z.object({
  ticket: Ticket,
  ticketReference: TicketReference.optional(),
  attempt: Attempt,
  repository: z.string().min(3),
  account: GitHubAccount,
  branch: z.string().min(1),
  title: z.string().min(1),
  issues: z.array(WorkIssue).min(1),
  merged: z.array(z.number().int().positive()).optional(),
  closedOutside: z.array(z.number().int().positive()).optional(),
  engine: WorkEngine,
  model: z.string().min(1),
  effort: z.string().min(1),
  session: z.string().nullable(),
  note: z.string().nullable(),
  takeover: z.boolean().default(false),
  folder: Ticket.optional(),
  environment: z.record(z.string(), z.string()),
  extraMcp: z.array(ExtraMcpServer).optional(),
});
export type WorkTask = z.infer<typeof WorkTask>;

export const TaskMaterial = z.object({
  name: MaterialName,
  source: z.string().trim().min(1),
  text: z.string().nullable(),
  attachment: Attachment.nullable().optional(),
});
export type TaskMaterial = z.infer<typeof TaskMaterial>;

export const TaskCheckout = z.object({
  repository: z.string().min(3),
  account: GitHubAccount,
  commit: z.string().min(1).nullable(),
  ref: z.string().min(1).nullable(),
});
export type TaskCheckout = z.infer<typeof TaskCheckout>;

export const TaskAssignment = z.object({
  ticket: Ticket,
  light: z.literal(true).optional(),
  ticketReference: TicketReference.optional(),
  attempt: Attempt,
  title: z.string().min(1),
  task: z.string().min(1),
  materials: z.array(TaskMaterial),
  checkout: TaskCheckout.nullable().default(null),
  deploys: z.boolean().default(false),
  engine: WorkEngine,
  model: z.string().min(1),
  effort: z.string().min(1),
  session: z.string().nullable(),
  note: z.string().nullable(),
  takeover: z.boolean().default(false),
  folder: Ticket.optional(),
  environment: z.record(z.string(), z.string()).default({}),
  extraMcp: z.array(ExtraMcpServer).optional(),
});
export type TaskAssignment = z.infer<typeof TaskAssignment>;

export const WorkHeld = z.object({
  ticket: Ticket,
  attempt: Attempt,
  last: z.number().int().nonnegative(),
  live: z.boolean(),
  ended: z.boolean(),
});
export type WorkHeld = z.infer<typeof WorkHeld>;

export const RunnerWorkEvent = z.object({
  type: z.literal("work.event"),
  ticket: Ticket,
  attempt: Attempt,
  seq: Seq,
  at: z.number().int(),
  event: WorkEvent,
});
export type RunnerWorkEvent = z.infer<typeof RunnerWorkEvent>;

export const StartWork = z.object({
  type: z.literal("work.start"),
  task: WorkTask,
});
export type StartWork = z.infer<typeof StartWork>;

export const StartTask = z.object({
  type: z.literal("work.task"),
  task: TaskAssignment,
});
export type StartTask = z.infer<typeof StartTask>;

export const SyncWork = z.object({
  type: z.literal("work.sync"),
  ticket: Ticket,
  attempt: Attempt,
  after: z.number().int().nonnegative(),
});
export type SyncWork = z.infer<typeof SyncWork>;

export const FetchFile = z.object({
  type: z.literal("work.file"),
  ticket: Ticket,
  attempt: Attempt,
  name: DeliveryFileName,
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});
export type FetchFile = z.infer<typeof FetchFile>;

export const FilePart = z.object({
  type: z.literal("work.file.part"),
  ticket: Ticket,
  attempt: Attempt,
  name: DeliveryFileName,
  offset: z.number().int().nonnegative(),
  data: z.string().nullable(),
  problem: z.string().nullable(),
});
export type FilePart = z.infer<typeof FilePart>;

export const MessageWork = z.object({
  type: z.literal("work.message"),
  ticket: Ticket,
  attempt: Attempt,
  id: z.string().min(1),
  from: WorkSender,
  text: z.string(),
  attachments: z.array(Attachment).optional(),
});
export type MessageWork = z.infer<typeof MessageWork>;

export const FetchAttachment = z.object({
  type: z.literal("work.attachment"),
  ticket: Ticket,
  attempt: Attempt,
  attachment: AttachmentId,
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});
export type FetchAttachment = z.infer<typeof FetchAttachment>;

export const AttachmentPart = z.object({
  type: z.literal("work.attachment.part"),
  ticket: Ticket,
  attempt: Attempt,
  attachment: AttachmentId,
  offset: z.number().int().nonnegative(),
  data: z.string().nullable(),
  problem: z.string().nullable(),
});
export type AttachmentPart = z.infer<typeof AttachmentPart>;

export const StopWork = z.object({
  type: z.literal("work.stop"),
  ticket: Ticket,
  save: z.boolean(),
  remove: z.boolean(),
});
export type StopWork = z.infer<typeof StopWork>;

export const StoredWorkEvent = z.object({
  id: z.number().int().positive(),
  ticket: Ticket,
  attempt: Attempt,
  seq: Seq,
  at: z.number().int(),
  event: WorkEvent,
});
export type StoredWorkEvent = z.infer<typeof StoredWorkEvent>;

export const WorkEventUpdate = z.object({
  type: z.literal("work"),
  event: StoredWorkEvent,
});
export type WorkEventUpdate = z.infer<typeof WorkEventUpdate>;

export const WatchTicket = z.object({
  type: z.literal("watch.ticket"),
  ticket: Ticket,
  after: z.number().int().nonnegative().default(0),
});
export type WatchTicket = z.input<typeof WatchTicket>;

export const UnwatchTicket = z.object({
  type: z.literal("unwatch.ticket"),
  ticket: Ticket,
});
export type UnwatchTicket = z.infer<typeof UnwatchTicket>;

export const WorkerMessage = z
  .strictObject({
    text: z.string().trim(),
    attachments: z.array(AttachmentId).default([]),
  })
  .refine((message) => message.text !== "" || message.attachments.length > 0, { message: "needs text or an attachment" });
export type WorkerMessage = z.infer<typeof WorkerMessage>;

export const WorkEventList = z.object({
  events: z.array(StoredWorkEvent),
});
export type WorkEventList = z.infer<typeof WorkEventList>;

export const WorkerMessageResponse = z.object({
  id: z.string().min(1),
});
export type WorkerMessageResponse = z.infer<typeof WorkerMessageResponse>;

export const Handback = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.undefined().optional(),
    pullRequest: z.number().int().positive(),
    summary: GeneratedText,
    decisions: z.array(Decision).default([]),
  }),
  z.object({ outcome: z.literal("failed"), report: GeneratedText }),
]);
export type Handback = z.infer<typeof Handback>;

export const TaskHandback = z.preprocess(
  (value) => (typeof value === "object" && value !== null && !("report" in value) && "summary" in value ? { ...value, report: Reflect.get(value, "summary") } : value),
  z.object({
    outcome: TaskOutcome.default("done"),
    report: GeneratedText,
    text: z.string().min(1).nullable().optional(),
    files: z.array(z.string().min(1)).default([]),
    decisions: z.array(Decision).default([]),
  }),
);
export type TaskHandback = z.infer<typeof TaskHandback>;
