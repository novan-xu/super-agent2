import type { ProgramReport } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { allowanceRequestId, claudeAllowance, claudeAllowanceInput, codexAllowance, codexAllowanceInput, readAllowances } from "./allowance.js";
import type { CaptureOptions, Prober } from "./programs.js";

const now = 1_800_000_000_000;

function codexAnswer(primary: number, reached: string | null, allowed: boolean | null = true): string {
  return [
    JSON.stringify({ id: "superagent2-initialize", result: { userAgent: "x" } }),
    JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt" } }),
    JSON.stringify({
      id: allowanceRequestId,
      result: {
        ordinaryUsageAllowed: allowed,
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: primary, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
          secondary: null,
          rateLimitReachedType: reached,
        },
      },
    }),
  ].join("\n");
}

function claudeAnswer(rateLimits: unknown, available = true): string {
  return [
    JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "superagent2-initialize", response: { models: [] } } }),
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: allowanceRequestId, response: { subscription_type: "max", rate_limits_available: available, rate_limits: rateLimits } },
    }),
  ].join("\n");
}

describe("reading Codex's allowance", () => {
  it("asks the app server for its rate limits after initializing", () => {
    const lines = codexAllowanceInput.split("\n").map((line) => JSON.parse(line) as { method: string });
    expect(lines.map((line) => line.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });

  it("takes what is left from the used share of its windows", () => {
    expect(codexAllowance(codexAnswer(12, null), now)).toEqual({
      program: "codex",
      readAt: now,
      state: "available",
      remainingPercent: 88,
      resetsAt: 1_800_500_000_000,
      windows: [{ name: "primary", usedPercent: 12, durationMinutes: 10080, resetsAt: 1_800_500_000_000 }],
      problem: null,
    });
  });

  it("is used up when a limit is reached or ordinary usage is not allowed", () => {
    expect(codexAllowance(codexAnswer(100, "rate_limit_reached"), now).state).toBe("exhausted");
    expect(codexAllowance(codexAnswer(50, null, false), now).state).toBe("exhausted");
  });

  it("is unknown without an answer", () => {
    expect(codexAllowance("{}", now)).toMatchObject({ state: "unknown", remainingPercent: null });
  });
});

describe("reading Claude Code's allowance", () => {
  it("asks for its usage after initializing", () => {
    const lines = claudeAllowanceInput.split("\n").map((line) => JSON.parse(line) as { request: { subtype: string } });
    expect(lines.map((line) => line.request.subtype)).toEqual(["initialize", "get_usage"]);
  });

  it("takes its general limits and leaves out those of one model", () => {
    const reading = claudeAllowance(
      claudeAnswer({
        five_hour: { utilization: 21, resets_at: "2027-01-15T08:00:00+00:00", locked_reason: null },
        seven_day: { utilization: 4, resets_at: "2027-01-20T08:00:00+00:00", locked_reason: null },
        limits: [
          { kind: "session", percent: 21, resets_at: "2027-01-15T08:00:00+00:00", scope: null },
          { kind: "weekly_all", percent: 4, resets_at: "2027-01-20T08:00:00+00:00", scope: null },
          { kind: "weekly_scoped", percent: 100, resets_at: "2027-01-20T08:00:00+00:00", scope: { model: { display_name: "One" } } },
        ],
      }),
      now,
    );
    expect(reading).toMatchObject({ state: "available", remainingPercent: 79, resetsAt: Date.parse("2027-01-15T08:00:00+00:00") });
    expect(reading.windows.map((window) => window.name)).toEqual(["session", "weekly_all"]);
  });

  it("falls back to the five-hour and seven-day windows, and is used up when one is locked or full", () => {
    expect(claudeAllowance(claudeAnswer({ five_hour: { utilization: 100, resets_at: null }, seven_day: { utilization: 10, resets_at: null } }), now).state).toBe("exhausted");
    expect(claudeAllowance(claudeAnswer({ five_hour: { utilization: 10, resets_at: null, locked_reason: "limit" }, seven_day: null }), now).state).toBe("exhausted");
    expect(claudeAllowance(claudeAnswer({ five_hour: { utilization: 10, resets_at: null }, seven_day: null }), now)).toMatchObject({ state: "available", remainingPercent: 90 });
  });

  it("is unknown when the login has no rate limits", () => {
    expect(claudeAllowance(claudeAnswer(null, false), now).state).toBe("unknown");
  });

  it("reports the captured Claude Code 2.1.327 response without rate limits as unknown", () => {
    const output = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: allowanceRequestId,
        response: {
          session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 931, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
          behaviors: null,
        },
      },
    });
    expect(claudeAllowance(output, now)).toMatchObject({ state: "unknown", remainingPercent: null, windows: [], problem: "Claude Code reports no rate limits for this login" });
  });
});

describe("reading every allowance", () => {
  const programs: ProgramReport[] = [
    { id: "codex", installed: true, path: "/bin/codex", version: "1", models: [], source: "program", problem: null },
    { id: "claude", installed: false, path: null, version: null, models: [], source: "none", problem: null },
  ];

  it("asks each installed program, and reports one that is missing as unknown", async () => {
    const asked: { path: string; args: readonly string[]; options: CaptureOptions | undefined }[] = [];
    const prober: Prober = {
      find: () => undefined,
      capture: (path, args, options) => {
        asked.push({ path, args, options });
        return Promise.resolve(codexAnswer(40, null));
      },
    };
    const readings = await readAllowances(prober, programs, () => now);
    expect(asked.map((entry) => [entry.path, entry.args])).toEqual([["/bin/codex", ["app-server"]]]);
    expect(asked[0]?.options?.until?.(JSON.stringify({ id: allowanceRequestId, result: {} }))).toBe(true);
    expect(asked[0]?.options?.until?.(JSON.stringify({ id: "superagent2-initialize", result: {} }))).toBe(false);
    expect(readings.filter((reading) => reading.program !== "dsh").map((reading) => [reading.program, reading.state, reading.remainingPercent])).toEqual([
      ["codex", "available", 60],
      ["claude", "unknown", null],
      ["antigravity", "unknown", null],
    ]);
  });

  it("reports a program that fails as unknown with the reason", async () => {
    const prober: Prober = { find: () => undefined, capture: () => Promise.reject(new Error("codex exited with 1 before answering")) };
    const [codex] = await readAllowances(prober, programs, () => now);
    expect(codex).toMatchObject({ state: "unknown", problem: "codex exited with 1 before answering" });
  });
});

describe("reading Antigravity's Gemini Models quota", () => {
  const program: ProgramReport = { id: "antigravity", installed: true, path: "/bin/agy", version: "1.5.13", models: [], source: "program", problem: null };
  const reset = "2027-01-16T08:00:00Z";
  const group = {
    name: "Gemini Models",
    buckets: [
      { window: "weekly", remaining_fraction: 0.85, reset_time: reset },
      { window: "5h", remaining_fraction: 0.75, reset_time: "1970-01-01T00:00:00Z" },
      { window: "monthly", remaining_fraction: 0.01 },
    ],
  };
  const claude = { name: "Claude and GPT models", buckets: [{ window: "weekly", remaining_fraction: 0 }] };
  const argon = { name: "Gemini 4 Argon", buckets: [{ window: "5h", remaining_fraction: 0.01 }] };
  const outputOf = (groups: unknown[]) => JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups } }, num_turns: 0 });

  it("runs the bounded read-only command and reports only the Gemini Models weekly and 5h windows", async () => {
    const prober: Prober = {
      find: () => "/bin/agy",
      capture: async (path, args, options) => {
        expect(path).toBe("/bin/agy");
        expect(args).toEqual(["--settings", '{"disableSlashCommands":false}', "--print", "/usage", "--output-format", "json", "--print-timeout", "10s"]);
        expect(options).toEqual({ limitMilliseconds: 12_000, failureOutput: true });
        return outputOf([claude, group, argon]);
      },
    };
    const readings = await readAllowances(prober, [program], () => now);
    expect(readings.find((reading) => reading.program === "antigravity")).toEqual({
      program: "antigravity", readAt: now, state: "available", remainingPercent: 75, resetsAt: null, problem: null,
      windows: [
        { name: "seven_day", usedPercent: 15, durationMinutes: 10080, resetsAt: Date.parse(reset) },
        { name: "five_hour", usedPercent: 25, durationMinutes: 300, resetsAt: null },
      ],
    });
  });

  it.each([
    outputOf([claude, argon]),
    outputOf([{ name: group.name, buckets: [{ window: "weekly", remaining_fraction: -1 }] }]),
    JSON.stringify({ status: "SUCCESS", response: "Gemini Models weekly 100% left" }),
    "not JSON",
  ])("reports unknown for output without valid Gemini Models quota", async (output) => {
    const readings = await readAllowances({ find: () => undefined, capture: async () => output }, [program], () => now);
    expect(readings.find((reading) => reading.program === "antigravity")).toMatchObject({ state: "unknown", windows: [] });
  });

  it.each(["1.1.10", null])("skips the prompt on a CLI without a confirmed read-only command", async (version) => {
    let calls = 0;
    const readings = await readAllowances({ find: () => undefined, capture: async () => { calls++; return ""; } }, [{ ...program, version }], () => now);
    expect(calls).toBe(0);
    expect(readings.find((reading) => reading.program === "antigravity")).toMatchObject({ state: "unknown", windows: [] });
  });
});

describe("reading dsh balance", () => {
  it("keeps dsh stdin open while awaiting the account service", async () => {
    const dsh: ProgramReport = { id: "dsh", installed: true, path: "/bin/dsh", version: "1", models: [], source: "configuration", problem: null };
    let captured: CaptureOptions | undefined;
    const prober: Prober = { find: () => undefined, capture: (_path, _args, options) => {
      captured = options;
      return Promise.resolve(JSON.stringify({ id: "superagent2-balance", result: { status: "ready", value: [{ currency: "CNY", balance: "42" }], bonusWallets: [] } }));
    } };
    const readings = await readAllowances(prober, [dsh], () => now);
    expect(captured?.input).toBe("");
    expect(readings.find((reading) => reading.program === "dsh")).toMatchObject({ available: true, wallets: [{ total: 42 }] });
  });
  it("combines normal and bonus wallets and rejects failed or malformed results", async () => {
    const { dshBalance } = await import("./allowance.js");
    const output = JSON.stringify({ id: "superagent2-balance", result: { status: "ready", value: [{ currency: "CNY", balance: "20.50" }], bonusWallets: [{ currency: "CNY", balance: "9.25" }] } });
    expect(dshBalance(output, now)).toMatchObject({ available: true, wallets: [{ currency: "CNY", total: 29.75, granted: 9.25, toppedUp: 20.5 }] });
    expect(dshBalance('{"id":"superagent2-balance","result":null}', now)).toMatchObject({ available: null, problem: expect.any(String) });
    expect(dshBalance(output.replace("20.50", "invalid"), now)).toMatchObject({ available: null });
  });
});
