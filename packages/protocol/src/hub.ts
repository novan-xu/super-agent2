import { PeerStatus } from "./peers.js";
import { z } from "zod";
import { CommandOutput, CommandUpdate, FollowCommand, UnfollowCommand } from "./commands.js";
import { BrainUpdate, ConversationUpdate, EntryDelta, EntryUpdate, ReadStreamPage, StreamEntryUpdate, StreamPageUpdate, TopicDetailUpdate, TopicHistoryUpdate, TurnUpdate, UnwatchConversation, UnwatchStream, WatchConversation, WatchStream } from "./conversations.js";
import { ProtocolVersion } from "./version.js";
import { MemoriesUpdate } from "./memory.js";
import { AllowanceReport } from "./providers.js";
import { SchedulesUpdate } from "./schedules.js";
import { SettingsUpdate } from "./settings.js";
import { TicketsUpdate, TicketUpdate } from "./tickets.js";
import { WaitingUpdate } from "./waiting.js";
import { UnwatchTicket, WatchTicket, WorkEventUpdate } from "./work.js";

export const PersonIdentity = z.object({
  kind: z.literal("person"),
  email: z.email(),
  subject: z.string().min(1),
});

export type PersonIdentity = z.infer<typeof PersonIdentity>;

export const ServiceIdentity = z.object({
  kind: z.literal("service"),
  clientId: z.string().min(1),
});

export type ServiceIdentity = z.infer<typeof ServiceIdentity>;

export const Identity = z.discriminatedUnion("kind", [PersonIdentity, ServiceIdentity]);

export type Identity = z.infer<typeof Identity>;

export const Health = z.object({
  status: z.enum(["ok", "unavailable"]),
  version: z.string().optional(),
});

export type Health = z.infer<typeof Health>;

export const refusalReasonLength = 500;

export const Refusal = z.object({
  error: z.enum(["forbidden", "not_found", "unsupported_media_type", "bad_request", "conflict", "unsupported", "incomplete", "unavailable", "cloudflare", "cloudflare_refused", "release", "too_large"]),
  reason: z.string().max(refusalReasonLength).optional(),
});

export const largestMessageBytes = 64 * 1024 * 1024;

export type Refusal = z.infer<typeof Refusal>;

export const Session = z.object({
  protocol: ProtocolVersion,
  identity: Identity,
});

export type Session = z.infer<typeof Session>;

export const Hello = z.object({
  type: z.literal("hello"),
  protocol: ProtocolVersion,
  identity: Identity,
});

export type Hello = z.infer<typeof Hello>;

export const ServerMessage = z.discriminatedUnion("type", [
  Hello,
  z.object({ type: z.literal("peers"), peers: z.array(PeerStatus) }),
  z.object({ type: z.literal("transfer.changed") }),
  CommandUpdate,
  CommandOutput,
  ConversationUpdate,
  TopicHistoryUpdate,
  TopicDetailUpdate,
  TurnUpdate,
  EntryUpdate,
  EntryDelta,
  StreamEntryUpdate,
  StreamPageUpdate,
  BrainUpdate,
  WaitingUpdate,
  TicketsUpdate,
  TicketUpdate,
  WorkEventUpdate,
  MemoriesUpdate,
  SettingsUpdate,
  SchedulesUpdate,
  z.object({ type: z.literal("allowance"), allowance: AllowanceReport }),
]);

export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion("type", [FollowCommand, UnfollowCommand, WatchConversation, UnwatchConversation, WatchStream, UnwatchStream, ReadStreamPage, WatchTicket, UnwatchTicket]);
export type ClientMessage = z.infer<typeof ClientMessage>;
