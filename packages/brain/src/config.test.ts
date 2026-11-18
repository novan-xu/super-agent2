import { describe, expect, it } from "vitest";
import { loadBrainConfig } from "./config.js";

const valid = { BRAIN_HUB_URL: "http://hub:8080", BRAIN_TOKEN_FILE: "/run/secrets/brain.token", BRAIN_WORKSPACE: "/workspace" };

describe("loadBrainConfig", () => {
  it("starts with Claude, then GPT, then DeepSeek, on the design's starting models", () => {
    const result = loadBrainConfig(valid);
    expect(result).toEqual({
      ok: true,
      config: {
        hubUrl: "http://hub:8080",
        tokenFile: "/run/secrets/brain.token",
        workspace: "/workspace",
        attachments: "/var/lib/superagent2/link/attachments",
        order: ["claude", "gpt", "deepseek"],
        maximumOpen: 4,
        providers: {
          gpt: { program: "codex", model: "gpt-6-astra", effort: "high" },
          claude: { program: "claude", model: "claude-opus-5-5", effort: "high" },
          deepseek: { program: "dsh", model: "deepseek-flash", effort: "high" },
        },
      },
    });
  });

  it("takes the order of GPT and Claude from the configuration and keeps DeepSeek last", () => {
    const result = loadBrainConfig({ ...valid, BRAIN_PROVIDERS: "gpt, claude" });
    expect(result.ok && result.config.order).toEqual(["gpt", "claude", "deepseek"]);
  });

  it("refuses DeepSeek in the order, an unknown provider and a missing hub address, naming each", () => {
    const deepseek = loadBrainConfig({ ...valid, BRAIN_PROVIDERS: "deepseek" });
    expect(deepseek.ok).toBe(false);
    const missing = loadBrainConfig({ BRAIN_TOKEN_FILE: "x", BRAIN_WORKSPACE: "y" });
    expect(missing.ok ? [] : missing.problems.map((problem) => problem.split(" ")[0])).toEqual(["BRAIN_HUB_URL"]);
    const ftp = loadBrainConfig({ ...valid, BRAIN_HUB_URL: "ftp://hub" });
    expect(ftp.ok).toBe(false);
  });
});
