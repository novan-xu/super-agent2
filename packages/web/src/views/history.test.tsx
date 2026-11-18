import type { Ticket } from "@super-agent2/protocol";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ticket } from "../live/fixtures.js";
import { type HistoryState, initialHistory, receivePage, startLoading, typeQuery } from "../live/history.js";
import { HistoryView } from "./HistoryView.js";

function ended(id: number, at: number, overrides: Partial<Ticket> = {}): Ticket {
  return ticket(id, { state: "merged", updatedAt: at, endedAt: at, ...overrides });
}

function shown(tickets: readonly Ticket[], next: string | null = null, query = ""): HistoryState {
  const typed = typeQuery(initialHistory, query);
  return receivePage(startLoading(typed), typed.applied, { tickets: [...tickets], next });
}

function render(history: HistoryState): string {
  return renderToString(
    <HistoryView
      history={history}
      ticketHref={(id) => `/tickets/${id}`}
      openTicket={() => undefined}
      search={() => undefined}
      more={() => undefined}
      retry={() => undefined}
      scroll={0}
      scrolled={() => undefined}
      now={5_000_000}
    />,
  );
}

function plain(html: string): string {
  return html.replaceAll(/<[^>]+>/g, "|").replaceAll(/\|+/g, "|");
}

describe("历史", () => {
  it("shows a search box and nothing else until the list is known", () => {
    const html = render(initialHistory);
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="搜索历史"');
    expect(html).not.toContain("还没有结束的工单");
    expect(html).not.toContain('class="list"');
    expect(render(startLoading(initialHistory))).not.toContain("还没有结束的工单");
  });

  it("says plainly that nothing has ended yet", () => {
    const html = render(shown([]));
    expect(html).toContain("还没有结束的工单");
    expect(html).not.toContain("清除搜索");
  });

  it("says plainly that a search found nothing, in the words searched for, and offers to clear it", () => {
    const html = render(shown([], null, "  没有  这个 "));
    expect(plain(html)).toContain("没有匹配「没有 这个」的工单");
    expect(html).toContain("清除搜索");
    expect(html).not.toContain("还没有结束的工单");
  });

  it("lists each ended ticket as a link to its detail, newest first, with how it ended", () => {
    const html = render(
      shown([
        ended(3, 3000, { state: "stopped", stopReason: { en: "The owner stopped it", zh: "你停止了它" } }),
        ended(2, 2000, { state: "delivered", kind: "writing", repository: null, issues: [], title: { en: "Notice", zh: "给邻居的通知" } }),
        ended(1, 1000),
      ]),
    );
    expect(html.match(/<a class="lrow"/g)).toHaveLength(3);
    expect(html.indexOf('href="/tickets/3"')).toBeLessThan(html.indexOf('href="/tickets/2"'));
    expect(html.indexOf('href="/tickets/2"')).toBeLessThan(html.indexOf('href="/tickets/1"'));
    expect(html).toContain("status--mute");
    expect(html).toContain("status--info");
    expect(html).toContain("status--ok");
    expect(plain(html)).toContain("已停止");
    expect(plain(html)).toContain("已完成");
    expect(plain(html)).toContain("已合并");
    expect(html).toContain("你停止了它");
  });

  it("shows the repository, the kind and the issues of a ticket for code, and the kind alone for writing", () => {
    const merged = {
      number: 12,
      url: "https://github.com/novan-xu/super-agent-sandbox/pull/12",
      branch: "sa2/ticket-1-beef",
      state: "merged" as const,
      closes: [1],
      mergeCommit: "abc1234",
      deployment: false,
      handedAt: 900,
      mergedAt: 1000,
    };
    const html = render(
      shown([
        ended(2, 2000, { state: "delivered", kind: "writing", repository: null, issues: [], title: { en: "Notice", zh: "给邻居的通知" } }),
        ended(1, 1000, { kind: "fix", pullRequest: 12, pullRequests: [merged] }),
      ]),
    );
    const [writing = "", code = ""] = html.split('<a class="lrow"').slice(1);
    expect(plain(writing)).toContain("写作");
    expect(writing).not.toContain("super-agent-sandbox");
    expect(plain(code)).toContain("修复");
    expect(plain(code)).toContain("novan-xu/super-agent-sandbox");
    expect(plain(code)).toContain("#1");
    expect(plain(code)).toContain("#12");
    expect(code).toContain('class="chain-number is-merged"');
  });

  it("shows when each ended", () => {
    const html = render(shown([ended(1, 1_000)]));
    expect(html).toMatch(/class="num">[^<]*\d\d:\d\d</);
  });

  it("shows the words of an issue that the title does not hold, when a search found the ticket by them", () => {
    const found = ended(1, 1000, {
      title: { en: "Parse dates", zh: "解析日期" },
      issues: [
        {
          repository: "novan-xu/super-agent-sandbox",
          number: 4,
          url: "https://github.com/novan-xu/super-agent-sandbox/issues/4",
          title: { en: "Words", zh: "词语" },
          summary: { en: "Words like tomorrow", zh: "把明天这样的词变成日期" },
        },
      ],
    });
    expect(render(shown([found], null, "明天"))).toContain("把明天这样的词变成日期");
    expect(render(shown([found], null, "日期"))).not.toContain("把明天这样的词变成日期");
    expect(render(shown([found]))).not.toContain("把明天这样的词变成日期");
  });

  it("offers more only when the hub has more", () => {
    expect(render(shown([ended(2, 2000)], "2000.2"))).toContain("更多");
    expect(render(shown([ended(2, 2000)], null))).not.toContain("更多");
  });

  it("says when it could not read the history, and offers to try again", () => {
    const html = render({ ...startLoading(initialHistory), status: "failed" });
    expect(html).toContain("没能读到历史");
    expect(html).toContain("重试");
  });

  it("puts the words already searched for back into the box", () => {
    const html = render(shown([ended(1, 1000)], null, "日期"));
    expect(html).toContain('value="日期"');
  });

  it("keeps the old list on screen, marked as busy, while the answer to a new search is awaited", () => {
    const html = render(typeQuery(shown([ended(1, 1000)]), "日期"));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('href="/tickets/1"');
  });

  it("marks a ticket whose decisions wait for the owner with their count", () => {
    const waiting = { id: 1, source: "brain" as const, attempt: null, pullRequest: null, chosen: { en: "c", zh: "选了" }, why: { en: "w", zh: "因为" }, otherOptions: { en: "o", zh: "不选" }, at: 1, verdict: null, opinion: null, reviewedAt: null, sentAt: null };
    const html = render(shown([ended(2, 4_000_000, { decisions: [waiting, { ...waiting, id: 2 }] }), ended(1, 3_000_000, { decisions: [{ ...waiting, id: 3, verdict: "ok" }] })]));
    expect(html).toContain('aria-label="2 个决定等你看"');
    expect(html.match(/count--hot/g)).toHaveLength(1);
  });
});

