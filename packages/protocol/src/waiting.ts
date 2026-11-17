import { z } from "zod";
import { CommandRecord } from "./commands.js";
import { Hold } from "./holds.js";

export const cardKinds = ["hold"] as const;

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

export const WaitingCard = z.discriminatedUnion("kind", [HoldCard]);

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
