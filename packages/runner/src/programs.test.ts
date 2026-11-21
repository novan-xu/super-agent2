import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravityEfforts,
  antigravityModels,
  claudeInitializeRequest,
  claudeModels,
  codexModels,
  defaultDshModels,
  findExecutable,
  type Prober,
  probePrograms,
  programDefinitions,
  systemProber,
} from "./programs.js";

describe("reading what each program offers", () => {
  it("takes Codex's listed models and their reasoning levels from its catalog", () => {
    const catalog = {
      models: [
        { slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], extra: 1 },
        { slug: "codex-auto-review", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
        { slug: "gpt-6-luna", visibility: "list" },
      ],
    };
    expect(codexModels(`notice\n${JSON.stringify(catalog)}`)).toEqual([
      { id: "gpt-6.1-sol", efforts: ["low", "high"] },
      { id: "gpt-6-luna", efforts: [] },
    ]);
  });

  it("takes Claude Code's models from its answer to initialize, once per resolved model", () => {
    const answer = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: claudeInitializeRequest.request_id,
        response: {
          models: [
            { value: "default", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
            { value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportedEffortLevels: ["low"] },
            { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001" },
            { value: "sonnet", resolvedModel: "claude-sonnet-5-5", supportsEffort: false, supportedEffortLevels: ["low"] },
          ],
          account: { email: "someone@example.com" },
        },
      },
    };
    const output = [JSON.stringify({ type: "system" }), "not json control_response", JSON.stringify(answer)].join("\n");
    expect(claudeModels(output)).toEqual([
      { id: "claude-opus-5-5", efforts: ["low", "high", "max"] },
      { id: "claude-haiku-4-5-20251001", efforts: [] },
      { id: "claude-sonnet-5-5", efforts: [] },
    ]);
    expect(() => claudeModels("")).toThrow(/did not answer/);
  });

  it("groups Antigravity's models by their effort suffix and takes the other efforts from its help", () => {
    const help = [
      "Usage of agy.exe:",
      "  --dangerously-skip-permissions  Auto-approve",
      "  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)",
    ].join("\n");
    const efforts = antigravityEfforts(help);
    expect(efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const listing = [
      "Fetching available models...",
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\r\n");
    expect(antigravityModels(listing, efforts)).toEqual([
      { id: "gemini-3.8-flash", efforts: ["low", "medium", "high"] },
      { id: "claude-opus-4-6-thinking", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-oss-120b", efforts: ["medium"] },
    ]);
  });
});

describe("probing the programs", () => {
  function fakeProber(installed: Record<string, Record<string, string>>): Prober & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      find: (executable) => (installed[executable] === undefined ? undefined : `/bin/${executable}`),
      capture: async (path, args) => {
        calls.push(`${path} ${args.join(" ")}`);
        const executable = path.replace("/bin/", "");
        const answer = installed[executable]?.[args.join(" ")];
        if (answer === undefined) {
          throw new Error(`${executable} cannot ${args.join(" ")}`);
        }
        return answer;
      },
    };
  }

  it("reports what is installed, where each list came from, and what went wrong", async () => {
    const prober = fakeProber({
      codex: { "--version": "codex-cli 0.163.0\n", "debug models": JSON.stringify({ models: [{ slug: "gpt-6-luna", visibility: "list" }] }) },
      dsh: { "--version": "0.2.1-rc.2\n" },
      agy: { "--version": "1.5.3\n" },
    });
    const reports = await probePrograms(programDefinitions({}), prober);
    expect(reports).toEqual([
      { id: "codex", installed: true, path: "/bin/codex", version: "0.163.0", models: [{ id: "gpt-6-luna", efforts: [] }], source: "program", problem: null },
      { id: "claude", installed: false, path: null, version: null, models: [], source: "none", problem: null },
      { id: "dsh", installed: true, path: "/bin/dsh", version: "0.2.1-rc.2", models: [...defaultDshModels], source: "configuration", problem: null },
      { id: "antigravity", installed: true, path: "/bin/agy", version: "1.5.3", models: [], source: "none", problem: "models: agy cannot --help" },
    ]);
  });

  it("uses the configured list instead of asking the program", async () => {
    const prober = fakeProber({ claude: { "--version": "2.1.326 (Claude Code)\n" } });
    const [, claude] = await probePrograms(programDefinitions({ claude: [{ id: "claude-opus-5-5", efforts: ["high"] }] }), prober);
    expect(claude).toMatchObject({ version: "2.1.326", models: [{ id: "claude-opus-5-5", efforts: ["high"] }], source: "configuration" });
    expect(prober.calls).toEqual(["/bin/claude --version"]);
  });

  it("preserves an inline Antigravity session setting across the probe shell", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-probe-"));
    const settings = '{"disableSlashCommands":false}';
    try {
      const prober = systemProber({ environment: process.env, cwd });
      const output = await prober.capture(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "--", settings]);
      expect(output).toBe(settings);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports filtered failure output when requested", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-probe-"));
    try {
      const prober = systemProber({ environment: { ...process.env, TEST_DIAGNOSTIC: "token=secret" }, cwd });
      await expect(prober.capture(process.execPath, ["-e", "console.error('Sign in required'); process.exit(1)"], { failureOutput: true })).rejects.toThrow("exited with 1: Sign in required");
      await expect(prober.capture(process.execPath, ["-e", "console.error(process.env.TEST_DIAGNOSTIC); process.exit(1)"], { failureOutput: true })).rejects.not.toThrow("token=secret");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("finding a program on the path", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "runner-path-"));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("follows PATHEXT on Windows and the plain name elsewhere", () => {
    const first = join(folder, "first");
    const second = join(folder, "second");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(join(first, "codex.cmd"));
    writeFileSync(join(second, "codex.cmd"), "");
    writeFileSync(join(second, "codex"), "");
    expect(findExecutable("codex", { Path: `${first};${second}`, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(join(second, "codex.cmd"));
    expect(findExecutable("codex", { PATH: [first, second].join(process.platform === "win32" ? ";" : ":") }, "darwin")).toBe(join(second, "codex"));
    expect(findExecutable("dsh", { PATH: first }, "darwin")).toBeUndefined();
  });
});
