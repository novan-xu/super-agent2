import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AllowanceCompact, AllowanceSidebar } from "./Allowance.js";

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
