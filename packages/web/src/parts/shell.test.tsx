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
  it("offers the main destinations in the sidebar and in the tab bar, in the design's order", () => {
    const html = render();
    const labels = [...html.matchAll(destinations)].map((match) => match[1]);
    expect(labels).toEqual(["工作台", "对话", "待办", "定时", "设置", "工作台", "对话", "待办", "定时", "设置"]);
    expect(html).toContain('href="/schedules"');
    expect(html).toContain('href="/conversations/c1"');
    expect(html).toContain('href="/workbench"');
  });

  it("makes the logo the sidebar toggle", () => {
    expect(render()).toMatch(/<button class="side-toggle brand-toggle"[^>]*aria-expanded="true"[^>]*><svg class="logo" width="48" height="48"/);
  });

  it("renders the brand colours with an accent dot", () => {
    const html = render();
    expect(html).toContain('rx="6" fill="#ffffff" stroke="#dddddd"');
    expect(html).toContain('r="3.3" fill="#1a1917"');
    expect(html).toContain('stroke="#1a1917" stroke-width="2"');
    expect(html).toContain('r="2.1" fill="var(--accent)"');
  });

  it("marks the current destination", () => {
    const current = [...render({ route: { view: "settings", section: "memory" } }).matchAll(destinations)].filter((match) => match[2] !== undefined).map((match) => match[1]);
    expect(current).toEqual(["设置", "设置"]);
  });

  it("keeps the destination a ticket was opened from marked while the ticket is shown", () => {
    const marked = (overrides: Partial<ShellProps>) =>
      [...render({ route: { view: "ticket", ticket: 4 }, ...overrides }).matchAll(destinations)].filter((match) => match[2] !== undefined).map((match) => match[1]);
    expect(marked({})).toEqual(["工作台", "工作台"]);
    expect(marked({ ticketFrom: "history" })).toEqual(["设置", "设置"]);
    expect(render({ route: { view: "ticket", ticket: 4 }, ticketFrom: "history" })).toContain("<h1>设置</h1>");
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

  it("shows the pending Settings count in both navigation areas alongside the workbench count", () => {
    const html = render({ waiting: 2, settingsCount: 4 });
    expect(html).toContain('<span class="count count--hot">4</span>');
    expect(html).toContain('<span class="tab-badge">4</span>');
    expect([...html.matchAll(destinations)].filter((match) => match[1] === "设置 4")).toHaveLength(2);
    expect(html).toContain('aria-label="工作台 2"');
    expect(html.match(/count count--hot/g)).toHaveLength(2);
  });

  it("shows the pending proposal count on 定时 in both navigation areas", () => {
    const html = render({ pendingSchedules: 2 });
    expect([...html.matchAll(destinations)].filter((match) => match[1] === "定时 2")).toHaveLength(2);
    expect(html).toContain('<span class="count count--hot">2</span>');
    expect(html).toContain('<span class="tab-badge">2</span>');
  });

  it("does not offer History in either navigation area", () => {
    expect(render()).not.toContain('href="/history"');
  });

  it("shows no count when nothing waits", () => {
    const html = render({ waiting: 0, settingsCount: 0 });
    expect(html).not.toContain("count--hot");
    expect(html).not.toContain("tab-badge");
  });
});
