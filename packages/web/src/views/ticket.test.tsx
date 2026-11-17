import type { Ticket, TicketMove } from "@super-agent2/protocol";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type DetailState, openDetail, receiveDetail, receiveDetailWork } from "../live/detail.js";
import { ticket, verification, workEvent, workStatus } from "../live/fixtures.js";
import { type TicketActions, TicketView } from "./TicketView.js";

const actions: TicketActions = {
  stop: () => Promise.resolve(true),
  reassign: () => Promise.resolve(true),
  message: () => Promise.resolve(true),
  machines: () => Promise.resolve([]),
};

function render(detail: DetailState | null, known: ReadonlyMap<number, Ticket> = new Map()): string {
  return renderToString(<TicketView detail={detail} known={known} actions={actions} origin="workbench" backHref="/workbench" back={() => undefined} now={20_000} />);
}

function text(html: string): string {
  return html.replaceAll(/<[^>]+>/g, "|").replaceAll(/\|+/g, "|");
}

const moves: TicketMove[] = [
  { ticket: 1, seq: 1, from: null, to: "pending", reason: null, at: 1000 },
  { ticket: 1, seq: 2, from: "pending", to: "working", reason: null, at: 9000 },
];

const running = ticket(1, {
  state: "working",
  title: { en: "Greet", zh: "打印问候" },
  issues: [
    { repository: "novan-xu/super-agent-sandbox", number: 3, url: "https://github.com/novan-xu/super-agent-sandbox/issues/3", title: { en: "Greet", zh: "问候" }, summary: { en: "s", zh: "说" } },
    { repository: "novan-xu/super-agent-sandbox", number: 4, url: "https://github.com/novan-xu/super-agent-sandbox/issues/4", title: { en: "Bye", zh: "告别" }, summary: { en: "s", zh: "说" } },
  ],
  machine: "pc",
  engine: "codex",
  model: "gpt-6-luna",
  effort: "medium",
  chosenBy: { machine: "owner", engine: "default", model: "default", effort: "default" },
  ran: { machine: "pc", engine: "codex", model: "gpt-6-luna", effort: "low", at: 10_000 },
  branch: "sa2/ticket-1-abcd",
  work: workStatus(),
});

function detailOf(value: Ticket, events = [workEvent(1, { kind: "text", block: "a", delta: "Reading the issue" })]): DetailState {
  return receiveDetailWork(receiveDetail(openDetail(value.id), { ticket: value, moves, attempts: value.work === null ? [] : [value.work], rounds: [] }), events);
}

describe("a ticket's detail", () => {
  it("shows the title, the timeline and the panel with issues in order, linked to GitHub", () => {
    const html = render(detailOf(running));
    expect(html).toContain("打印问候");
    expect(html).not.toContain(">Greet<");
    expect(html.indexOf("问候")).toBeLessThan(html.indexOf("告别"));
    expect(html).toContain('href="https://github.com/novan-xu/super-agent-sandbox/issues/3"');
    expect(html).toContain('href="https://github.com/novan-xu/super-agent-sandbox/tree/sa2/ticket-1-abcd"');
    expect(text(html)).toContain("|建立|");
    expect(text(html)).toContain("|开始|");
    expect(html).toContain("Reading the issue");
    expect(html).toContain('aria-label="时间线"');
  });

  it("goes back to the list it was opened from, named as that list is named in the navigation", () => {
    const back = (origin: "workbench" | "history", href: string) =>
      text(renderToString(<TicketView detail={detailOf(running)} known={new Map()} actions={actions} origin={origin} backHref={href} back={() => undefined} now={20_000} />));
    const fromHistory = renderToString(<TicketView detail={detailOf(running)} known={new Map()} actions={actions} origin="history" backHref="/history" back={() => undefined} now={20_000} />);
    expect(fromHistory).toContain('<a class="back" href="/history">');
    expect(back("history", "/history")).toContain("|历史|");
    expect(back("workbench", "/workbench")).toContain("|工作台|");
    expect(back("history", "/history")).not.toContain("|工作台|");
  });

  it("marks what the owner chose and says what actually ran", () => {
    const html = render(detailOf(running));
    expect(html.match(/aria-label="你选的"/g)).toHaveLength(1);
    expect(html).toContain("实际运行");
    expect(html).toContain("gpt-6-luna · low");
  });

  it("offers 停止, 改派 and the reply box while the worker runs", () => {
    const html = render(detailOf(running));
    expect(text(html)).toContain("|改派|");
    expect(text(html)).toContain("|停止|");
    expect(html).toContain('aria-label="发给工作者的消息"');
    expect(html).toContain("dot--live");
  });

  it("offers no reply box and no motion when the worker cannot be reached, and says since when", () => {
    const html = render(detailOf({ ...running, work: workStatus({ unreachableSince: 15_000, machine: "mini" }) }));
    expect(html).not.toContain("发给工作者的消息");
    expect(html).not.toContain("dot--live");
    expect(html).not.toContain("typing");
    expect(html).toContain("联系不上 mini");
  });

  it("says plainly that the work failed, with the hub's reason", () => {
    const failed = { ...running, work: workStatus({ state: "failed", failure: "no-pull-request" as const, reason: "The pull request does not close #4" }) };
    const html = render(detailOf(failed, [workEvent(1, { kind: "failed", failure: "no-pull-request", reason: "The pull request does not close #4" })]));
    expect(text(html)).toContain("|执行失败|");
    expect(html).toContain("没有交回合格的结果");
    expect(html).toContain("The pull request does not close #4");
    expect(html).not.toContain("发给工作者的消息");
  });

  it("shows a delivered writing ticket's text and files", () => {
    const writing = ticket(2, { state: "delivered", kind: "writing", repository: null, issues: [], title: { en: "Letter", zh: "写一封信" }, work: workStatus({ state: "finished", engine: "antigravity" }) });
    const html = render(
      detailOf(writing, [
        workEvent(1, { kind: "delivered", text: "Dear friend", files: [{ name: "letter.md", size: 12, mediaType: "text/markdown", data: "" }], report: { en: "Done", zh: "写好了" } }, { ticket: 2 }),
      ]),
    );
    expect(html).toContain("Dear friend");
    expect(html).toContain('href="/api/tickets/2/files/letter.md"');
    expect(html).toContain("写好了");
    expect(html).not.toContain("分支");
    expect(text(html)).not.toContain("|停止|");
  });

  it("shows which verification rule applied, the pipeline, and what verification waits for", () => {
    const merged = { ...running, state: "merged" as const, pullRequest: 12, work: workStatus({ state: "finished" }), verification: verification({ rule: "documentation", state: "merged", waiting: null, level: "documentation" }) };
    expect(text(render(detailOf(merged)))).toContain("|验证|只改了文本和文档|");
    const waiting = {
      ...running,
      state: "verifying" as const,
      pullRequest: 12,
      work: workStatus({ state: "finished" }),
      verification: verification({ waiting: "workflows", pipeline: { number: 7, url: "https://ci.example/repos/6/pipeline/7" }, reason: "Pipeline #7 on abcdef1 is running" }),
    };
    const html = render(detailOf(waiting));
    expect(text(html)).toContain("|验证|Woodpecker 工作流全部通过|");
    expect(html).toContain('href="https://ci.example/repos/6/pipeline/7"');
    expect(html).toContain("Woodpecker 正在验证 abcdef1");
    const failed = { ...waiting, verification: verification({ state: "failed", waiting: null, failures: [{ workflow: "check-windows", step: "check", exitCode: 1 }] }) };
    const red = render(detailOf(failed));
    expect(text(red)).toContain("|验证没通过|");
    expect(red).toContain("check-windows 的 check 没通过");
    expect(text(render(detailOf(running)))).not.toContain("|验证|");
  });

  it("shows the guided round when there is one, and none when there is not", () => {
    expect(render(detailOf(running))).not.toContain("引导");
    expect(render(detailOf({ ...running, round: 2 }))).toContain("第 2 轮");
  });

  it("says when the hub has no such ticket", () => {
    expect(render({ ...openDetail(9), missing: true })).toContain("找不到这个工单");
  });

  it("folds the panel on a phone with its summary first", () => {
    const html = render(detailOf(running));
    expect(html).toContain('class="panel is-collapsed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html.indexOf("panel-sec--summary")).toBeLessThan(html.indexOf("panel-rest"));
  });
});
