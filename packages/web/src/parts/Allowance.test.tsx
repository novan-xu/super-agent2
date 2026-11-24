import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AllowanceCompact, AllowanceRings, AllowanceSidebar } from "./Allowance.js";

describe("allowance components", () => {
  it("renders an unknown compact line and the expandable full panel", () => {
    const props = { report: null, now: 0, refresh: () => undefined };
    const compact = renderToStaticMarkup(<AllowanceCompact {...props} />);
    expect(compact).toContain("GPT 未知");
    expect(compact).toContain("Claude 未知");
    expect(compact).toContain("Gemini 未知");
    expect(compact).toContain("DS 未知");
    expect(compact).toContain("<dialog");
    expect(compact).toContain("刷新额度");
    const sidebar = renderToStaticMarkup(<AllowanceSidebar {...props} />);
    expect(sidebar).not.toContain("allowance-heading");
    expect(sidebar).not.toContain("刷新额度");
    expect(sidebar).toContain("本周");
    expect(sidebar).toContain("5 小时");
    expect(sidebar).not.toContain("7 天");
    expect(sidebar).toContain("Antigravity");
  });
  it("renders used percentages and bars without read details", () => {
    const report = {
      subscriptions: [
        { program: "codex" as const, state: "available" as const, remainingPercent: 77, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "secondary", usedPercent: 23, durationMinutes: 10080, resetsAt: null }] },
        { program: "claude" as const, state: "available" as const, remainingPercent: 10, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "session", usedPercent: 75, resetsAt: null }, { name: "weekly_all", usedPercent: 90, resetsAt: null }] },
        {
          program: "antigravity" as const, state: "available" as const, remainingPercent: 18, resetsAt: null, readAt: 10, machine: "mini",
          windows: [
            { name: "five_hour", usedPercent: 82, durationMinutes: 300, resetsAt: null },
            { name: "seven_day", usedPercent: 54, durationMinutes: 10080, resetsAt: 10_000 },
            { name: "Gemini 4 Argon", usedPercent: 99, durationMinutes: 10080, resetsAt: null },
          ],
        },
      ],
      balance: { program: "dsh" as const, available: true, readAt: 10, machine: "mini", problem: null, state: "ok" as const, wallets: [{ currency: "CNY", total: 371.76, granted: 0, toppedUp: 371.76 }] },
      unavailable: [],
    };
    const props = { report, now: 100, refresh: () => undefined };
    const sidebar = renderToStaticMarkup(<AllowanceSidebar {...props} />);
    expect([...sidebar.matchAll(/class="allowance-name"><strong>([^<]+)/g)].map((match) => match[1])).toEqual(["GPT", "Claude", "Antigravity", "DeepSeek"]);
    expect(sidebar.match(/本周/g)).toHaveLength(3);
    const gemini = sidebar.slice(sidebar.indexOf("<strong>Antigravity"), sidebar.indexOf("<strong>DeepSeek"));
    expect(gemini.match(/class="allowance-window"/g)).toHaveLength(2);
    expect(gemini.match(/class="allowance-reset"/g)).toHaveLength(1);
    expect(gemini).toContain("已用 82%");
    expect(gemini).toContain("已用 54%");
    expect(gemini).not.toContain("Gemini 4 Argon");
    expect(gemini).not.toContain("已用 99%");
    expect(sidebar).toContain("已用 23%");
    expect(sidebar).toContain('width:23%');
    expect(sidebar).toContain('allowance-fill--warn" style="width:75%');
    expect(sidebar).toContain('allowance-fill--bad" style="width:90%');
    expect(sidebar).toContain("¥371.76");
    expect(sidebar).not.toContain("mini");
    expect(sidebar).not.toContain("读取");
    const compact = renderToStaticMarkup(<AllowanceCompact {...props} />);
    expect(compact).toMatch(/GPT 23%.*Claude 90%.*Gemini 82%.*DS ¥371\.76/);
  });

});

it("shows API costs under GPT, with budget thresholds and without a budget", () => {
  const base = { subscriptions: [], unavailable: [] };
  const render = (cost: { state: "available" | "unknown"; amount: number | null; currency: string | null; readAt: number | null; budget: number | null }) => renderToStaticMarkup(<AllowanceSidebar report={{ ...base, openaiCost: cost }} now={0} />);
  expect(renderToStaticMarkup(<AllowanceSidebar report={base} now={0} />)).not.toContain("API 本月");
  expect(render({ state: "available", amount: 12.34, currency: "USD", readAt: 1, budget: null })).toContain("API 本月 $12.34");
  expect(render({ state: "available", amount: 75, currency: "USD", readAt: 1, budget: 100 })).toContain("allowance-text--warn");
  const bad = render({ state: "available", amount: 90, currency: "USD", readAt: 1, budget: 100 });
  expect(bad).toContain("allowance-text--bad");
  expect(bad).toContain("剩余 $10.00 · 已用 90%");
  expect(render({ state: "unknown", amount: 90, currency: "USD", readAt: 1, budget: 100 })).toContain("API 本月 未知");
});

it("renders the most-used window as a ring with accessible window and API details", () => {
  const report = {
    subscriptions: [
      { program: "codex" as const, state: "available" as const, remainingPercent: 25, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "secondary", usedPercent: 75, durationMinutes: 10080, resetsAt: 10000 }] },
      { program: "claude" as const, state: "available" as const, remainingPercent: 10, resetsAt: null, readAt: 10, machine: "mini", windows: [{ name: "session", usedPercent: 40, resetsAt: null }, { name: "weekly_all", usedPercent: 90, resetsAt: 20000 }] },
    ],
    unavailable: [],
    openaiCost: { state: "available" as const, amount: 1, currency: "USD", readAt: 1, budget: 100 },
  };
  const rings = renderToStaticMarkup(<AllowanceRings report={report} now={0} />);
  expect(rings).toContain('allowance-ring--warn');
  expect(rings).toContain('stroke-dasharray="75 100"');
  expect(rings).toContain('allowance-ring--bad');
  expect(rings).toContain('stroke-dasharray="90 100"');
  expect(rings).toContain('allowance-ring--unknown');
  expect(rings).toContain('aria-describedby="allowance-ring-claude"');
  expect(rings).toContain('id="allowance-ring-claude"');
  expect(rings).toContain('40%');
  expect(rings).toContain('API 本月 $1.00');
  expect(rings).toContain('class="allowance-reset"');
});
