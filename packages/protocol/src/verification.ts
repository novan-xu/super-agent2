import { z } from "zod";

export const verificationRules = ["documentation", "workflows", "none", "skipped", "outside"] as const;
export const VerificationRule = z.enum(verificationRules);
export type VerificationRule = z.infer<typeof VerificationRule>;

export const verificationStates = ["checking", "waiting", "failed", "conflict", "merging", "merged"] as const;
export const VerificationState = z.enum(verificationStates);
export type VerificationState = z.infer<typeof VerificationState>;

export const verificationWaits = ["github", "woodpecker", "pipeline", "workflows", "halted", "mergeable", "closed", "finishing", "screenshots"] as const;
export const VerificationWait = z.enum(verificationWaits);
export type VerificationWait = z.infer<typeof VerificationWait>;

export const changeLevels = ["documentation", "code"] as const;
export const ChangeLevel = z.enum(changeLevels);
export type ChangeLevel = z.infer<typeof ChangeLevel>;

export const VerifiedWorkflow = z.object({
  name: z.string(),
  state: z.string(),
});
export type VerifiedWorkflow = z.infer<typeof VerifiedWorkflow>;

export const FailedStep = z.object({
  workflow: z.string(),
  step: z.string(),
  exitCode: z.number().int().nullable(),
});
export type FailedStep = z.infer<typeof FailedStep>;

export const VerifiedPipeline = z.object({
  number: z.number().int().positive(),
  url: z.string(),
});
export type VerifiedPipeline = z.infer<typeof VerifiedPipeline>;

export const TicketVerification = z.object({
  head: z.string().nullable(),
  level: ChangeLevel.nullable(),
  rule: VerificationRule.nullable(),
  state: VerificationState,
  waiting: VerificationWait.nullable(),
  reason: z.string().nullable(),
  pipeline: VerifiedPipeline.nullable(),
  workflows: z.array(VerifiedWorkflow),
  failures: z.array(FailedStep),
  mergeCommit: z.string().nullable(),
  deployment: z.boolean().nullable(),
  skipReason: z.string().nullable(),
  conflictReturns: z.number().int().nonnegative(),
  checkedAt: z.number().int().nullable(),
});
export type TicketVerification = z.infer<typeof TicketVerification>;

export const documentationExtensions: readonly string[] = [".md", ".markdown", ".mdown", ".rst", ".adoc", ".asciidoc", ".txt", ".text"];

export const documentationNames: readonly string[] = [
  "readme",
  "license",
  "licence",
  "copying",
  "notice",
  "authors",
  "contributors",
  "changelog",
  "changes",
  "history",
];

export const notDocumentation: readonly RegExp[] = [/^requirements[^/]*\.txt$/i, /^constraints[^/]*\.txt$/i, /^cmakelists\.txt$/i];

export const deploymentFile = ".superagent2/deployment.json";

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export function isDocumentation(path: string): boolean {
  const name = baseName(path);
  if (name === "" || notDocumentation.some((pattern) => pattern.test(name))) {
    return false;
  }
  const lower = name.toLowerCase();
  if (documentationNames.includes(lower)) {
    return true;
  }
  const dot = lower.lastIndexOf(".");
  return dot > 0 && documentationExtensions.includes(lower.slice(dot));
}

export interface ChangedPath {
  readonly path: string;
  readonly previous?: string | null | undefined;
}

export function changeLevel(changed: readonly ChangedPath[]): ChangeLevel {
  if (changed.length === 0) {
    return "code";
  }
  for (const entry of changed) {
    if (!isDocumentation(entry.path)) {
      return "code";
    }
    if (entry.previous !== undefined && entry.previous !== null && !isDocumentation(entry.previous)) {
      return "code";
    }
  }
  return "documentation";
}
