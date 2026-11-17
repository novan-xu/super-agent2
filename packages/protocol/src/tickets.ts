import { z } from "zod";
import { ConversationId } from "./conversations.js";
import { GeneratedText } from "./generated.js";
import { ProgramId } from "./runner.js";

export const ticketKinds = ["writing", "parameter", "fix", "feature", "refactor", "maintenance"] as const;
export const TicketKind = z.enum(ticketKinds);
export type TicketKind = z.infer<typeof TicketKind>;

export const ticketStates = ["pending", "waiting", "working", "verifying", "merged", "delivered", "stopped"] as const;
export const TicketState = z.enum(ticketStates);
export type TicketState = z.infer<typeof TicketState>;

export const difficulties = ["mechanical", "standard", "complex"] as const;
export const Difficulty = z.enum(difficulties);
export type Difficulty = z.infer<typeof Difficulty>;

export const platforms = ["macos", "windows", "any"] as const;
export const Platform = z.enum(platforms);
export type Platform = z.infer<typeof Platform>;

export const ticketMoves: Readonly<Record<TicketState, readonly TicketState[]>> = {
  pending: ["waiting", "working", "stopped"],
  waiting: ["working", "stopped"],
  working: ["verifying", "delivered", "stopped"],
  verifying: ["working", "merged", "stopped"],
  merged: [],
  delivered: [],
  stopped: [],
};

export const statesOutsideKind: Readonly<Record<"writing" | "code", readonly TicketState[]>> = {
  writing: ["verifying", "merged"],
  code: ["delivered"],
};

export const openTicketStates: readonly TicketState[] = ticketStates.filter((state) => ticketMoves[state].length > 0);

export const finishedTicketStates: readonly TicketState[] = ticketStates.filter((state) => ticketMoves[state].length === 0);

export function isOpenTicket(state: TicketState): boolean {
  return openTicketStates.includes(state);
}

export function canMoveTicket(kind: TicketKind, from: TicketState, to: TicketState): boolean {
  const outside = statesOutsideKind[kind === "writing" ? "writing" : "code"];
  return ticketMoves[from].includes(to) && !outside.includes(to);
}

export const RepositoryName = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => !name.endsWith("/.") && !name.endsWith("/.."), { message: "is not a repository name" });
export type RepositoryName = z.infer<typeof RepositoryName>;

export const IssueNumber = z.number().int().positive();

export const TicketId = z.number().int().positive();

export const TicketIssue = z.object({
  repository: RepositoryName,
  number: IssueNumber,
  url: z.string().min(1),
  title: GeneratedText,
  summary: GeneratedText,
});
export type TicketIssue = z.infer<typeof TicketIssue>;

export const Ticket = z.object({
  id: TicketId,
  repository: RepositoryName.nullable(),
  issues: z.array(TicketIssue),
  title: GeneratedText,
  summary: GeneratedText,
  kind: TicketKind,
  difficulty: Difficulty.nullable(),
  platform: Platform.nullable(),
  state: TicketState,
  machine: z.string().nullable(),
  engine: ProgramId.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  branch: z.string().nullable(),
  pullRequest: IssueNumber.nullable(),
  round: z.number().int().nonnegative(),
  waitsFor: z.array(TicketId),
  stopReason: GeneratedText.nullable(),
  conversation: ConversationId.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Ticket = z.infer<typeof Ticket>;

export const TicketMove = z.object({
  ticket: TicketId,
  seq: z.number().int().positive(),
  from: TicketState.nullable(),
  to: TicketState,
  reason: GeneratedText.nullable(),
  at: z.number().int(),
});
export type TicketMove = z.infer<typeof TicketMove>;

export const TicketList = z.object({
  tickets: z.array(Ticket),
});
export type TicketList = z.infer<typeof TicketList>;

export const TicketDetail = z.object({
  ticket: Ticket,
  moves: z.array(TicketMove),
});
export type TicketDetail = z.infer<typeof TicketDetail>;

export const TicketsUpdate = z.object({
  type: z.literal("tickets"),
  tickets: z.array(Ticket),
});
export type TicketsUpdate = z.infer<typeof TicketsUpdate>;

export const TicketUpdate = z.object({
  type: z.literal("ticket"),
  ticket: Ticket,
});
export type TicketUpdate = z.infer<typeof TicketUpdate>;
