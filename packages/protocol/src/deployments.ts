import { z } from "zod";
import { TargetName } from "./commands.js";
import { RepositoryName } from "./tickets.js";

export const defaultHealthEverySeconds = 5;
export const defaultHealthWithinSeconds = 120;

export const DeploymentHealth = z.strictObject({
  command: z.string().trim().min(1).max(20_000),
  everySeconds: z.number().int().min(1).max(3_600).default(defaultHealthEverySeconds),
  withinSeconds: z.number().int().min(1).max(86_400).default(defaultHealthWithinSeconds),
});
export type DeploymentHealth = z.infer<typeof DeploymentHealth>;

export const DeploymentFile = z.strictObject({
  target: TargetName,
  folder: z.string().trim().min(1).max(1_000).optional(),
  deploy: z.string().trim().min(1).max(20_000),
  health: DeploymentHealth,
  rollback: z.string().trim().min(1).max(20_000),
});
export type DeploymentFile = z.infer<typeof DeploymentFile>;

export const deploymentVariables = {
  repository: "SUPERAGENT2_REPOSITORY",
  commit: "SUPERAGENT2_COMMIT",
  previous: "SUPERAGENT2_PREVIOUS_COMMIT",
  deployment: "SUPERAGENT2_DEPLOYMENT",
} as const;

export type DeploymentFileReading = { readonly ok: true; readonly file: DeploymentFile } | { readonly ok: false; readonly reason: string };

export function readDeploymentFile(text: string): DeploymentFileReading {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `it is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = DeploymentFile.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "the file" : issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }
  return { ok: true, file: parsed.data };
}

export const deploymentPhases = ["deploy", "health", "rollback", "recheck", "done"] as const;
export const DeploymentPhase = z.enum(deploymentPhases);
export type DeploymentPhase = z.infer<typeof DeploymentPhase>;

export const deploymentResults = ["succeeded", "rolled-back", "unrecovered", "failed", "unchanged", "not-run", "interrupted"] as const;
export const DeploymentResult = z.enum(deploymentResults);
export type DeploymentResult = z.infer<typeof DeploymentResult>;

export const deploymentOutcomeMarker = "superagent2-deployment-outcome";

export const DeploymentOutcome = z.object({
  result: DeploymentResult,
  reason: z.string().trim().min(1).max(4_000),
  previous: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
});
export type DeploymentOutcome = z.infer<typeof DeploymentOutcome>;

export function readDeploymentOutcome(output: string): DeploymentOutcome | undefined {
  const lines = output.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${deploymentOutcomeMarker} `)) {
      continue;
    }
    try {
      const parsed = DeploymentOutcome.safeParse(JSON.parse(trimmed.slice(deploymentOutcomeMarker.length + 1)));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export const deploymentStepKinds = ["deploy", "health", "rollback", "recheck"] as const;
export const DeploymentStepKind = z.enum(deploymentStepKinds);
export type DeploymentStepKind = z.infer<typeof DeploymentStepKind>;

export const DeploymentStep = z.object({
  seq: z.number().int().positive(),
  kind: DeploymentStepKind,
  command: z.string().min(1),
});
export type DeploymentStep = z.infer<typeof DeploymentStep>;

export const Deployment = z.object({
  id: z.number().int().positive(),
  repository: RepositoryName,
  commit: z.string().min(1),
  previous: z.string().min(1).nullable(),
  target: TargetName,
  file: DeploymentFile,
  conversation: z.string().nullable(),
  phase: DeploymentPhase,
  result: DeploymentResult.nullable(),
  reason: z.string().nullable(),
  notes: z.array(z.string()),
  deployedTickets: z.array(z.number().int().positive()),
  steps: z.array(DeploymentStep),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type Deployment = z.infer<typeof Deployment>;
