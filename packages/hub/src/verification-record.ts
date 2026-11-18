import { ChangeLevel, FailedStep, TicketVerification, VerificationRule, VerificationState, VerificationWait, VerifiedPipeline, VerifiedWorkflow } from "@super-agent2/protocol";
import { z } from "zod";

export const VerificationRow = z.object({
  ticket_id: z.number().int(),
  entry: z.number().int(),
  head: z.string().nullable(),
  level: z.string().nullable(),
  rule: z.string().nullable(),
  state: z.string(),
  waiting: z.string().nullable(),
  reason: z.string().nullable(),
  pipeline: z.string().nullable(),
  workflows: z.string(),
  failures: z.string(),
  logs: z.string(),
  told: z.string().nullable(),
  skip_reason: z.string().nullable(),
  skip_at: z.number().int().nullable(),
  conflict_returns: z.number().int(),
  merging_head: z.string().nullable(),
  merging_rule: z.string().nullable(),
  merge_commit: z.string().nullable(),
  merged_at: z.number().int().nullable(),
  closed_issues: z.string(),
  closes: z.string().nullable().default(null),
  branch_done: z.number().int(),
  deployment: z.number().int().nullable(),
  reported_at: z.number().int().nullable(),
  checked_at: z.number().int().nullable(),
  head_at: z.number().int().nullable(),
  wait_since: z.number().int().nullable(),
  notice_key: z.string().nullable(),
  notice_count: z.number().int(),
});
export type VerificationRow = z.infer<typeof VerificationRow>;

export const StepLog = z.object({ workflow: z.string(), step: z.string(), exitCode: z.number().int().nullable(), log: z.string() });
export type StepLog = z.infer<typeof StepLog>;

function parsedList<T>(text: string, schema: z.ZodType<T>): T[] {
  try {
    return z.array(schema).catch([]).parse(JSON.parse(text));
  } catch {
    return [];
  }
}

function parsedPipeline(text: string | null): VerifiedPipeline | null {
  if (text === null) {
    return null;
  }
  try {
    return VerifiedPipeline.nullable().catch(null).parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export function logsOf(row: VerificationRow): StepLog[] {
  return parsedList(row.logs, StepLog);
}

export function closedIssuesOf(row: VerificationRow): number[] {
  return parsedList(row.closed_issues, z.number().int());
}

export function closesOf(row: VerificationRow): number[] | null {
  return row.closes === null ? null : parsedList(row.closes, z.number().int());
}

export function verificationOf(raw: unknown): TicketVerification {
  const row = VerificationRow.parse(raw);
  return TicketVerification.parse({
    head: row.head,
    level: ChangeLevel.nullable().catch(null).parse(row.level),
    rule: VerificationRule.nullable().catch(null).parse(row.rule),
    state: VerificationState.catch("checking").parse(row.state),
    waiting: VerificationWait.nullable().catch(null).parse(row.waiting),
    reason: row.reason,
    pipeline: parsedPipeline(row.pipeline),
    workflows: parsedList(row.workflows, VerifiedWorkflow),
    failures: parsedList(row.failures, FailedStep),
    mergeCommit: row.merge_commit,
    deployment: row.deployment === null ? null : row.deployment === 1,
    skipReason: row.skip_reason,
    conflictReturns: row.conflict_returns,
    checkedAt: row.checked_at,
  });
}
