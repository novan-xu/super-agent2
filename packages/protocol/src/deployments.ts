import { z } from "zod";
import { TargetName } from "./commands.js";
import { reservedTargetNames } from "./runner.js";

export const defaultHealthEverySeconds = 5;
export const defaultHealthWithinSeconds = 120;

export const DeploymentHealth = z.strictObject({
  command: z.string().trim().min(1),
  everySeconds: z.number().int().min(1).max(3_600).default(defaultHealthEverySeconds),
  withinSeconds: z.number().int().min(1).max(86_400).default(defaultHealthWithinSeconds),
});
export type DeploymentHealth = z.infer<typeof DeploymentHealth>;

export const DeploymentTarget = TargetName.max(63).refine((name) => !reservedTargetNames.includes(name), {
  error: "names no work machine: a deployment is done by a worker on one of the owner's machines, never in the hub's container or on the NAS host",
});

export const DeploymentFile = z.strictObject({
  target: z.preprocess(
    (value) => typeof value === "string" ? [value] : value,
    z.array(DeploymentTarget).min(1).refine((names) => new Set(names).size === names.length, { error: "machine names must be distinct" }),
  ),
  folder: z.string().trim().min(1).max(1_000).optional(),
  deploy: z.string().trim().min(1),
  health: DeploymentHealth,
  rollback: z.string().trim().min(1),
});
export type DeploymentFile = z.infer<typeof DeploymentFile>;

export const deploymentCommitPlaceholder = "{commit}";

export type DeploymentFileReading = { readonly ok: true; readonly file: DeploymentFile } | { readonly ok: false; readonly reason: string };

export function readDeploymentFile(text: string): DeploymentFileReading {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
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
