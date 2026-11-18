import { z } from "zod";
import { GeneratedText } from "./generated.js";
import type { TicketVerification } from "./verification.js";
import type { WorkStatus } from "./work.js";

export const roundCap = 3;

export const loopFailureKinds = ["workflow", "no-pull-request", "program", "lost", "prepare", "task-failed"] as const;
export const LoopFailureKind = z.enum(loopFailureKinds);
export type LoopFailureKind = z.infer<typeof LoopFailureKind>;

export const machineFailureKinds: readonly LoopFailureKind[] = ["lost", "prepare"];

export const LoopFailure = z.object({
  kind: LoopFailureKind,
  detail: z.string(),
});
export type LoopFailure = z.infer<typeof LoopFailure>;

export const stuckFromStates = ["working", "verifying"] as const;
export const StuckFrom = z.enum(stuckFromStates);
export type StuckFrom = z.infer<typeof StuckFrom>;

export const TicketStuck = z.object({
  at: z.number().int(),
  round: z.number().int().nonnegative(),
  from: StuckFrom,
  failure: LoopFailure,
  where: GeneratedText.nullable(),
});
export type TicketStuck = z.infer<typeof TicketStuck>;

export const TicketRound = z.object({
  seq: z.number().int().positive(),
  round: z.number().int().positive().nullable(),
  attempt: z.number().int().positive(),
  failure: LoopFailure,
  guidance: GeneratedText,
  at: z.number().int(),
});
export type TicketRound = z.infer<typeof TicketRound>;

export const stuckAnswers = ["resume", "give-up"] as const;
export const StuckAnswer = z.enum(stuckAnswers);
export type StuckAnswer = z.infer<typeof StuckAnswer>;

export const StuckAnswerRequest = z.object({
  at: z.number().int(),
  answer: StuckAnswer,
  words: z.string().trim().optional(),
});
export type StuckAnswerRequest = z.infer<typeof StuckAnswerRequest>;

export interface LoopTicket {
  readonly state: string;
  readonly round: number;
  readonly freeRetry: boolean;
  readonly work: Pick<WorkStatus, "state" | "failure" | "reason"> | null;
  readonly verification: Pick<TicketVerification, "state" | "reason"> | null;
  readonly stuck: TicketStuck | null;
}

export function isMachineFailure(kind: LoopFailureKind): boolean {
  return machineFailureKinds.includes(kind);
}

export function countsAsRound(kind: LoopFailureKind, freeRetry: boolean): boolean {
  return !isMachineFailure(kind) || freeRetry;
}

export function capReached(round: number, kind: LoopFailureKind, freeRetry: boolean): boolean {
  return round >= roundCap && countsAsRound(kind, freeRetry);
}

export function loopFailureOf(ticket: LoopTicket): LoopFailure | null {
  if (ticket.state === "stuck") {
    return ticket.stuck?.failure ?? null;
  }
  if (ticket.state === "working") {
    const work = ticket.work;
    if (work === null || work.state !== "failed") {
      return null;
    }
    return { kind: work.failure ?? "program", detail: work.reason ?? "" };
  }
  if (ticket.state === "verifying") {
    const verification = ticket.verification;
    if (verification?.state === "failed") {
      return { kind: "workflow", detail: verification.reason ?? "" };
    }
  }
  return null;
}

export type GuidanceRefusal = "closed" | "stuck" | "running" | "nothing-failed" | "cap";

export function guidanceRefusal(ticket: LoopTicket): GuidanceRefusal | null {
  if (ticket.state === "stuck") {
    return "stuck";
  }
  if (ticket.state !== "working" && ticket.state !== "verifying") {
    return "closed";
  }
  const work = ticket.work;
  if (work !== null && (work.state === "queued" || work.state === "preparing" || work.state === "running")) {
    return "running";
  }
  const failure = loopFailureOf(ticket);
  if (failure === null) {
    return "nothing-failed";
  }
  if (capReached(ticket.round, failure.kind, ticket.freeRetry)) {
    return "cap";
  }
  return null;
}

export interface NextRound {
  readonly counted: boolean;
  readonly round: number;
}

export function nextRound(ticket: LoopTicket, failure: LoopFailure): NextRound {
  const counted = countsAsRound(failure.kind, ticket.freeRetry);
  return { counted, round: counted ? ticket.round + 1 : ticket.round };
}

export function stuckOffers(ticket: Pick<LoopTicket, "state" | "stuck">): readonly StuckAnswer[] {
  return ticket.state === "stuck" && ticket.stuck !== null ? stuckAnswers : [];
}
