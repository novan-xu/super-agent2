import { z } from "zod";
import { AllowanceReading } from "./allowance.js";
import { TargetName } from "./commands.js";
import { ProtocolVersion } from "./version.js";
import { SetRunnerStorage, StorageReport, StorageSettings } from "./storage.js";
import { AttachmentPart, FetchAttachment, FetchFile, FilePart, MessageWork, RunnerWorkEvent, StartTask, StartWork, StopWork, SyncWork, WorkHeld } from "./work.js";

export const runnerLinkPath = "/runner/link";
export const runnerReleasePath = "/runner/release";
export const runnerInstallPath = "/runner/install";
export const releaseVersionHeader = "x-superagent2-version";

export const Revision = z.string().regex(/^[0-9a-f]{40}$/);
export type Revision = z.infer<typeof Revision>;
export const runnerTokenHeader = "x-runner-token";
export const accessClientIdHeader = "cf-access-client-id";
export const accessClientSecretHeader = "cf-access-client-secret";

export const reservedTargetNames: readonly string[] = ["hub", "nas"];

export const MachineName = TargetName.max(63).refine((name) => !reservedTargetNames.includes(name), {
  error: "is reserved for a target of the hub",
});
export type MachineName = z.infer<typeof MachineName>;

export const machineSystems = ["windows", "macos"] as const;
export const MachineSystem = z.enum(machineSystems);
export type MachineSystem = z.infer<typeof MachineSystem>;

export const machineAccessWarning = 30 * 24 * 60 * 60 * 1000;

export const programIds = ["codex", "claude", "dsh", "antigravity"] as const;
export const ProgramId = z.enum(programIds);
export type ProgramId = z.infer<typeof ProgramId>;

export const ProgramModel = z.object({
  id: z.string().min(1),
  efforts: z.array(z.string().min(1)),
});
export type ProgramModel = z.infer<typeof ProgramModel>;

export const ProgramReport = z.object({
  id: ProgramId,
  installed: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  models: z.array(ProgramModel),
  source: z.enum(["program", "configuration", "none"]),
  problem: z.string().nullable(),
});
export type ProgramReport = z.infer<typeof ProgramReport>;

export const MachinePlatform = z.enum(["win32", "darwin", "linux"]);
export type MachinePlatform = z.infer<typeof MachinePlatform>;

export const MachineReport = z.object({
  hostname: z.string(),
  platform: MachinePlatform,
  release: z.string(),
  arch: z.string(),
  user: z.string(),
  slots: z.object({ total: z.number().int().nonnegative(), free: z.number().int().nonnegative() }),
  programs: z.array(ProgramReport),
  allowances: z.array(AllowanceReading).default([]),
  storage: StorageReport.optional(),
  version: Revision.optional(),
});
export type MachineReport = z.infer<typeof MachineReport>;

export const RunnerHello = z.object({
  type: z.literal("hello"),
  protocol: ProtocolVersion,
  machine: MachineReport,
  works: z.array(WorkHeld).default([]),
});
export type RunnerHello = z.infer<typeof RunnerHello>;

export const RunnerReport = z.object({
  type: z.literal("report"),
  machine: MachineReport,
});
export type RunnerReport = z.infer<typeof RunnerReport>;

export const RunnerToHub = z.discriminatedUnion("type", [RunnerHello, RunnerReport, RunnerWorkEvent, FilePart, FetchAttachment]);
export type RunnerToHub = z.infer<typeof RunnerToHub>;

export const RunnerWelcome = z.object({
  type: z.literal("welcome"),
  protocol: ProtocolVersion,
  name: MachineName,
  version: Revision.optional(),
});
export type RunnerWelcome = z.infer<typeof RunnerWelcome>;

export const RefreshAllowance = z.object({ type: z.literal("allowance.refresh") });

export const HubToRunner = z.discriminatedUnion("type", [RunnerWelcome, RefreshAllowance, SetRunnerStorage, StartWork, StartTask, SyncWork, MessageWork, StopWork, FetchFile, AttachmentPart]);
export type HubToRunner = z.infer<typeof HubToRunner>;

export const runnerCloseCodes = {
  replaced: 4000,
  revoked: 4003,
  protocol: 4002,
  closing: 1001,
} as const;

export const RunnerSetup = z.object({
  hub: z.url({ protocol: /^https?$/ }),
  name: MachineName,
  accessClientId: z.string().min(1),
  accessClientSecret: z.string().min(1).optional(),
  runnerToken: z.string().min(43).optional(),
});
export type RunnerSetup = z.infer<typeof RunnerSetup>;

export const runnerSetupPrefix = "superagent2-runner-setup:";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function encodeRunnerSetup(setup: RunnerSetup): string {
  return `${runnerSetupPrefix}${toBase64Url(JSON.stringify(RunnerSetup.parse(setup)))}`;
}

export function decodeRunnerSetup(text: string): RunnerSetup | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(runnerSetupPrefix)) {
    return undefined;
  }
  try {
    const parsed = RunnerSetup.safeParse(JSON.parse(fromBase64Url(trimmed.slice(runnerSetupPrefix.length))));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const MachineStatus = z.object({
  name: MachineName,
  online: z.boolean(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
  report: MachineReport.nullable(),
  system: MachineSystem.optional(),
  accessExpiresAt: z.number().int().optional(),
  storage: StorageSettings.optional(),
});
export type MachineStatus = z.infer<typeof MachineStatus>;

export const MachineList = z.object({
  machines: z.array(MachineStatus),
});
export type MachineList = z.infer<typeof MachineList>;
