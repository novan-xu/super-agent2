import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AllowanceProgram,
  type AllowanceReading,
  type AllowanceWindow,
  type SubscriptionReading,
  allowanceFrom,
  type ProgramReport,
  unknownAllowance,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { CaptureOptions, Prober } from "./programs.js";

export const allowanceRequestId = "superagent2-allowance";

export const codexAllowanceInput = [
  { id: "superagent2-initialize", method: "initialize", params: { clientInfo: { name: "super-agent2-runner", title: "Super-agent2 runner", version: "0.0.0" }, capabilities: { experimentalApi: false } } },
  { method: "initialized" },
  { id: allowanceRequestId, method: "account/rateLimits/read" },
]
  .map((message) => JSON.stringify(message))
  .join("\n");

export const claudeAllowanceInput = [
  { type: "control_request", request_id: "superagent2-initialize", request: { subtype: "initialize" } },
  { type: "control_request", request_id: allowanceRequestId, request: { subtype: "get_usage" } },
]
  .map((message) => JSON.stringify(message))
  .join("\n");

const CodexWindow = z.looseObject({ usedPercent: z.number(), windowDurationMins: z.number().positive().nullable().optional(), resetsAt: z.number().nullable().optional() });

const CodexAnswer = z.looseObject({
  id: z.literal(allowanceRequestId),
  result: z.looseObject({
    ordinaryUsageAllowed: z.boolean().nullable().optional(),
    rateLimits: z.looseObject({
      primary: CodexWindow.nullable().optional(),
      secondary: CodexWindow.nullable().optional(),
      rateLimitReachedType: z.string().nullable().optional(),
    }),
  }),
});

const ClaudeWindow = z.looseObject({
  utilization: z.number().nullable().optional(),
  resets_at: z.string().nullable().optional(),
  locked_reason: z.string().nullable().optional(),
});

const ClaudeAnswer = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: z.literal("success"),
    request_id: z.literal(allowanceRequestId),
    response: z.looseObject({
      rate_limits_available: z.boolean().optional(),
      rate_limits: z
        .looseObject({
          five_hour: ClaudeWindow.nullable().optional(),
          seven_day: ClaudeWindow.nullable().optional(),
          limits: z
            .array(
              z.looseObject({
                kind: z.string(),
                percent: z.number(),
                resets_at: z.string().nullable().optional(),
                scope: z.unknown().optional(),
              }),
            )
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    }),
  }),
});

function answerLine<T>(output: string, schema: z.ZodType<T>): T | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(allowanceRequestId) || line.includes("superagent2-initialize")) {
      continue;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function isoTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function codexAllowance(output: string, readAt: number): SubscriptionReading {
  const answer = answerLine(output, CodexAnswer);
  if (answer === undefined) {
    return unknownAllowance("codex", readAt, "Codex did not answer account/rateLimits/read");
  }
  const limits = answer.result.rateLimits;
  const windows: AllowanceWindow[] = [];
  for (const [name, window] of [
    ["primary", limits.primary],
    ["secondary", limits.secondary],
  ] as const) {
    if (window !== null && window !== undefined) {
      windows.push({ name, usedPercent: window.usedPercent, ...(window.windowDurationMins == null ? {} : { durationMinutes: window.windowDurationMins }), resetsAt: window.resetsAt === null || window.resetsAt === undefined ? null : window.resetsAt * 1000 });
    }
  }
  const blocked = (limits.rateLimitReachedType ?? null) !== null || answer.result.ordinaryUsageAllowed === false;
  return allowanceFrom("codex", readAt, windows, blocked);
}

export function claudeAllowance(output: string, readAt: number): SubscriptionReading {
  const answer = answerLine(output, ClaudeAnswer);
  if (answer === undefined) {
    return unknownAllowance("claude", readAt, "Claude Code did not answer get_usage");
  }
  const usage = answer.response.response;
  const limits = usage.rate_limits;
  if (usage.rate_limits_available === false || limits === null || limits === undefined) {
    return unknownAllowance("claude", readAt, "Claude Code reports no rate limits for this login");
  }
  const general = (limits.limits ?? []).filter((limit) => limit.scope === null || limit.scope === undefined);
  const windows: AllowanceWindow[] =
    general.length > 0
      ? general.map((limit) => ({ name: limit.kind, usedPercent: limit.percent, resetsAt: isoTime(limit.resets_at) }))
      : (
          [
            ["five_hour", limits.five_hour],
            ["seven_day", limits.seven_day],
          ] as const
        ).flatMap(([name, window]) =>
          window === null || window === undefined || window.utilization === null || window.utilization === undefined
            ? []
            : [{ name, usedPercent: window.utilization, resetsAt: isoTime(window.resets_at) }],
        );
  const blocked = [limits.five_hour, limits.seven_day].some((window) => window !== null && window !== undefined && (window.locked_reason ?? null) !== null);
  return allowanceFrom("claude", readAt, windows, blocked);
}

const AntigravityUsage = z.object({
  status: z.literal("SUCCESS"),
  command: z.object({ name: z.literal("usage"), data: z.object({ groups: z.array(z.unknown()) }) }),
});

const AntigravityGeminiGroup = z.object({ name: z.literal("Gemini Models"), buckets: z.array(z.unknown()) });
const AntigravityBucket = z.object({
  window: z.enum(["weekly", "5h"]),
  remaining_fraction: z.number().min(0).max(1),
  reset_time: z.string().nullish().catch(null),
});

function supportsAntigravityUsage(version: string | null): boolean {
  const parts = /\bv?(\d+)\.(\d+)\.(\d+)\b/.exec(version ?? "");
  if (parts === null) return false;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  const patch = Number(parts[3]);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}

function antigravityAllowance(output: string, readAt: number): SubscriptionReading {
  const unknown = unknownAllowance("antigravity", readAt, "Antigravity did not report Gemini Models quota");
  try {
    const parsed = AntigravityUsage.safeParse(JSON.parse(output));
    if (!parsed.success) return unknown;
    const windows = new Map<string, AllowanceWindow>();
    for (const raw of parsed.data.command.data.groups) {
      const group = AntigravityGeminiGroup.safeParse(raw);
      if (!group.success) continue;
      for (const entry of group.data.buckets) {
        const bucket = AntigravityBucket.safeParse(entry);
        if (!bucket.success) continue;
        const { window, remaining_fraction, reset_time } = bucket.data;
        const resetsAt = isoTime(reset_time);
        windows.set(window, {
          name: window === "weekly" ? "seven_day" : "five_hour",
          usedPercent: 100 - remaining_fraction * 100,
          durationMinutes: window === "weekly" ? 10080 : 300,
          resetsAt: resetsAt !== null && resetsAt > 0 ? resetsAt : null,
        });
      }
      break;
    }
    return windows.size === 0 ? unknown : allowanceFrom("antigravity", readAt, [...windows.values()], false);
  } catch {
    return unknown;
  }
}

interface AllowanceSource {
  readonly program: AllowanceProgram;
  readonly args: readonly string[];
  readonly options: CaptureOptions;
  readonly parse: (output: string, readAt: number) => AllowanceReading;
}

function allowanceStream(input: string): CaptureOptions {
  return { input: `${input}\n`, until: (line) => line.includes(allowanceRequestId) && !line.includes("superagent2-initialize") };
}

export const allowanceSources: readonly AllowanceSource[] = [
  { program: "codex", args: ["app-server"], options: allowanceStream(codexAllowanceInput), parse: codexAllowance },
  {
    program: "claude",
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    options: allowanceStream(claudeAllowanceInput),
    parse: claudeAllowance,
  },
  {
    program: "antigravity",
    args: ["--settings", '{"disableSlashCommands":false}', "--print", "/usage", "--output-format", "json", "--print-timeout", "10s"],
    options: { limitMilliseconds: 12_000 },
    parse: antigravityAllowance,
  },
];

const DshAnswer = z.object({ id: z.literal("superagent2-balance"), result: z.object({ status: z.literal("ready"), value: z.array(z.object({ currency: z.string().min(1), balance: z.string() })), bonusWallets: z.array(z.object({ currency: z.string().min(1), balance: z.string() })) }) });

export function dshBalance(output: string, readAt: number): AllowanceReading {
  const unknown = { program: "dsh" as const, readAt, available: null, wallets: [], problem: "dsh could not read the account balance" };
  try {
    const line = output.split(/\r?\n/).find((item) => item.includes('"superagent2-balance"'));
    const parsed = DshAnswer.safeParse(JSON.parse(line ?? "null"));
    if (!parsed.success) return unknown;
    const wallets = new Map<string, { currency: string; total: number; granted: number; toppedUp: number }>();
    for (const [kind, entries] of [["toppedUp", parsed.data.result.value], ["granted", parsed.data.result.bonusWallets]] as const) {
      for (const entry of entries) {
        const amount = Number(entry.balance);
        if (entry.balance.trim() === "" || !Number.isFinite(amount)) return unknown;
        const wallet = wallets.get(entry.currency) ?? { currency: entry.currency, total: 0, granted: 0, toppedUp: 0 };
        wallet[kind] += amount; wallet.total += amount; wallets.set(entry.currency, wallet);
      }
    }
    if (wallets.size === 0) return unknown;
    return { program: "dsh", readAt, available: true, wallets: [...wallets.values()], problem: null };
  } catch { return unknown; }
}

async function readDsh(prober: Prober, programs: readonly ProgramReport[], now: () => number): Promise<AllowanceReading> {
  const program = programs.find((entry) => entry.id === "dsh");
  if (!program?.installed || program.path === null) return { program: "dsh", readAt: now(), available: null, wallets: [], problem: "the program is not installed here" };
  const plugin = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./dsh-balance.ts" : "./dsh-balance.js", import.meta.url));
  const patch = join(tmpdir(), `super-agent2-balance-${randomUUID()}.yml`);
  try {
    writeFileSync(patch, `- insert:\n    - id: super-agent2-balance\n      name: ${JSON.stringify(plugin.replaceAll("\\", "/"))}\n`);
    const output = await prober.capture(program.path, ["--profile", "sdk", "--patch", patch], { input: "", until: (line) => line.includes('"superagent2-balance"') });
    return dshBalance(output, now());
  } catch { return { program: "dsh", readAt: now(), available: null, wallets: [], problem: "dsh could not read the account balance" }; }
  finally { rmSync(patch, { force: true }); }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readAllowances(prober: Prober, programs: readonly ProgramReport[], now: () => number): Promise<AllowanceReading[]> {
  return Promise.all([
    ...allowanceSources.map(async (source) => {
      const program = programs.find((entry) => entry.id === source.program);
      if (program === undefined || !program.installed || program.path === null) {
        return unknownAllowance(source.program, now(), "the program is not installed here");
      }
      if (source.program === "antigravity" && !supportsAntigravityUsage(program.version)) {
        return unknownAllowance(source.program, now(), "the CLI version has no verified read-only /usage command");
      }
      try {
        const output = await prober.capture(program.path, source.args, source.options);
        return source.parse(output, now());
      } catch (error) {
        return unknownAllowance(source.program, now(), messageOf(error));
      }
    }),
    ...(programs.some((entry) => entry.id === "dsh" && entry.installed && entry.path !== null) ? [readDsh(prober, programs, now)] : []),
  ]);
}
