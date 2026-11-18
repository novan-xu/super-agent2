import type { Ticket, TicketHistory } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { ticket } from "./fixtures.js";
import {
  canLoadMore,
  type HistoryState,
  historyLine,
  initialHistory,
  matchNote,
  moreFailed,
  moreStarted,
  needsCatchUp,
  pageFailed,
  receiveEnded,
  receiveMore,
  receivePage,
  startLoading,
  typeQuery,
} from "./history.js";
import { initialPage, pageReducer } from "./page.js";

function ended(id: number, at: number, overrides: Partial<Ticket> = {}): Ticket {
  return ticket(id, { state: "merged", updatedAt: at, endedAt: at, ...overrides });
}

function page(tickets: readonly Ticket[], next: string | null = null): TicketHistory {
  return { tickets: [...tickets], next };
}

const ids = (state: HistoryState) => state.tickets.map((entry) => entry.id);

function loaded(tickets: readonly Ticket[], next: string | null = null, query = ""): HistoryState {
  const typed = typeQuery(initialHistory, query);
  return receivePage(startLoading(typed), typed.applied, page(tickets, next));
}

describe("the history's first page", () => {
  it("starts unknown, then loads, then shows what the hub sent", () => {
    expect(initialHistory.status).toBe("idle");
    const loading = startLoading(initialHistory);
    expect(loading.status).toBe("loading");
    expect(startLoading(loading)).toBe(loading);
    const state = receivePage(loading, "", page([ended(2, 5000), ended(1, 3000)], "3000.1"));
    expect(state).toMatchObject({ status: "ready", next: "3000.1", stale: false });
    expect(ids(state)).toEqual([2, 1]);
  });

  it("can fail, and is read again when asked", () => {
    const failed = pageFailed(startLoading(initialHistory), "");
    expect(failed.status).toBe("failed");
    expect(startLoading(failed).status).toBe("loading");
    expect(pageFailed(initialHistory, "")).toBe(initialHistory);
  });
});

describe("the search box", () => {
  it("changes the list at once when the words change, and keeps the old list on screen until the answer comes", () => {
    const before = loaded([ended(2, 2000), ended(1, 1000)]);
    const typing = typeQuery(before, "日期");
    expect(typing).toMatchObject({ query: "日期", applied: "日期", stale: true, status: "loading" });
    expect(ids(typing)).toEqual([2, 1]);
    expect(canLoadMore(typing)).toBe(false);
  });

  it("does not ask again for a change in spacing or in the case of the words", () => {
    const before = receivePage(typeQuery(initialHistory, "Notes 日期"), "Notes 日期", page([ended(1, 1000)]));
    const again = typeQuery(before, "  Notes   日期 ");
    expect(again).toMatchObject({ query: "  Notes   日期 ", applied: "Notes 日期", stale: false, status: "ready" });
    expect(typeQuery(again, again.query)).toBe(again);
  });

  it("replaces the list with the answer, and drops an answer to words that are no longer in the box", () => {
    const before = loaded([ended(2, 2000), ended(1, 1000)]);
    const typing = typeQuery(before, "日期");
    expect(receivePage(typing, "", page([ended(9, 9000)]))).toBe(typing);
    const answered = receivePage(typing, "日期", page([ended(1, 1000)]));
    expect(ids(answered)).toEqual([1]);
    expect(answered).toMatchObject({ status: "ready", stale: false });
  });

  it("answers no result with an empty, settled list", () => {
    const answered = receivePage(typeQuery(loaded([ended(1, 1000)]), "没有"), "没有", page([]));
    expect(answered).toMatchObject({ status: "ready", applied: "没有", tickets: [] });
  });

  it("goes back to the whole list when the box is emptied", () => {
    const searched = receivePage(typeQuery(loaded([ended(2, 2000), ended(1, 1000)]), "x"), "x", page([]));
    const cleared = typeQuery(searched, "");
    expect(cleared).toMatchObject({ applied: "", stale: true, status: "loading" });
    expect(ids(receivePage(cleared, "", page([ended(2, 2000), ended(1, 1000)])))).toEqual([2, 1]);
  });
});

describe("the next page", () => {
  it("is added after the pages already read, without repeating a ticket", () => {
    const first = loaded([ended(5, 5000), ended(4, 4000)], "4000.4");
    expect(canLoadMore(first)).toBe(true);
    const asked = moreStarted(first);
    expect(asked.more).toBe("loading");
    expect(canLoadMore(asked)).toBe(false);
    const next = receiveMore(asked, "", "4000.4", page([ended(4, 4000), ended(3, 3000), ended(2, 2000)], "2000.2"));
    expect(ids(next)).toEqual([5, 4, 3, 2]);
    expect(next).toMatchObject({ next: "2000.2", more: "idle" });
    const last = receiveMore(next, "", "2000.2", page([ended(1, 1000)]));
    expect(last).toMatchObject({ next: null });
    expect(canLoadMore(last)).toBe(false);
  });

  it("is ignored when the words, or the place it was asked from, have changed since", () => {
    const first = loaded([ended(5, 5000)], "5000.5");
    expect(receiveMore(first, "日期", "5000.5", page([ended(1, 1000)]))).toBe(first);
    expect(receiveMore(first, "", "1.1", page([ended(1, 1000)]))).toBe(first);
    expect(receiveMore(typeQuery(first, "x"), "x", "5000.5", page([ended(1, 1000)]))).toMatchObject({ stale: true });
  });

  it("can fail and be asked for again", () => {
    const failed = moreFailed(moreStarted(loaded([ended(5, 5000)], "5000.5")), "");
    expect(failed.more).toBe("failed");
    expect(canLoadMore(failed)).toBe(true);
    expect(moreFailed(failed, "")).toBe(failed);
  });
});

describe("a page read again to catch up", () => {
  it("adds what ended meanwhile and keeps the pages already read", () => {
    const state = loaded([ended(3, 3000), ended(2, 2000), ended(1, 1000)], "1000.1");
    const caught = receivePage(state, "", page([ended(4, 4000), ended(3, 3000)], "3000.3"));
    expect(ids(caught)).toEqual([4, 3, 2, 1]);
    expect(caught.next).toBe("1000.1");
  });

  it("starts over when so much ended that the newest page does not reach the list", () => {
    const state = loaded([ended(3, 3000), ended(2, 2000)], "2000.2");
    const caught = receivePage(state, "", page([ended(9, 9000), ended(8, 8000)], "8000.8"));
    expect(ids(caught)).toEqual([9, 8]);
    expect(caught.next).toBe("8000.8");
  });

  it("settles on the end of the list when the whole list fits in the page", () => {
    const state = loaded([ended(2, 2000)], "2000.2");
    const caught = receivePage(state, "", page([ended(3, 3000), ended(2, 2000)]));
    expect(ids(caught)).toEqual([3, 2]);
    expect(caught.next).toBeNull();
  });

  it("takes the newer copy of a ticket", () => {
    const state = loaded([ended(2, 2000)]);
    const caught = receivePage(state, "", page([ended(2, 2000, { updatedAt: 7000, deployedAt: 7000 })]));
    expect(caught.tickets[0]?.updatedAt).toBe(7000);
  });
});

describe("a ticket that ends while the list is open", () => {
  it("is put first, at once", () => {
    const state = loaded([ended(2, 2000), ended(1, 1000)]);
    const next = receiveEnded(state, ended(3, 3000));
    expect(ids(next)).toEqual([3, 2, 1]);
  });

  it("is put where its time puts it, and not twice", () => {
    const state = loaded([ended(3, 3000), ended(1, 1000)]);
    const middle = receiveEnded(state, ended(2, 2000));
    expect(ids(middle)).toEqual([3, 2, 1]);
    expect(ids(receiveEnded(middle, ended(2, 2000)))).toEqual([3, 2, 1]);
  });

  it("takes a later change to a ticket already listed, without moving it", () => {
    const state = loaded([ended(3, 3000), ended(2, 2000)]);
    const changed = receiveEnded(state, ended(2, 2000, { updatedAt: 8000 }));
    expect(ids(changed)).toEqual([3, 2]);
    expect(changed.tickets[1]?.updatedAt).toBe(8000);
    expect(receiveEnded(changed, ended(2, 2000, { updatedAt: 5000 }))).toBe(changed);
  });

  it("is not listed while it is still open, or when it was joined into another", () => {
    const state = loaded([ended(1, 1000)]);
    expect(receiveEnded(state, ticket(2, { state: "working" }))).toBe(state);
    expect(receiveEnded(state, ended(2, 2000, { state: "stopped", joinedInto: 1 }))).toBe(state);
  });

  it("is left for the page read later when it is older than the pages read so far, and more remain", () => {
    const state = loaded([ended(5, 5000), ended(4, 4000)], "4000.4");
    expect(receiveEnded(state, ended(2, 2000))).toBe(state);
    expect(ids(receiveEnded(loaded([ended(5, 5000), ended(4, 4000)]), ended(2, 2000)))).toEqual([5, 4, 2]);
  });

  it("is ignored before the list was ever opened, and while the list shown is for other words", () => {
    expect(receiveEnded(initialHistory, ended(1, 1000))).toBe(initialHistory);
    const typing = typeQuery(loaded([ended(1, 1000)]), "x");
    expect(receiveEnded(typing, ended(2, 2000))).toBe(typing);
  });

  it("is not put into a search it cannot be checked against, but makes the page ask the hub", () => {
    const searching = loaded([ended(1, 1000)], null, "日期");
    const incoming = ended(2, 2000);
    expect(receiveEnded(searching, incoming)).toBe(searching);
    expect(needsCatchUp(searching, incoming)).toBe(true);
    expect(needsCatchUp(searching, ended(1, 1000))).toBe(false);
    expect(needsCatchUp(searching, ticket(3, { state: "working" }))).toBe(false);
    expect(needsCatchUp(loaded([ended(1, 1000)]), incoming)).toBe(false);
    expect(needsCatchUp(loaded([ended(5, 5000)], "5000.5", "日期"), incoming)).toBe(false);
    expect(needsCatchUp(typeQuery(searching, "x"), incoming)).toBe(false);
    expect(needsCatchUp(initialHistory, incoming)).toBe(false);
  });
});

describe("a ticket's ending, through the page", () => {
  it("shows in the history and leaves the open tickets in one change", () => {
    let state = pageReducer(initialPage, { type: "server", message: { type: "tickets", tickets: [ticket(1, { state: "verifying" }), ticket(2, { state: "working" })], reviews: [] } });
    state = pageReducer(state, { type: "history.loading" });
    state = pageReducer(state, { type: "history.page", applied: "", page: page([ended(9, 900)]) });
    expect(state.tickets.open.map((entry) => entry.id)).toEqual([2, 1]);
    const merged = ended(1, 5000);
    const after = pageReducer(state, { type: "server", message: { type: "ticket", ticket: merged } });
    expect(after.tickets.open.map((entry) => entry.id)).toEqual([2]);
    expect(ids(after.history)).toEqual([1, 9]);
  });

  it("goes through the actions of the controller", () => {
    let state = pageReducer(initialPage, { type: "history.query", query: "日期" });
    expect(state.history).toMatchObject({ query: "日期", status: "loading", stale: true });
    state = pageReducer(state, { type: "history.page", applied: "日期", page: page([ended(3, 3000)], "3000.3") });
    state = pageReducer(state, { type: "history.more.started" });
    state = pageReducer(state, { type: "history.more.failed", applied: "日期" });
    expect(state.history.more).toBe("failed");
    state = pageReducer(state, { type: "history.more", applied: "日期", before: "3000.3", page: page([ended(2, 2000)]) });
    expect(ids(state.history)).toEqual([3, 2]);
    state = pageReducer(state, { type: "history.query", query: "x" });
    state = pageReducer(state, { type: "history.failed", applied: "x" });
    expect(state.history.status).toBe("failed");
  });
});

describe("what a row says", () => {
  it("says merged and delivered by themselves", () => {
    expect(historyLine(ended(1, 1000))).toEqual({ how: "merged", reason: null });
    expect(historyLine(ended(1, 1000, { state: "delivered", kind: "writing", repository: null }))).toEqual({ how: "delivered", reason: null });
  });

  it("says why a ticket was stopped, in Chinese, when the hub recorded it", () => {
    expect(historyLine(ended(1, 1000, { state: "stopped", stopReason: { en: "The owner stopped it", zh: "你停止了它" } }))).toEqual({ how: "stopped", reason: "你停止了它" });
    expect(historyLine(ended(1, 1000, { state: "stopped", stopReason: { en: "Superseded", zh: " 被新的安排取代 " } }))).toEqual({ how: "stopped", reason: "被新的安排取代" });
  });

  it("says only that it stopped when no reason was recorded", () => {
    expect(historyLine(ended(1, 1000, { state: "stopped" }))).toEqual({ how: "stopped", reason: null });
    expect(historyLine(ended(1, 1000, { state: "stopped", stopReason: { en: "x", zh: "  " } }))).toEqual({ how: "stopped", reason: null });
  });
});

describe("why a ticket matched", () => {
  const found = ended(1, 1000, {
    title: { en: "Parse dates in notes", zh: "解析笔记里的日期" },
    summary: { en: "Dates in notes", zh: "笔记里的日期" },
    issues: [
      {
        repository: "novan-xu/super-agent-sandbox",
        number: 7,
        url: "https://github.com/novan-xu/super-agent-sandbox/issues/7",
        title: { en: "Parse relative dates", zh: "解析相对日期" },
        summary: { en: "Words like tomorrow become dates", zh: "把明天这样的词变成日期" },
      },
    ],
  });

  it("says nothing when the title or the repository already shows it", () => {
    expect(matchNote(found, "日期")).toBeNull();
    expect(matchNote(found, "sandbox")).toBeNull();
    expect(matchNote(found, "")).toBeNull();
  });

  it("shows the words from an issue's text that the title does not hold", () => {
    expect(matchNote(found, "明天")).toBe("把明天这样的词变成日期");
    expect(matchNote(found, "TOMORROW")).toBe("Words like tomorrow become dates");
    expect(matchNote(found, "相对")).toBe("解析相对日期");
  });

  it("looks for the first word that is not already shown", () => {
    expect(matchNote(found, "日期 明天")).toBe("把明天这样的词变成日期");
  });

  it("cuts a long text down to the place where the word is", () => {
    const long = `${"前".repeat(80)}目标词${"后".repeat(80)}`;
    const note = matchNote(ended(1, 1000, { issues: [{ ...found.issues[0]!, summary: { en: "x", zh: long } }] }), "目标词");
    expect(note).toBe(`…${"前".repeat(28)}目标词${"后".repeat(29)}…`);
    expect(Array.from(note ?? "").length).toBeLessThanOrEqual(62);
  });

  it("says nothing for a word that is nowhere in what a ticket carries, as a writing ticket's task is", () => {
    expect(matchNote(found, "garden")).toBeNull();
  });
});
