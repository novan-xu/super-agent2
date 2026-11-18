import { z } from "zod";
import { Attachment, AttachmentId } from "./attachments.js";
import { GeneratedText } from "./generated.js";
import { RepositoryName } from "./repositories.js";

export const providers = ["gpt", "claude", "deepseek"] as const;
export const Provider = z.enum(providers);
export type Provider = z.infer<typeof Provider>;

export const ConversationId = z.string().regex(/^[0-9A-Za-z-]{1,64}$/);

export const ConversationState = z.enum(["idle", "working"]);
export type ConversationState = z.infer<typeof ConversationState>;

export const Conversation = z.object({
  id: ConversationId,
  title: z.string(),
  state: ConversationState,
  topicState: z.enum(["active", "archived"]).default("active"),
  repository: RepositoryName.nullable().default(null),
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
});
export type OwnerEntry = z.infer<typeof OwnerEntry>;

export const NoticeEntry = z.object({ ...entryBase, kind: z.literal("notice"), text: z.string(), turn: z.string().nullable() });
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

export const ConversationEntry = z.discriminatedUnion("kind", [OwnerEntry, NoticeEntry, DeliveryEntry, TextEntry, ToolEntry]);
export type ConversationEntry = z.infer<typeof ConversationEntry>;

export const BrainStatus = z.object({
  linked: z.boolean(),
});
export type BrainStatus = z.infer<typeof BrainStatus>;

export const ConversationList = z.object({
  brain: BrainStatus,
  conversations: z.array(Conversation),
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

export const OwnerMessage = z
  .object({
    text: z.string().trim(),
    attachments: z.array(AttachmentId).default([]),
  })
  .refine((message) => message.text !== "" || message.attachments.length > 0, { message: "needs text or an attachment" });
export type OwnerMessage = z.infer<typeof OwnerMessage>;

export const StreamMessage = OwnerMessage.safeExtend({ topic: ConversationId.optional() });
export type StreamMessage = z.infer<typeof StreamMessage>;

export const StreamEntry = z.object({
  position: z.number().int().positive(),
  topic: Conversation.pick({ id: true, title: true, repository: true }),
  entry: ConversationEntry,
});
export type StreamEntry = z.infer<typeof StreamEntry>;

export const streamPath = "/api/stream";
export const streamPageSize = 50;
export const streamLargestPage = 500;
export const StreamPage = z.object({
  entries: z.array(StreamEntry),
  turns: z.array(Turn),
  before: z.number().int().positive().nullable(),
});
export type StreamPage = z.infer<typeof StreamPage>;

export const StreamPageUpdate = StreamPage.extend({ type: z.literal("stream.page") });
export const StreamEntryUpdate = StreamEntry.extend({ type: z.literal("stream.entry") });

export const WatchStream = z.object({
  type: z.literal("watch.stream"),
  after: z.number().int().nonnegative().optional(),
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
});
export type WatchConversation = z.input<typeof WatchConversation>;

export const UnwatchConversation = z.object({
  type: z.literal("unwatch"),
  conversation: ConversationId,
});
export type UnwatchConversation = z.infer<typeof UnwatchConversation>;
