import { z } from "zod";
import { Attachment } from "./attachments.js";
import { ConversationId, Provider } from "./conversations.js";
import { MemoryBrief } from "./memory.js";
import { ProtocolVersion } from "./version.js";

export const InputSource = z.enum(["owner", "hub"]);
export type InputSource = z.infer<typeof InputSource>;

export const BrainAttachment = Attachment.extend({
  path: z.string().min(1),
});
export type BrainAttachment = z.infer<typeof BrainAttachment>;

export const BrainInput = z.object({
  id: z.string().min(1),
  source: InputSource,
  text: z.string(),
  attachments: z.array(BrainAttachment).default([]),
});
export type BrainInput = z.infer<typeof BrainInput>;

export const HistoryItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), text: z.string(), attachments: z.array(BrainAttachment).default([]) }),
  z.object({ kind: z.literal("notice"), text: z.string() }),
  z.object({ kind: z.literal("text"), provider: Provider.nullable(), text: z.string() }),
  z.object({ kind: z.literal("tool"), provider: Provider.nullable(), name: z.string(), input: z.string(), output: z.string() }),
]);
export type HistoryItem = z.infer<typeof HistoryItem>;

export const TurnOutcome = z.enum(["completed", "interrupted", "failed"]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

export const RunningTurn = z.object({
  conversation: ConversationId,
  turn: z.string().min(1),
});
export type RunningTurn = z.infer<typeof RunningTurn>;

export const BrainHello = z.object({
  type: z.literal("hello"),
  protocol: ProtocolVersion,
  running: z.array(RunningTurn),
});
export type BrainHello = z.infer<typeof BrainHello>;

export const TurnStarted = z.object({
  type: z.literal("turn.started"),
  conversation: ConversationId,
  turn: z.string().min(1),
  provider: Provider,
  model: z.string(),
  inputs: z.array(z.string().min(1)),
});
export type TurnStarted = z.infer<typeof TurnStarted>;

export const InputTaken = z.object({
  type: z.literal("input.taken"),
  conversation: ConversationId,
  turn: z.string().min(1),
  input: z.string().min(1),
});
export type InputTaken = z.infer<typeof InputTaken>;

export const ProviderChanged = z.object({
  type: z.literal("provider.changed"),
  conversation: ConversationId,
  turn: z.string().min(1),
  from: Provider,
  to: Provider,
  model: z.string(),
  reason: z.string(),
});
export type ProviderChanged = z.infer<typeof ProviderChanged>;

export const TextDelta = z.object({
  type: z.literal("text"),
  conversation: ConversationId,
  turn: z.string().min(1),
  block: z.string().min(1),
  delta: z.string(),
});
export type TextDelta = z.infer<typeof TextDelta>;

export const ToolStarted = z.object({
  type: z.literal("tool.started"),
  conversation: ConversationId,
  turn: z.string().min(1),
  call: z.string().min(1),
  name: z.string(),
  input: z.string(),
});
export type ToolStarted = z.infer<typeof ToolStarted>;

export const ToolOutput = z.object({
  type: z.literal("tool.output"),
  conversation: ConversationId,
  turn: z.string().min(1),
  call: z.string().min(1),
  delta: z.string(),
});
export type ToolOutput = z.infer<typeof ToolOutput>;

export const ToolFinished = z.object({
  type: z.literal("tool.finished"),
  conversation: ConversationId,
  turn: z.string().min(1),
  call: z.string().min(1),
  output: z.string().nullable(),
  ok: z.boolean(),
});
export type ToolFinished = z.infer<typeof ToolFinished>;

export const TurnFinished = z.object({
  type: z.literal("turn.finished"),
  conversation: ConversationId,
  turn: z.string().min(1),
  outcome: TurnOutcome,
  reason: z.string().nullable(),
});
export type TurnFinished = z.infer<typeof TurnFinished>;

export const SessionRecorded = z.object({
  type: z.literal("session"),
  conversation: ConversationId,
  provider: Provider,
  session: z.string().min(1),
});
export type SessionRecorded = z.infer<typeof SessionRecorded>;

export const PrepareRequest = z.object({
  type: z.literal("prepare"),
  request: z.string().min(1),
  conversation: ConversationId,
  provider: Provider,
  exclude: z.array(z.string().min(1)),
  fresh: z.boolean(),
});
export type PrepareRequest = z.infer<typeof PrepareRequest>;

export const ProviderState = z.object({
  provider: Provider,
  model: z.string(),
  effort: z.string(),
  available: z.boolean(),
  until: z.number().int().nullable(),
});
export type ProviderState = z.infer<typeof ProviderState>;

export const BrainProviders = z.object({
  type: z.literal("providers"),
  order: z.array(Provider),
  providers: z.array(ProviderState),
});
export type BrainProviders = z.infer<typeof BrainProviders>;

export const BrainMessage = z.discriminatedUnion("type", [
  BrainHello,
  TurnStarted,
  InputTaken,
  ProviderChanged,
  TextDelta,
  ToolStarted,
  ToolOutput,
  ToolFinished,
  TurnFinished,
  SessionRecorded,
  PrepareRequest,
  BrainProviders,
]);
export type BrainMessage = z.infer<typeof BrainMessage>;

export const HubHello = z.object({
  type: z.literal("hello"),
  protocol: ProtocolVersion,
});
export type HubHello = z.infer<typeof HubHello>;

export const DeliverInput = z.object({
  type: z.literal("input"),
  conversation: ConversationId,
  input: BrainInput,
});
export type DeliverInput = z.infer<typeof DeliverInput>;

export const InterruptTurn = z.object({
  type: z.literal("interrupt"),
  conversation: ConversationId,
});
export type InterruptTurn = z.infer<typeof InterruptTurn>;

export const Prepared = z.object({
  type: z.literal("prepared"),
  request: z.string().min(1),
  session: z.string().min(1).nullable(),
  history: z.array(HistoryItem),
  memory: MemoryBrief.nullable().default(null),
});
export type Prepared = z.infer<typeof Prepared>;

export const SetProviderOrder = z.object({
  type: z.literal("order"),
  order: z.array(Provider).min(1),
});
export type SetProviderOrder = z.infer<typeof SetProviderOrder>;

export const HubToBrain = z.discriminatedUnion("type", [HubHello, DeliverInput, InterruptTurn, Prepared, SetProviderOrder]);
export type HubToBrain = z.infer<typeof HubToBrain>;

export const brainLinkPath = "/brain/link";
export const brainToolsPath = "/brain/mcp";
export const conversationHeader = "x-super-agent-conversation";
