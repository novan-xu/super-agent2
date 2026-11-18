import { z } from "zod";
import { GeneratedText } from "./generated.js";

export const Decision = z.object({
  chosen: GeneratedText,
  why: GeneratedText,
  otherOptions: GeneratedText,
});
export type Decision = z.infer<typeof Decision>;

export const decisionSources = ["worker", "brain"] as const;
export const DecisionSource = z.enum(decisionSources);
export type DecisionSource = z.infer<typeof DecisionSource>;

export const decisionVerdicts = ["ok", "opinion"] as const;
export const DecisionVerdict = z.enum(decisionVerdicts);
export type DecisionVerdict = z.infer<typeof DecisionVerdict>;

export const DecisionId = z.number().int().positive();

export const TicketDecision = Decision.extend({
  id: DecisionId,
  source: DecisionSource,
  attempt: z.number().int().positive().nullable(),
  pullRequest: z.number().int().positive().nullable(),
  at: z.number().int(),
  verdict: DecisionVerdict.nullable(),
  opinion: z.string().nullable(),
  reviewedAt: z.number().int().nullable(),
  sentAt: z.number().int().nullable(),
});
export type TicketDecision = z.infer<typeof TicketDecision>;

export const DecisionReview = z.discriminatedUnion("verdict", [
  z.strictObject({ verdict: z.literal("ok") }),
  z.strictObject({ verdict: z.literal("opinion"), opinion: z.string().trim().min(1) }),
]);
export type DecisionReview = z.infer<typeof DecisionReview>;

export function isSettled(decision: Pick<TicketDecision, "verdict">): boolean {
  return decision.verdict !== null;
}

export function unsettledDecisions<T extends Pick<TicketDecision, "verdict">>(decisions: readonly T[]): T[] {
  return decisions.filter((decision) => !isSettled(decision));
}

export const TicketReviewCount = z.object({
  ticket: z.number().int().positive(),
  count: z.number().int().positive(),
});
export type TicketReviewCount = z.infer<typeof TicketReviewCount>;
