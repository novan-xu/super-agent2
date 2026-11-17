import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { holdCard, ticket } from "../live/fixtures.js";
import { initialTickets, receiveTickets, type TicketsState } from "../live/tickets.js";
import { type WaitingState, waitingReducer, initialWaiting } from "../live/waiting.js";
import type { PushPhase } from "../live/push.js";
import { type CardActions, WorkbenchView } from "./WorkbenchView.js";

const actions: CardActions = { arm: () => undefined, disarm: () => undefined, answer: () => undefined };

function state(...cards: ReturnType<typeof holdCard>[]): WaitingState {
  return waitingReducer(initialWaiting, { type: "snapshot", cards });
}

function render(waiting: WaitingState, push: PushPhase = "hidden", focus: string | null = null, tickets: TicketsState = initialTickets): string {
  return renderToString(
    <WorkbenchView waiting={waiting} actions={actions} focus={focus} focused={() => undefined} push={push} togglePush={() => undefined} tickets={tickets} />,
  );
}

function text(html: string): string {
  return html.replaceAll(/<[^>]+>/g, "|").replaceAll(/\|+/g, "|");
}

describe("工作台", () => {
  it("shows nothing while it does not yet know what waits", () => {
    const html = render(initialWaiting);
    expect(html).toContain("等你");
    expect(html).not.toContain("没有等你的事");
    expect(html).not.toContain('class="count');
  });

  it("says so when nothing waits", () => {
    const html = render(state());
    expect(html).toContain("没有等你的事");
    expect(html).toContain('class="count"');
  });

  it("shows a count that equals the cards", () => {
    const html = render(state(holdCard("a1"), holdCard("b2", { at: 2000 })));
    expect(html).toContain('<span class="count count--hot">2</span>');
    expect(html.match(/<article /g)).toHaveLength(2);
  });

  it("shows exactly what will run, where, as whom and why it was held", () => {
    const html = render(state(holdCard("a1", { command: "gh repo delete novan-xu/old --yes", cwd: "/srv/projects/app" })));
    expect(html).toContain("gh repo delete novan-xu/old --yes");
    expect(html).toContain("/srv/projects/app");
    expect(html).toContain(">nas<");
    expect(html).toContain(">novan-xu<");
    expect(html).toContain("删除仓库");
  });

  it("shows a long command whole", () => {
    const command = `echo ${"x".repeat(5000)}; rm -rf /tmp/${"y".repeat(500)}`;
    const html = render(state(holdCard("a1", { command })));
    expect(html.includes(command)).toBe(true);
  });

  it("shows a command's special characters as text, not as markup", () => {
    const html = render(state(holdCard("a1", { command: "echo '<img src=x onerror=alert(1)>' && cat <<EOF" })));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("makes what cannot be seen in a command visible", () => {
    const html = render(state(holdCard("a1", { command: "rm‮ -rf x" })));
    expect(html).toContain("U+202E");
    expect(html).not.toContain("‮");
  });

  it("leaves out the folder when there is none", () => {
    expect(render(state(holdCard("a1", { cwd: null })))).not.toContain("raw-folder");
  });

  it("offers 确认 and 拒绝 on a card, and 取消 in place of 拒绝 only after 确认 was pressed once", () => {
    const idle = text(render(state(holdCard("a1"))));
    expect(idle).toContain("确认");
    expect(idle).toContain("拒绝");
    expect(idle).not.toContain("取消");
    const armed = text(render(waitingReducer(state(holdCard("a1")), { type: "arm", key: "hold:a1" })));
    expect(armed).toContain("取消");
    expect(armed).toContain("确认");
    expect(armed).not.toContain("拒绝");
  });

  it("puts 确认 in another place once it is armed, so a second tap in the same place cannot confirm", () => {
    const first = render(state(holdCard("a1")));
    const second = render(waitingReducer(state(holdCard("a1")), { type: "arm", key: "hold:a1" }));
    const order = (html: string) => [...html.matchAll(/<button class="btn[^"]*"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?([^<]+)</g)].map((match) => match[1]);
    expect(order(first)).toEqual(["确认", "拒绝"]);
    expect(order(second)).toEqual(["取消", "确认"]);
  });

  it("disables both buttons while the answer is on its way", () => {
    const sending = waitingReducer(waitingReducer(state(holdCard("a1")), { type: "arm", key: "hold:a1" }), { type: "sending", key: "hold:a1", verdict: "release" });
    const html = render(sending);
    expect(html.match(/<button class="btn[^"]*" type="button" disabled=""/g)).toHaveLength(2);
    expect(html).toContain("is-busy");
  });

  it("tells why an answer did not go through", () => {
    const failed = waitingReducer(state(holdCard("a1")), { type: "failed", key: "hold:a1", failure: "conflict" });
    expect(render(failed)).toContain("这一项已经处理过或已有变化，请刷新后再看");
  });

  it("marks the card a notification opened", () => {
    const html = render(state(holdCard("a1"), holdCard("b2", { at: 2000 })), "hidden", "hold:a1");
    expect(html.match(/wcard--focus/g)).toHaveLength(1);
    expect(html).toMatch(/wcard--focus" id="card-hold:a1"/);
  });
});

describe("the notification switch", () => {
  it("is not offered unless push can work", () => {
    for (const phase of ["checking", "hidden"] as const) {
      expect(render(state(), phase)).not.toContain('role="switch"');
    }
  });

  it("is on or off as the device is", () => {
    expect(render(state(), "off")).toContain('aria-checked="false"');
    expect(render(state(), "on")).toContain('aria-checked="true"');
  });

  it("cannot be pressed when the browser has refused, and says what to do", () => {
    const html = render(state(), "blocked");
    expect(html).toContain("disabled");
    expect(html).toContain("浏览器拒绝了通知，请在系统设置里允许后再打开");
  });

  it("asks an iPhone to add the page to its home screen", () => {
    const html = render(state(), "install");
    expect(html).toContain("先把本页添加到主屏幕，才能收到通知");
    expect(html).not.toContain('role="switch"');
  });
});

describe("the open tickets in 工作台", () => {
  it("shows no count and no rows before the hub has sent them", () => {
    const html = render(state(), "hidden", null, initialTickets);
    expect(html).toContain("工单");
    expect(html).not.toContain("没有进行中的工单");
    expect(html).not.toContain("lrow");
  });

  it("says so when there are none", () => {
    expect(render(state(), "hidden", null, receiveTickets([]))).toContain("没有进行中的工单");
  });

  it("shows each ticket's Chinese title, repository, kind and state, and no English", () => {
    const html = render(
      state(),
      "hidden",
      null,
      receiveTickets([ticket(1, { title: { en: "Print a greeting", zh: "启动时打印问候" } }), ticket(2, { state: "working", kind: "fix" })]),
    );
    expect(html.match(/class="lrow"/g)).toHaveLength(2);
    expect(html).toContain("启动时打印问候");
    expect(html).not.toContain("Print a greeting");
    expect(html).toContain("novan-xu/super-agent-sandbox");
    expect(text(html)).toContain("|待开始|");
    expect(text(html)).toContain("|功能|");
    expect(text(html)).toContain("|进行中|");
    expect(text(html)).toContain("|修复|");
    expect(html).toContain("dot dot--ok dot--live");
    expect(html.indexOf("工作 2")).toBeLessThan(html.indexOf("启动时打印问候"));
  });

  it("comes below the 等你 row", () => {
    const html = render(state(holdCard("a1")), "hidden", null, receiveTickets([ticket(1)]));
    expect(html.indexOf("等你")).toBeLessThan(html.indexOf("工单"));
    expect(html.indexOf("gh repo delete")).toBeLessThan(html.indexOf("工作 1"));
  });
});
