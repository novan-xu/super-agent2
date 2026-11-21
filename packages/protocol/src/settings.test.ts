import { describe, expect, it } from "vitest";
import { type MachineChoice, startingEngineTable } from "./defaults.js";
import { fullOrder, ProviderOrderChange, pushServiceOf, tableCells, unofferedChanges, withCell } from "./settings.js";

describe("provider orders", () => {
  it("completes older orders and preserves specified positions", () => {
    expect(fullOrder(["claude", "gpt"])).toEqual(["claude", "gpt", "deepseek"]);
    expect(fullOrder(["deepseek", "gpt", "gpt"])).toEqual(["deepseek", "gpt", "claude"]);
  });

  it("accepts a permutation of all three providers", () => {
    expect(ProviderOrderChange.safeParse({ order: ["deepseek", "claude", "gpt"] }).success).toBe(true);
    expect(ProviderOrderChange.safeParse({ order: ["gpt", "claude", "gpt"] }).success).toBe(false);
    expect(ProviderOrderChange.safeParse({ order: ["gpt"] }).success).toBe(false);
    expect(ProviderOrderChange.safeParse({ order: ["gpt", "deepseek"] }).success).toBe(false);
  });
});

describe("the model table", () => {
  const machine: MachineChoice = {
    name: "pc",
    platform: "win32",
    free: 2,
    engines: [{ engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high", "xhigh"] }] }],
  };

  it("changes one cell", () => {
    const next = withCell(startingEngineTable, { engine: "codex", difficulty: "complex", model: "gpt-6.1-sol", effort: "xhigh" });
    expect(next.codex.complex).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    expect(next.codex.standard).toEqual(startingEngineTable.codex.standard);
  });

  it("refuses only a changed cell no online machine offers", () => {
    const offered = withCell(startingEngineTable, { engine: "codex", difficulty: "complex", model: "gpt-6.1-sol", effort: "xhigh" });
    expect(unofferedChanges(offered, startingEngineTable, [machine])).toEqual([]);
    const unoffered = withCell(startingEngineTable, { engine: "codex", difficulty: "complex", model: "gpt-6.1-sol", effort: "low" });
    expect(unofferedChanges(unoffered, startingEngineTable, [machine])).toEqual([{ engine: "codex", difficulty: "complex", model: "gpt-6.1-sol", effort: "low" }]);
    expect(unofferedChanges(offered, startingEngineTable, [])).toHaveLength(1);
    expect(tableCells(startingEngineTable)).toHaveLength(11);
  });

  it("validates new Antigravity pairs and lets existing pairs be reordered while offline", () => {
    const reordered = { ...startingEngineTable, antigravity: [...startingEngineTable.antigravity].reverse() };
    expect(unofferedChanges(reordered, startingEngineTable, [])).toEqual([]);
    const added = { ...reordered, antigravity: [...reordered.antigravity, { model: "unknown", effort: "high" }] };
    expect(unofferedChanges(added, startingEngineTable, [machine])).toEqual([{ engine: "antigravity", difficulty: null, model: "unknown", effort: "high" }]);
  });
});

describe("pushServiceOf", () => {
  it("names the push service from the endpoint's host only", () => {
    expect(pushServiceOf("https://web.push.apple.com/abc")).toBe("apple");
    expect(pushServiceOf("https://fcm.googleapis.com/fcm/send/x")).toBe("google");
    expect(pushServiceOf("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe("mozilla");
    expect(pushServiceOf("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe("microsoft");
    expect(pushServiceOf("https://evil.example/push.apple.com")).toBe("other");
    expect(pushServiceOf("not a url")).toBe("other");
  });
});
