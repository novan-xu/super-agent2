import type { TicketRound, WaitingCard } from "@super-agent2/protocol";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { openDetail, receiveDetail } from "../live/detail.js";
import { stuckCard, ticket, workStatus } from "../live/fixtures.js";
import { initialTickets } from "../live/tickets.js";
import { initialWaiting, type WaitingState, waitingReducer } from "../live/waiting.js";
import { TicketView } from "./TicketView.js";
import { type CardActions, WorkbenchView } from "./WorkbenchView.js";

const actions: CardActions = { stop: async () => true, answer: () => undefined, start: () => undefined, choose: () => undefined, answerStuck: () => undefined };

function state(...cards: WaitingCard[]): WaitingState {
  return waitingReducer(initialWaiting, { type: "snapshot", cards });
}

function render(waiting: WaitingState): string {
  return renderToString(
    <WorkbenchView waiting={waiting} actions={actions} focus={null} focused={() => undefined} push="hidden" togglePush={() => undefined} tickets={initialTickets} ticketHref={(id) => `/tickets/${id}`} openTicket={() => undefined} now={0} />,
  );
}

function text(html: string): string {
  return html.replaceAll(/<[^>]+>/g, "|").replaceAll(/\|+/g, "|");
}

describe("a stopped ticket's card in 等你", () => {
  it("says what the ticket is, which round it is on, and where it is stuck in the brain's words", () => {
    const shown = text(render(state(stuckCard(4, { where: { en: "Stuck on the greeting test", zh: "卡在问候的测试上，三轮都没改对" } }))));
    expect(shown).toContain("工作 4");
    expect(render(state(stuckCard(4)))).toContain('<span class="mono wb-ticket-code">AD</span>');
    expect(render(state(stuckCard(4)))).toContain('aria-label="工作 4 AD"');
    expect(shown).toContain("第 3 轮");
    expect(shown).toContain("流水线没通过");
    expect(shown).toContain("卡在问候的测试上，三轮都没改对");
    expect(shown).not.toContain("让 greet 返回 hello");
    expect(shown).toContain("继续");
    expect(shown).toContain("放弃");
    expect(render(state(stuckCard(4)))).toContain('href="/tickets/4"');
    expect(render(state(stuckCard(4)))).toContain('<span class="count count--hot">1</span>');
  });

  it("falls back to the last guidance and the failure when the brain has not said where it is stuck", () => {
    const shown = text(render(state(stuckCard(4))));
    expect(shown).toContain("让 greet 返回 hello");
    expect(shown).toContain("Pipeline #9 on abc1234 failed: workflow check, step test (exit code 1)");
  });

  it("offers 继续 and 放弃 side by side, each answered by one press", () => {
    const html = render(state(stuckCard(4)));
    expect(text(html)).toContain("继续");
    expect(text(html)).toContain("放弃");
    expect(text(html)).not.toContain("取消");
    expect(html.match(/<button/g)).toHaveLength(2);
    const sending = render(waitingReducer(state(stuckCard(4)), { type: "sending", key: "stuck:4-40000", verdict: "give-up" }));
    expect(sending).toContain("is-busy");
    expect(text(sending)).toContain("继续");
  });
});

describe("a round in the ticket's timeline", () => {
  it("shows the round and the brain's guidance in Chinese on the attempt it started", () => {
    const round: TicketRound = { seq: 1, round: 2, attempt: 3, failure: { kind: "no-pull-request", detail: "" }, guidance: { en: "Return hello", zh: "让 greet 返回 hello" }, at: 30 };
    const retry: TicketRound = { seq: 2, round: null, attempt: 4, failure: { kind: "lost", detail: "" }, guidance: { en: "Start again", zh: "从分支上重新开始" }, at: 40 };
    const detail = receiveDetail(openDetail(1), {
      ticket: ticket(1, { state: "working", round: 2, work: workStatus({ attempt: 4 }) }),
      moves: [],
      attempts: [workStatus({ attempt: 3, createdAt: 30, state: "failed" }), workStatus({ attempt: 4, createdAt: 40 })],
      rounds: [round, retry],
      switches: [],
    });
    const html = text(
      renderToString(
        <TicketView
          detail={detail}
          known={new Map()}
          actions={{ stop: () => Promise.resolve(true), reassign: () => Promise.resolve(true), message: () => Promise.resolve(true), review: () => Promise.resolve(true), machines: () => Promise.resolve([]) }}
          origin="workbench"
          backHref="/workbench"
          back={() => undefined}
          ticketHref={(id) => `/tickets/${id}`}
          openTicket={() => undefined}
          now={50}
        />,
      ),
    );
    expect(html).toContain("第 2 轮引导");
    expect(html).toContain("没有交回合格的结果");
    expect(html).toContain("让 greet 返回 hello");
    expect(html).toContain("大脑让它重试，不计轮次");
    expect(html).toContain("从分支上重新开始");
    expect(html).toContain("第 2 轮");
  });
});
