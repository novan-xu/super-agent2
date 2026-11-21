import { describe, expect, it } from "vitest";
import { choiceText } from "./reports.js";

describe("start choice report", () => {
  it("names the unavailable engine, model and effort when no machine fits", () => {
    expect(choiceText({
      machine: null,
      engine: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      by: { machine: "default", engine: "default", model: "default", effort: "default" },
      missing: ["model"],
    })).toContain("No online machine matching the platform offers codex, gpt-6.1-sol at high.");
  });
});
