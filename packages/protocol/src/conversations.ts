import { z } from "zod";
import { Attachment, AttachmentId } from "./attachments.js";
import { Questions, QuestionAnswers } from "./questions.js";
import { GeneratedText } from "./generated.js";
import { RepositoryName } from "./repositories.js";

export const providers = ["gpt", "claude", "deepseek"] as const;
export const Provider = z.enum(providers);
export type Provider = z.infer<typeof Provider>;

export const ConversationId = z.string().regex(/^[0-9A-Za-z-]{1,64}$/);
export const MessageId = z.string().min(1).max(256);

export const TopicScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("code") }),
  z.object({ kind: z.literal("repository"), repository: RepositoryName }),
]);
export type TopicScope = z.infer<typeof TopicScope>;

export function topicInScope(topic: { readonly repository: string | null; readonly needsRepository?: true | undefined }, scope: TopicScope): boolean {
  switch (scope.kind) {
    case "daily":
      return topic.repository === null && topic.needsRepository !== true;
    case "code":
      return topic.repository !== null || topic.needsRepository === true;
    case "repository":
      return topic.repository?.toLowerCase() === scope.repository.toLowerCase();
  }
}

export const ConversationState = z.enum(["idle", "working"]);
export type ConversationState = z.infer<typeof ConversationState>;

export const Conversation = z.object({
  id: ConversationId,
  title: z.string(),
  state: ConversationState,
  topicState: z.enum(["active", "archived"]).default("active"),
  repository: RepositoryName.nullable().default(null),
  needsRepository: z.literal(true).optional(),
  system: z.literal(true).optional(),
  mergedInto: ConversationId.optional(),
  mergePending: z.literal(true).optional(),
  provider: Provider.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Conversation = z.infer<typeof Conversation>;

export const TurnState = z.enum(["running", "completed", "interrupted", "failed"]);
export type TurnState = z.infer<typeof TurnState>;

export const finishedTurnStates: readonly TurnState[] = ["completed", "interrupted", "failed"];

export const Turn = z.object({
  id: z.string().min(1),
  conversation: ConversationId,
  provider: Provider,
  model: z.string(),
  state: TurnState,
  reason: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type Turn = z.infer<typeof Turn>;

export const ToolState = z.enum(["running", "done", "failed"]);
export type ToolState = z.infer<typeof ToolState>;

const entryBase = {
  id: z.string().min(1),
  conversation: ConversationId,
  seq: z.number().int().positive(),
  at: z.number().int(),
};

export const OwnerEntry = z.object({
  ...entryBase,
  kind: z.literal("owner"),
  text: z.string(),
  attachments: z.array(Attachment).default([]),
  taken: z.boolean(),
  quotedMessage: MessageId.optional(),
  possibleMatch: ConversationId.optional(),
  placement: z.enum(["router-joined", "router-opened", "owner"]).optional(),
});
export type OwnerEntry = z.infer<typeof OwnerEntry>;

export const NoticeEntry = z.object({ ...entryBase, kind: z.literal("notice"), text: z.string(), turn: z.string().nullable(),
  ticket: z.number().int().positive().optional(), destination: ConversationId.optional(), start: z.literal(true).optional() });
export type NoticeEntry = z.infer<typeof NoticeEntry>;

export const DeliveryFile = z.object({ name: z.string().min(1), size: z.number().int().nonnegative() });
export type DeliveryFile = z.infer<typeof DeliveryFile>;

export const DeliveryEntry = z.object({
  ...entryBase,
  kind: z.literal("delivery"),
  turn: z.string().nullable(),
  ticket: z.number().int().positive(),
  title: GeneratedText,
  text: z.string().nullable(),
  report: GeneratedText.nullable().default(null),
  files: z.array(DeliveryFile),
});
export type DeliveryEntry = z.infer<typeof DeliveryEntry>;

export const TextEntry = z.object({ ...entryBase, kind: z.literal("text"), turn: z.string(), text: z.string() });
export type TextEntry = z.infer<typeof TextEntry>;

export const ToolEntry = z.object({
  ...entryBase,
  kind: z.literal("tool"),
  turn: z.string(),
  name: z.string(),
  input: z.string(),
  output: z.string(),
  state: ToolState,
});
export type ToolEntry = z.infer<typeof ToolEntry>;

export const QuestionEntry = z.object({ ...entryBase, kind: z.literal("question"), turn: z.string(), questions: Questions, answer: z.union([z.object({ kind: z.literal("card"), answers: QuestionAnswers }), z.object({ kind: z.literal("message"), text: z.string() })]).nullable() });
export type QuestionEntry = z.infer<typeof QuestionEntry>;

export const ConversationEntry = z.discriminatedUnion("kind", [OwnerEntry, NoticeEntry, DeliveryEntry, TextEntry, ToolEntry, QuestionEntry]);
export type ConversationEntry = z.infer<typeof ConversationEntry>;

export const BrainStatus = z.object({
  linked: z.boolean(),
});
export type BrainStatus = z.infer<typeof BrainStatus>;

export const ConversationList = z.object({
  brain: BrainStatus,
  conversations: z.array(Conversation),
  repositories: z.array(RepositoryName).optional(),
});
export type ConversationList = z.infer<typeof ConversationList>;

export const ConversationResponse = z.object({
  conversation: Conversation,
});
export type ConversationResponse = z.infer<typeof ConversationResponse>;

export const ConversationDetail = z.object({
  conversation: Conversation,
  turns: z.array(Turn),
  entries: z.array(ConversationEntry),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;
export const TopicDetailUpdate = ConversationDetail.extend({
  type: z.literal("topic.detail"), requested: ConversationId,
});

export const SendId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export type SendId = z.infer<typeof SendId>;

export const OwnerMessage = z
  .object({
    id: SendId.optional(),
    text: z.string().trim(),
    attachments: z.array(AttachmentId).default([]),
    quotedMessage: MessageId.optional(),
  })
  .refine((message) => message.text !== "" || message.attachments.length > 0, { message: "needs text or an attachment" });
export type OwnerMessage = z.infer<typeof OwnerMessage>;

const RoutingDecision = z.object({
  configuration: z.enum(["model", "bigram"]),
  rule: z.enum(["a", "e", "b", "c", "d"]),
  topic: ConversationId.nullable(),
  best: ConversationId.nullable(),
  bestScore: z.number().nullable(),
  runnerUpScore: z.number().nullable(),
});

export const RoutingProposal = z.object({
  candidates: z.number().int().nonnegative(),
  decided: RoutingDecision,
  shadow: RoutingDecision.nullable(),
  fallback: z.string().max(256).nullable(),
  possibleMatch: ConversationId.optional(),
});
export type RoutingProposal = z.infer<typeof RoutingProposal>;

export const StreamPreviewRequest = z.strictObject({
  scope: TopicScope,
  text: z.string().trim(),
  attachmentNames: z.array(Attachment.shape.name),
});
export type StreamPreviewRequest = z.infer<typeof StreamPreviewRequest>;

export const StreamPreview = z.object({ proposal: RoutingProposal, title: z.string().nullable() });
export type StreamPreview = z.infer<typeof StreamPreview>;

export const StreamMessage = OwnerMessage.safeExtend({
  topic: ConversationId.optional(),
  scope: TopicScope.optional(),
  newTopic: z.literal(true).optional(),
  proposal: RoutingProposal.optional(),
}).refine(({ topic, newTopic, proposal, quotedMessage }) =>
  !(newTopic && (topic !== undefined || quotedMessage !== undefined))
  && (proposal === undefined || (quotedMessage === undefined && (newTopic || topic !== undefined))));
export type StreamMessage = z.infer<typeof StreamMessage>;
export type ReviewedStreamDestination = Pick<StreamMessage, "topic" | "newTopic"> & { readonly proposal: RoutingProposal };

export const StreamEntry = z.object({
  position: z.number().int().positive(),
  topic: Conversation.pick({ id: true, title: true, repository: true, needsRepository: true }),
  entry: ConversationEntry,
  latestOwner: z.boolean().optional(),
});
export type StreamEntry = z.infer<typeof StreamEntry>;

export const streamPath = "/api/stream";
export const streamPreviewPath = `${streamPath}/preview`;
export const streamPageSize = 50;
export const streamLargestPage = 500;
export const StreamPage = z.object({
  entries: z.array(StreamEntry),
  turns: z.array(Turn),
  before: z.number().int().positive().nullable(),
});
export type StreamPage = z.infer<typeof StreamPage>;

const StreamSubscription = z.number().int().positive().optional();
export const StreamPageUpdate = StreamPage.extend({ type: z.literal("stream.page"), subscription: StreamSubscription, resumed: z.literal(true).optional(), revision: z.number().int().nonnegative().optional(), reset: z.literal(true).optional() });
export const StreamEntryUpdate = StreamEntry.extend({ type: z.literal("stream.entry"), subscription: StreamSubscription });

export const WatchStream = z.object({
  type: z.literal("watch.stream"),
  after: z.number().int().nonnegative().optional(),
  scope: TopicScope.optional(),
  subscription: StreamSubscription,
  revision: z.number().int().nonnegative().optional(),
});
export const UnwatchStream = z.object({ type: z.literal("unwatch.stream") });
export const ReadStreamPage = z.object({ type: z.literal("read.stream"), before: z.number().int().positive() });

export const EntryResponse = z.object({
  entry: ConversationEntry,
});
export type EntryResponse = z.infer<typeof EntryResponse>;

export const ConversationUpdate = z.object({
  type: z.literal("conversation"),
  conversation: Conversation,
});
export type ConversationUpdate = z.infer<typeof ConversationUpdate>;

export const TopicHistoryUpdate = z.object({ type: z.literal("topic.history"), topics: z.array(ConversationId) });
export type TopicHistoryUpdate = z.infer<typeof TopicHistoryUpdate>;

export const TopicRename = z.strictObject({ title: z.string().trim().min(1).max(120) });
export const TopicMerge = z.strictObject({ destination: ConversationId });
export const TopicMove = TopicMerge.extend({ message: MessageId, destination: ConversationId.nullable() });
export type TopicMove = z.infer<typeof TopicMove>;

export const TurnUpdate = z.object({
  type: z.literal("turn"),
  turn: Turn,
});
export type TurnUpdate = z.infer<typeof TurnUpdate>;

export const EntryUpdate = z.object({
  type: z.literal("entry"),
  entry: ConversationEntry,
});
export type EntryUpdate = z.infer<typeof EntryUpdate>;

export const EntryDelta = z.object({
  type: z.literal("delta"),
  conversation: ConversationId,
  entry: z.string().min(1),
  field: z.enum(["text", "output"]),
  text: z.string(),
});
export type EntryDelta = z.infer<typeof EntryDelta>;

export const BrainUpdate = z.object({
  type: z.literal("brain"),
  brain: BrainStatus,
});
export type BrainUpdate = z.infer<typeof BrainUpdate>;

export const WatchConversation = z.object({
  type: z.literal("watch"),
  conversation: ConversationId,
  after: z.number().int().nonnegative().default(0),
  snapshot: z.literal(true).optional(),
});
export type WatchConversation = z.input<typeof WatchConversation>;

export const UnwatchConversation = z.object({
  type: z.literal("unwatch"),
  conversation: ConversationId,
});
export type UnwatchConversation = z.infer<typeof UnwatchConversation>;
