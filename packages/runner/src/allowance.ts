import {
  type AllowanceProgram,
  type AllowanceReading,
  type AllowanceWindow,
  allowanceFrom,
  type ProgramReport,
  unknownAllowance,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Prober } from "./programs.js";

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

const CodexWindow = z.looseObject({ usedPercent: z.number(), resetsAt: z.number().nullable().optional() });

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

export function codexAllowance(output: string, readAt: number): AllowanceReading {
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
      windows.push({ name, usedPercent: window.usedPercent, resetsAt: window.resetsAt === null || window.resetsAt === undefined ? null : window.resetsAt * 1000 });
    }
  }
  const blocked = (limits.rateLimitReachedType ?? null) !== null || answer.result.ordinaryUsageAllowed === false;
  return allowanceFrom("codex", readAt, windows, blocked);
}

export function claudeAllowance(output: string, readAt: number): AllowanceReading {
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

interface AllowanceSource {
  readonly program: AllowanceProgram;
  readonly args: readonly string[];
  readonly input: string;
  readonly parse: (output: string, readAt: number) => AllowanceReading;
}

export const allowanceSources: readonly AllowanceSource[] = [
  { program: "codex", args: ["app-server"], input: `${codexAllowanceInput}\n`, parse: codexAllowance },
  {
    program: "claude",
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    input: `${claudeAllowanceInput}\n`,
    parse: claudeAllowance,
  },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readAllowances(prober: Prober, programs: readonly ProgramReport[], now: () => number): Promise<AllowanceReading[]> {
  return Promise.all(
    allowanceSources.map(async (source) => {
      const program = programs.find((entry) => entry.id === source.program);
      if (program === undefined || !program.installed || program.path === null) {
        return unknownAllowance(source.program, now(), "the program is not installed here");
      }
      try {
        const output = await prober.capture(program.path, source.args, {
          input: source.input,
          until: (line) => line.includes(allowanceRequestId) && !line.includes("superagent2-initialize"),
        });
        return source.parse(output, now());
      } catch (error) {
        return unknownAllowance(source.program, now(), messageOf(error));
      }
    }),
  );
}
