import { z } from "zod";
import { CommandRecord } from "./commands.js";
import { MachineChoice, StartChoice } from "./defaults.js";
import { GeneratedText } from "./generated.js";
import { Hold } from "./holds.js";
import { RepositoryName, Ticket, TicketId, TicketState } from "./tickets.js";

export const cardKinds = ["hold", "start", "stuck"] as const;

export type CardKind = (typeof cardKinds)[number];

export function cardKey(kind: CardKind, id: string): string {
  return `${kind}:${id}`;
}

export const HoldCard = z.object({
  kind: z.literal("hold"),
  key: z.string().min(1),
  at: z.number().int(),
  command: CommandRecord,
  hold: Hold,
});

export type HoldCard = z.infer<typeof HoldCard>;

export const ChainBefore = z.object({
  id: TicketId,
  title: GeneratedText,
  repository: RepositoryName.nullable(),
  state: TicketState,
});

export type ChainBefore = z.infer<typeof ChainBefore>;

export const StartCard = z.object({
  kind: z.literal("start"),
  key: z.string().min(1),
  at: z.number().int(),
  ticket: Ticket,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  before: z.array(ChainBefore),
  startable: z.boolean(),
  choice: StartChoice,
  machines: z.array(MachineChoice),
});

export type StartCard = z.infer<typeof StartCard>;

export const StuckCard = z.object({
  kind: z.literal("stuck"),
  key: z.string().min(1),
  at: z.number().int(),
  ticket: Ticket,
  guidance: GeneratedText.nullable(),
});

export type StuckCard = z.infer<typeof StuckCard>;

export function stuckCardKey(ticket: number, at: number): string {
  return cardKey("stuck", `${ticket}-${at}`);
}

export const WaitingCard = z.discriminatedUnion("kind", [HoldCard, StartCard, StuckCard]);

export type WaitingCard = z.infer<typeof WaitingCard>;

export const WaitingList = z.object({
  cards: z.array(WaitingCard),
});

export type WaitingList = z.infer<typeof WaitingList>;

export const WaitingUpdate = z.object({
  type: z.literal("waiting"),
  cards: z.array(WaitingCard),
});

export type WaitingUpdate = z.infer<typeof WaitingUpdate>;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);

export const PushKey = z.object({
  publicKey: Base64Url.nullable(),
});

export type PushKey = z.infer<typeof PushKey>;

export const PushSubscriptionRequest = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: Base64Url.max(256),
    auth: Base64Url.max(64),
  }),
  applicationServerKey: Base64Url.max(256),
});

export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequest>;

export const PushRemoval = z.object({
  endpoint: z.url().max(2048),
});

export type PushRemoval = z.infer<typeof PushRemoval>;

export const PushState = z.object({
  subscribed: z.boolean(),
});

export type PushState = z.infer<typeof PushState>;

export const PushPayload = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  url: z.string().regex(/^\/(?!\/)/),
  tag: z.string().min(1),
});

export type PushPayload = z.infer<typeof PushPayload>;
