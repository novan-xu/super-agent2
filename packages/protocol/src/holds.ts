import { z } from "zod";
import { CommandRecord } from "./commands.js";

export const HoldAnswer = z.enum(["released", "refused", "withdrawn"]);

export type HoldAnswer = z.infer<typeof HoldAnswer>;

export const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

export const Hold = z.object({
  command: z.string().min(1),
  form: z.string().min(1),
  description: z.string(),
  evidence: z.string(),
  fingerprint: Fingerprint,
  heldAt: z.number().int(),
  answer: HoldAnswer.nullable(),
  answeredAt: z.number().int().nullable(),
  answeredBy: z.string().nullable(),
});

export type Hold = z.infer<typeof Hold>;

export const HeldCommand = z.object({
  command: CommandRecord,
  hold: Hold,
});

export type HeldCommand = z.infer<typeof HeldCommand>;

export const HoldList = z.object({
  holds: z.array(HeldCommand),
});

export type HoldList = z.infer<typeof HoldList>;

export const HoldDecision = z.object({
  fingerprint: Fingerprint,
});

export type HoldDecision = z.infer<typeof HoldDecision>;
