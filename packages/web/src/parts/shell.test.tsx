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
    waiting: 0,
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

  it("keeps the destination a ticket was opened from marked while the ticket is shown", () => {
    const marked = (overrides: Partial<ShellProps>) =>
      [...render({ route: { view: "ticket", ticket: 4 }, ...overrides }).matchAll(destinations)].filter((match) => match[2] !== undefined).map((match) => match[1]);
    expect(marked({})).toEqual(["工作台", "工作台"]);
    expect(marked({ ticketFrom: "history" })).toEqual(["历史", "历史"]);
    expect(render({ route: { view: "ticket", ticket: 4 }, ticketFrom: "history" })).toContain("<h1>历史</h1>");
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

  it("shows how many things wait on 工作台, in the sidebar and in the tab bar, and nowhere else", () => {
    const html = render({ waiting: 3 });
    expect(html).toContain('<span class="count count--hot">3</span>');
    expect(html).toContain('<span class="tab-badge">3</span>');
    expect(html.match(/count count--hot/g)).toHaveLength(1);
    expect(html).toContain('aria-label="工作台 3"');
  });

  it("shows how many suggestions wait on 记忆, beside the count of 工作台", () => {
    const html = render({ waiting: 2, suggestions: 4 });
    expect(html).toContain('<span class="count count--hot">4</span>');
    expect(html).toContain('<span class="tab-badge">4</span>');
    expect(html).toContain('aria-label="记忆 4"');
    expect(html).toContain('aria-label="工作台 2"');
    expect(html.match(/count count--hot/g)).toHaveLength(2);
  });

  it("keeps History free of badges in both navigation areas", () => {
    const html = render({ waiting: 2, suggestions: 4 });
    const historyLinks = [...html.matchAll(/<a class="(?:nav-btn|tab)" href="\/history" aria-label="([^"]+)"[^>]*>(.*?)<\/a>/g)];
    expect(historyLinks).toHaveLength(2);
    for (const link of historyLinks) {
      expect(link[1]).toBe("历史");
      expect(link[2]).not.toMatch(/count--hot|tab-badge/);
    }
    expect(html.match(/count count--hot/g)).toHaveLength(2);
    expect(html.match(/tab-badge/g)).toHaveLength(2);
  });

  it("shows no count when nothing waits", () => {
    const html = render({ waiting: 0 });
    expect(html).not.toContain("count--hot");
    expect(html).not.toContain("tab-badge");
  });
});
