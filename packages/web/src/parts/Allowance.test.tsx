import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AllowanceCompact, AllowanceSidebar } from "./Allowance.js";

describe("allowance components", () => {
  it("renders an unknown compact line and the expandable full panel", () => {
    const props = { report: null, now: 0, refresh: () => undefined };
    const compact = renderToStaticMarkup(<AllowanceCompact {...props} />);
    expect(compact).toContain("GPT 未知");
    expect(compact).toContain("Claude 未知");
    expect(compact).toContain("DS 未知");
    expect(compact).toContain("<dialog");
    expect(compact).toContain("刷新额度");
    const sidebar = renderToStaticMarkup(<AllowanceSidebar {...props} />);
    expect(sidebar).toContain("本周");
    expect(sidebar).toContain("5 小时");
    expect(sidebar).toContain("7 天");
    expect(sidebar).not.toContain("Antigravity");
  });
});
