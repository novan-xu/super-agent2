import { text as catalogText } from "@super-agent2/catalog";
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
  review: () => Promise.resolve(true),
  machines: () => Promise.resolve([]),
};

function render(detail: DetailState | null, known: ReadonlyMap<number, Ticket> = new Map()): string {
  return renderToString(<TicketView detail={detail} known={known} actions={actions} origin="workbench" backHref="/workbench" back={() => undefined} ticketHref={(id) => `/tickets/${id}`} openTicket={() => undefined} now={20_000} />);
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
  return receiveDetailWork(receiveDetail(openDetail(value.id), { ticket: value, moves, attempts: value.work === null ? [] : [value.work], rounds: [], switches: [] }), events);
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

  it("marks the issues already merged and lists the pull requests in the order handed in", () => {
    const pull = (number: number, state: "merged" | "open", closes: number[]) => ({
      number,
      url: `https://github.com/novan-xu/super-agent-sandbox/pull/${number}`,
      branch: `sa2/ticket-1-${number}`,
      state,
      closes,
      mergeCommit: state === "merged" ? `merge-${number}` : null,
      deployment: null,
      handedAt: 9000 + number,
      mergedAt: state === "merged" ? 9500 + number : null,
    });
    const html = render(detailOf({ ...running, state: "verifying", pullRequest: 22, pullRequests: [pull(21, "merged", [3]), pull(22, "open", [4])] }));
    const issues = html.slice(html.indexOf('class="chain-issues"'), html.indexOf('class="chain-pulls"'));
    expect(issues.indexOf('class="chain-issue is-merged"')).toBeLessThan(issues.indexOf("问候"));
    expect(issues.split('class="chain-issue is-merged"')).toHaveLength(2);
    const pulls = html.slice(html.indexOf('class="chain-pulls"'));
    expect(text(pulls)).toMatch(/已合并\|#21\|#3\|.*未合并\|#22\|#4\|/);
    expect(pulls).toContain('href="https://github.com/novan-xu/super-agent-sandbox/pull/22"');
  });

  it("goes back to the list it was opened from, named as that list is named in the navigation", () => {
    const back = (origin: "workbench" | "history", href: string) =>
      text(renderToString(<TicketView detail={detailOf(running)} known={new Map()} actions={actions} origin={origin} backHref={href} back={() => undefined} ticketHref={(id) => `/tickets/${id}`} openTicket={() => undefined} now={20_000} />));
    const fromHistory = renderToString(<TicketView detail={detailOf(running)} known={new Map()} actions={actions} origin="history" backHref="/history" back={() => undefined} ticketHref={(id) => `/tickets/${id}`} openTicket={() => undefined} now={20_000} />);
    expect(fromHistory).toContain('<a class="back" href="/history">');
    expect(back("history", "/history")).toContain("|历史|");
    expect(back("workbench", "/workbench")).toContain("|工作台|");
    expect(back("history", "/history")).not.toContain("|工作台|");
  });

  it("shows a repair ticket as one, linked to the ticket it repairs, and the repaired ticket linked to its repair", () => {
    const repair = render(detailOf({ ...running, repairs: 5, repairsReference: "ae-2026-11-18" }));
    expect(text(repair)).toContain("|补救|");
    expect(repair).toContain('href="/tickets/5"');
    expect(text(repair)).toContain("接着工单 ae");
    expect(repair).not.toContain("接手");
    expect(repair).toContain('<span class="chip chip--mono">aa</span>');
    expect(repair).not.toContain("2026-11-18");
    const ended = render(detailOf(ticket(5, { state: "stopped", repairedBy: 9, repairedByReference: "ai-2026-11-20", work: null })));
    expect(ended).toContain('href="/tickets/9"');
    expect(text(ended)).toContain("由工单 ai 接着做");
    expect(text(ended)).not.toContain("|补救|");
    const plain = render(detailOf(running));
    expect(text(plain)).not.toContain("补救");
    expect(plain).not.toContain("/tickets/");
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

  it("hides tool logs and updates one live status while preserving visible work", () => {
    const events = [
      workEvent(1, { kind: "text", block: "a", delta: "Thinking here" }),
      workEvent(2, { kind: "tool.started", call: "first", name: "shell", input: "first command" }),
      workEvent(3, { kind: "tool.finished", call: "first", ok: true, output: "secret output" }),
      workEvent(4, { kind: "message", id: "m1", from: "owner", text: "Keep going", delivery: "steered" }),
      workEvent(5, { kind: "tool.started", call: "second", name: "search", input: "second query" }),
    ];
    const live = render(detailOf(running, events));
    expect(live).toContain("Thinking here");
    expect(live).toContain("Keep going");
    expect(live).not.toContain("first command");
    expect(live).not.toContain("secret output");
    expect(live).not.toContain('<details class="tool"');
    expect(live.match(/class="brain-status"/g)).toHaveLength(1);
    expect(live).toContain(catalogText("brain.callingWithSummary", { tool: "search", summary: "second query" }));

    const idle = render(detailOf(running, [...events, workEvent(6, { kind: "tool.finished", call: "second", ok: true, output: "other output" })]));
    expect(idle).toContain(catalogText("ticket.working"));
    expect(idle).not.toContain("second query");
    expect(idle).not.toContain("other output");

    const ended = render(detailOf(running, [...events, workEvent(6, { kind: "stopped", saved: true, detail: "" })]));
    expect(ended).not.toContain('class="brain-status"');
    expect(ended).not.toContain("second query");
    expect(ended).toContain(catalogText("timeline.workSaved"));

    const trailingTool = render(detailOf(running, [events[0]!, events[1]!]));
    expect(trailingTool).toContain('class="msg-text cursor"');
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
        workEvent(1, { kind: "delivered", text: "Dear friend", files: [{ name: "letter.md", size: 12, mediaType: "text/markdown" }], report: { en: "Done", zh: "写好了" } }, { ticket: 2 }),
      ]),
    );
    expect(html).toContain("Dear friend");
    expect(html).toContain('href="/api/tickets/2/files/letter.md"');
    expect(html).toContain("写好了");
    expect(html).not.toContain("分支");
    expect(text(html)).not.toContain("|停止|");
  });

  it("shows a deployment's commit, and a failed hand-back as a failure with the worker's report", () => {
    const deployment = ticket(3, {
      state: "working",
      form: "task",
      kind: "operation",
      deploys: true,
      issues: [],
      commitRef: "merged",
      commit: "abc1234def5678abc1234def5678abc1234def56",
      title: { en: "Deploy", zh: "部署沙盒" },
      work: workStatus({ state: "failed", failure: "task-failed", reason: "It did not come up" }),
    });
    const html = render(
      detailOf(deployment, [workEvent(1, { kind: "delivered", outcome: "failed", text: null, files: [], report: { en: "It did not come up", zh: "没起来，已回滚" } }, { ticket: 3 })]),
    );
    expect(text(html)).toContain("|部署|");
    expect(html).toContain('href="https://github.com/novan-xu/super-agent-sandbox/commit/abc1234def5678abc1234def5678abc1234def56"');
    expect(html).not.toContain("分支");
    expect(html).toContain("工作者报告任务没有完成");
    expect(html).toContain("没起来，已回滚");
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

  it("shows in Chinese that the provider was switched, with the raw reason, and says it was the owner's choice", () => {
    const base = detailOf({ ...running, work: workStatus({ attempt: 2, engine: "claude", model: "claude-opus-5-5", effort: "high" }) });
    const entry = { ticket: 1, seq: 1, kind: "switched" as const, at: 12_000, from: "codex" as const, to: "claude" as const, machine: "pc", model: "claude-opus-5-5", effort: "high", reason: "You've hit your usage limit", until: null, owner: false, attempt: 2 };
    const plain = render({ ...base, switches: [entry] });
    expect(text(plain)).toContain("|换了供应商|");
    expect(plain).toContain("Codex 暂不可用，改用 Claude Code（claude-opus-5-5 · high）");
    expect(plain).toContain("You&#x27;ve hit your usage limit");
    expect(render({ ...base, switches: [{ ...entry, owner: true }] })).toContain("你选的 Codex 暂不可用，改用 Claude Code（claude-opus-5-5 · high）");
  });

  it("shows that the ticket waits for a provider, with when it will try again, and when the same one is back", () => {
    const waiting = detailOf({ ...running, work: workStatus({ state: "unavailable", reason: "limit" }) });
    const entry = { ticket: 1, seq: 1, kind: "waiting" as const, at: 12_000, from: "claude" as const, to: null, machine: null, model: null, effort: null, reason: "limit", until: 40_000, owner: false, attempt: 1 };
    const html = render({ ...waiting, switches: [entry] });
    expect(text(html)).toContain("|等可用的供应商|");
    expect(html).toContain("Claude Code 暂不可用，没有别的供应商可换");
    expect(html).toContain("没有供应商可用，会自己再试");
    expect(render({ ...waiting, switches: [{ ...entry, until: null }] })).toContain("Claude Code 暂不可用，没有别的供应商可换</div>");
    const back = render({ ...waiting, switches: [{ ...entry, kind: "resumed" as const, to: "claude" as const }] });
    expect(text(back)).toContain("|供应商恢复了|");
    expect(back).toContain("Claude Code 又可用了，接着用它");
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

  it("shows the decisions made on the owner's behalf above the timeline, each with 可以 and a box for an opinion until it is settled", () => {
    const decision = (id: number, verdict: "ok" | "opinion" | null, pullRequest: number | null = null) => ({
      id,
      source: "worker" as const,
      attempt: 1,
      pullRequest,
      chosen: { en: `Chose ${id}`, zh: `选了方案 ${id}` },
      why: { en: "Why", zh: `理由 ${id}` },
      otherOptions: { en: "Other", zh: `另一种做法 ${id}` },
      at: 1,
      verdict,
      opinion: verdict === "opinion" ? "我觉得应该反过来" : null,
      reviewedAt: verdict === null ? null : 2,
      sentAt: null,
    });
    const reviewed = { ...running, state: "merged" as const, endedAt: 15_000, work: null, decisions: [decision(1, "ok"), decision(2, "opinion"), decision(3, null, 21)] };
    const html = render(detailOf(reviewed));
    expect(html.indexOf("选了方案 1")).toBeLessThan(html.indexOf("timeline"));
    expect(text(html)).toContain("|决定|1|");
    expect(html).toContain("理由 2");
    expect(html).toContain("另一种做法 3");
    expect(html).toContain("我觉得应该反过来");
    expect(html).toContain('href="https://github.com/novan-xu/super-agent-sandbox/pull/21"');
    expect(html.match(/class="drow-review"/g)).toHaveLength(1);
    expect(html.match(/aria-label="可以"/g)).toHaveLength(1);
    expect(html).toContain('placeholder="意见"');
    expect(render(detailOf(running))).not.toContain("决定");
  });
});
