import { pagePath } from "@super-agent2/protocol";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Shell, type ShellProps } from "./Shell.js";

const destinations = /<a class="(?:nav-btn|tab)" href="[^"]*" aria-label="([^"]+)"( aria-current="page")?/g;

function render(overrides: Partial<ShellProps> = {}): string {
  const props: ShellProps = {
    route: { view: "conversations", conversation: "c1" },
    navigate: () => undefined,
    destinationOf: (view) => (view === "conversations" ? { view, conversation: "c1" } : { view }),
    hrefOf: (view) => pagePath(view === "conversations" ? { view, conversation: "c1" } : { view }),
    status: "open",
    linked: true,
    model: "claude-opus-5-5",
    fill: true,
    toast: null,
    ...overrides,
  };
  return renderToString(<Shell {...props} />);
}

describe("Shell", () => {
  it("offers the five destinations in the sidebar and in the tab bar, in the design's order", () => {
    const html = render();
    const labels = [...html.matchAll(destinations)].map((match) => match[1]);
    expect(labels).toEqual(["工作台", "对话", "历史", "记忆", "设置", "工作台", "对话", "历史", "记忆", "设置"]);
    expect(html).toContain('href="/conversations/c1"');
    expect(html).toContain('href="/workbench"');
  });

  it("marks the current destination", () => {
    const current = [...render({ route: { view: "memory" } }).matchAll(destinations)].filter((match) => match[2] !== undefined).map((match) => match[1]);
    expect(current).toEqual(["记忆", "记忆"]);
  });

  it("shows whether the hub and the brain are reachable", () => {
    expect(render()).toContain("在线");
    expect(render()).toContain("claude-opus-5-5");
    expect(render({ status: "closed" })).toContain("正在重新连接");
    expect(render({ linked: false })).toContain("未连接");
  });

  it("announces a failure", () => {
    expect(render({ toast: "没连上 hub，请再试一次" })).toContain('role="status"');
  });
});
