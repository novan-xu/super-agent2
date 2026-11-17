import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WaitingCard } from "@super-agent2/protocol";
import { holdCard, startCard, ticket, workStatus } from "../live/fixtures.js";
import { initialTickets, receiveTickets, type TicketsState } from "../live/tickets.js";
import { type WaitingState, waitingReducer, initialWaiting } from "../live/waiting.js";
import type { PushPhase } from "../live/push.js";
import { type CardActions, WorkbenchView } from "./WorkbenchView.js";

const actions: CardActions = { arm: () => undefined, disarm: () => undefined, answer: () => undefined, start: () => undefined, choose: () => undefined, answerStuck: () => undefined };

function state(...cards: WaitingCard[]): WaitingState {
  return waitingReducer(initialWaiting, { type: "snapshot", cards });
}

function render(waiting: WaitingState, push: PushPhase = "hidden", focus: string | null = null, tickets: TicketsState = initialTickets): string {
  return renderToString(
    <WorkbenchView waiting={waiting} actions={actions} focus={focus} focused={() => undefined} push={push} togglePush={() => undefined} tickets={tickets} ticketHref={(id) => `/tickets/${id}`} openTicket={() => undefined} now={0} />,
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
      receiveTickets([ticket(1, { state: "waiting", title: { en: "Print a greeting", zh: "启动时打印问候" } }), ticket(2, { state: "working", kind: "fix", work: workStatus() })]),
    );
    expect(html.match(/class="lrow"/g)).toHaveLength(2);
    expect(html).toContain("启动时打印问候");
    expect(html).not.toContain("Print a greeting");
    expect(html).toContain("novan-xu/super-agent-sandbox");
    expect(text(html)).toContain("|等前序|");
    expect(text(html)).toContain("|功能|");
    expect(text(html)).toContain("|进行中|");
    expect(text(html)).toContain("|修复|");
    expect(html).toContain("dot dot--ok dot--live");
    expect(html.indexOf("工作 2")).toBeLessThan(html.indexOf("启动时打印问候"));
  });

  it("groups the tickets by repository, with writing tickets in a group of their own, last", () => {
    const html = render(
      state(),
      "hidden",
      null,
      receiveTickets([
        ticket(1, { state: "working", repository: "novan-xu/zeta", work: workStatus() }),
        ticket(2, { state: "working", repository: "nuofan-island/alpha", work: workStatus() }),
        ticket(3, { state: "working", kind: "writing", repository: null, issues: [], title: { en: "Write", zh: "写一封信" }, work: workStatus({ engine: "antigravity" }) }),
        ticket(4, { state: "working", repository: "novan-xu/zeta", work: workStatus() }),
      ]),
    );
    const order = ["novan-xu/zeta", "nuofan-island/alpha", "写作", "写一封信"].map((part) => html.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/class="ticket-group"/g)).toHaveLength(3);
  });

  it("links each row to the ticket's own address", () => {
    const html = render(state(), "hidden", null, receiveTickets([ticket(7, { state: "working", work: workStatus() })]));
    expect(html).toContain('href="/tickets/7"');
  });

  it("says plainly when a ticket failed, could not begin, or cannot be reached, with what the hub recorded", () => {
    const html = render(
      state(),
      "hidden",
      null,
      receiveTickets([
        ticket(1, { state: "working", work: workStatus({ state: "failed", failure: "program", reason: "exit code 3" }) }),
        ticket(2, { state: "working", beginFailure: "Ticket 2 has no writing task" }),
        ticket(3, { state: "working", work: workStatus({ unreachableSince: 50_000, machine: "mini" }) }),
      ]),
    );
    expect(text(html)).toContain("|执行失败|");
    expect(html).toContain("程序出错或额度用完：exit code 3");
    expect(text(html)).toContain("|没能开始|");
    expect(html).toContain("Ticket 2 has no writing task");
    expect(text(html)).toContain("|联系不上|");
    expect(html).toContain("联系不上 mini");
    expect(html.match(/dot--live/g)).toBeNull();
  });

  it("says what a waiting ticket waits for", () => {
    const html = render(
      state(),
      "hidden",
      null,
      receiveTickets([
        ticket(1, { state: "working", title: { en: "First", zh: "先做的事" }, work: workStatus() }),
        ticket(2, { state: "waiting", waits: [{ ticket: 1, deployment: false, waived: false }], waitsFor: [1] }),
      ]),
    );
    const row = html.slice(html.indexOf('id="ticket-2"'), html.indexOf('id="ticket-1"'));
    expect(row).toContain("等前序");
    expect(row).toContain("先做的事");
  });

  it("comes below the 等你 row", () => {
    const html = render(state(holdCard("a1")), "hidden", null, receiveTickets([ticket(1, { state: "working" })]));
    expect(html.indexOf("等你")).toBeLessThan(html.indexOf("工单"));
    expect(html.indexOf("gh repo delete")).toBeLessThan(html.indexOf("工作 1"));
  });
});

describe("start cards in 工作台", () => {
  const pair = ticket(1, {
    title: { en: "Parse dates and times", zh: "解析日期和时间" },
    issues: [
      { repository: "novan-xu/super-agent-sandbox", number: 11, url: "u", title: { en: "Parse dates", zh: "解析日期" }, summary: { en: "a", zh: "甲" } },
      { repository: "novan-xu/super-agent-sandbox", number: 12, url: "u", title: { en: "Parse times", zh: "解析时间" }, summary: { en: "b", zh: "乙" } },
    ],
  });

  it("shows a chain's issues in order by their Chinese titles, and no English", () => {
    const html = render(state(startCard(1, { ticket: pair })));
    expect(html).toContain("可以开始");
    expect(html.indexOf("解析日期")).toBeLessThan(html.indexOf("解析时间"));
    expect(html).toContain("#11");
    expect(html).toContain("#12");
    expect(html).not.toContain("Parse");
    expect(text(html)).toContain("|开始|");
  });

  it("counts pending chains with what waits for the owner", () => {
    const html = render(state(holdCard("a1"), startCard(1), startCard(2, { before: [{ id: 1, zh: "工作 1" }], startable: false })));
    expect(html).toContain('<span class="count count--hot">3</span>');
    expect(html).not.toContain("没有等你的事");
  });

  it("puts the chains that wait under 之后, each under what it waits for, without 开始 when that is not started", () => {
    const html = render(
      state(
        startCard(1, { ticket: { title: { en: "Server", zh: "加接口" }, issues: [] } }),
        startCard(2, { before: [{ id: 1, zh: "加接口" }], startable: false, ticket: { issues: [] } }),
      ),
    );
    const later = html.slice(html.indexOf("之后"));
    expect(html.indexOf("可以开始")).toBeLessThan(html.indexOf("之后"));
    expect(later).toContain("加接口");
    expect(later.indexOf("加接口")).toBeLessThan(later.indexOf('id="card-start:2"'));
    expect(text(later)).not.toContain("|开始|");
  });

  it("shows a writing ticket's title and summary on its card, which has no repository and no issues", () => {
    const html = render(
      state(
        startCard(1, {
          ticket: {
            kind: "writing",
            repository: null,
            issues: [],
            title: { en: "Translate a notice", zh: "翻译一则通知" },
            summary: { en: "Translate the notice into English", zh: "把通知译成英文" },
          },
          choice: { engine: "antigravity", model: "gemini-3.8-flash", effort: "high" },
        }),
      ),
    );
    expect(html).toContain('<p class="card-title">翻译一则通知</p>');
    expect(html).toContain("把通知译成英文");
    expect(html).toContain("写作");
    expect(html).not.toContain("chip--mono");
    expect(html).toContain("Antigravity");
    expect(text(html)).toContain("|开始|");
  });

  it("offers 开始 under 之后 for a chain after work that has started", () => {
    const html = render(state(startCard(5, { before: [{ id: 3, zh: "已经在做", state: "working" }] })));
    expect(html).not.toContain("可以开始");
    expect(text(html.slice(html.indexOf("之后")))).toContain("|开始|");
  });

  it("offers 全部开始 only when there is more than one chain to start", () => {
    expect(render(state(startCard(1)))).not.toContain("全部开始");
    expect(render(state(startCard(1), startCard(3)))).toContain("全部开始");
  });

  it("disables 开始 while the start is on its way and tells why it failed", () => {
    const sending = waitingReducer(state(startCard(1)), { type: "starting", keys: ["start:1"] });
    expect(render(sending)).toContain("is-busy");
    const failed = waitingReducer(state(startCard(1)), { type: "failed", key: "start:1", failure: "conflict" });
    expect(render(failed)).toContain("这一项已经处理过或已有变化，请刷新后再看");
  });

  it("shows a chain's difficulty, platform and reason in Chinese, with its machine, engine and model to change", () => {
    const html = render(
      state(startCard(1, { ticket: { difficulty: "complex", platform: "windows", difficultyReason: { en: "Across modules", zh: "跨模块的改动" } } })),
    );
    expect(html).toContain("复杂");
    expect(html).toContain("Windows");
    expect(html).toContain("跨模块的改动");
    expect(html).not.toContain("Across modules");
    expect(text(html)).toContain("|机器|");
    expect(html).toContain('<option value="pc" selected="">pc</option>');
    expect(html).toContain('<option value="codex" selected="">Codex</option>');
    expect(html).toContain('<option value="gpt-6.1-sol high" selected="">gpt-6.1-sol · high</option>');
    expect(html).toContain('<option value="gpt-6-luna low">gpt-6-luna · low</option>');
  });

  it("says what is missing and offers no 开始 until the choice is complete", () => {
    const html = render(state(startCard(1, { choice: { machine: null, missing: ["machine"] } })));
    expect(html).toContain("没有在线的机器适合它");
    expect(text(html)).not.toContain("|开始|");
  });

  it("leaves pending tickets out of the ticket list, since they are start cards", () => {
    const html = render(state(startCard(1)), "hidden", null, receiveTickets([ticket(1), ticket(2, { state: "working" })]));
    expect(html.match(/class="lrow"/g)).toHaveLength(1);
  });
});
