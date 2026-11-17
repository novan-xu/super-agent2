import { describe, expect, it } from "vitest";
import { cursorAt, foldedText, isInHistory, matchesTerms, newerPosition, normalisedQuery, positionOfCursor, searchedTexts, searchTerms, TicketHistory } from "./history.js";
import { Ticket } from "./tickets.js";

const base = Ticket.parse({
  id: 1,
  repository: "novan-xu/garden-notes",
  issues: [
    {
      repository: "novan-xu/garden-notes",
      number: 7,
      url: "https://github.com/novan-xu/garden-notes/issues/7",
      title: { en: "Parse relative dates", zh: "解析相对日期" },
      summary: { en: "Words like tomorrow", zh: "把明天这样的词变成日期" },
    },
  ],
  title: { en: "Parse dates in notes", zh: "解析笔记里的日期" },
  summary: { en: "Dates in notes", zh: "笔记里的日期" },
  kind: "feature",
  difficulty: null,
  difficultyReason: null,
  platform: null,
  brainEngine: null,
  ownerChoice: { machine: null, engine: null, model: null, effort: null },
  state: "merged",
  machine: null,
  engine: null,
  model: null,
  effort: null,
  chosenBy: null,
  chosenAt: null,
  ran: null,
  branch: null,
  pullRequest: null,
  report: null,
  work: null,
  verification: null,
  round: 0,
  freeRetry: false,
  stuck: null,
  waitsFor: [],
  waits: [],
  deployedAt: null,
  beginFailure: null,
  stopReason: null,
  joinedInto: null,
  conversation: null,
  createdAt: 1,
  updatedAt: 5,
  endedAt: 5,
});

describe("the history's cursor", () => {
  it("names the place after which the next page starts, and reads it back", () => {
    expect(cursorAt({ endedAt: 1_700_000_000_000, id: 42 })).toBe("1700000000000.42");
    expect(positionOfCursor("1700000000000.42")).toEqual({ endedAt: 1_700_000_000_000, id: 42 });
  });

  it("refuses anything that is not a cursor", () => {
    for (const given of ["", "1", "1.", ".1", "a.1", "1.2.3", "-1.2", "1.2 ", "99999999999999999.1"]) {
      expect(positionOfCursor(given)).toBeUndefined();
    }
  });

  it("orders newer endings first, and the later ticket first when two ended together", () => {
    const positions = [
      { endedAt: 5, id: 1 },
      { endedAt: 9, id: 2 },
      { endedAt: 5, id: 3 },
    ];
    expect([...positions].sort(newerPosition)).toEqual([
      { endedAt: 9, id: 2 },
      { endedAt: 5, id: 3 },
      { endedAt: 5, id: 1 },
    ]);
  });

  it("is part of a page of tickets", () => {
    expect(TicketHistory.parse({ tickets: [base], next: "5.1" }).next).toBe("5.1");
    expect(TicketHistory.safeParse({ tickets: [], next: "later" }).success).toBe(false);
  });
});

describe("which tickets are in the history", () => {
  it("are those that ended, other than the ones joined into another", () => {
    expect(isInHistory(base)).toBe(true);
    expect(isInHistory({ ...base, state: "delivered" })).toBe(true);
    expect(isInHistory({ ...base, state: "stopped" })).toBe(true);
    expect(isInHistory({ ...base, state: "stopped", joinedInto: 2 })).toBe(false);
    expect(isInHistory({ ...base, state: "working", endedAt: null })).toBe(false);
    expect(isInHistory({ ...base, endedAt: null })).toBe(false);
  });
});

describe("the words of a search", () => {
  it("split on any space, including the wide one Chinese input produces", () => {
    expect(searchTerms("  解析　日期  notes\tdates\n")).toEqual(["解析", "日期", "notes", "dates"]);
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms(" 　 ")).toEqual([]);
  });

  it("keep Chinese as written, with no word boundaries to find", () => {
    expect(searchTerms("相对日期")).toEqual(["相对日期"]);
  });

  it("drop a word given twice, ignoring the case of ASCII letters, and keep at most eight", () => {
    expect(searchTerms("Notes notes NOTES")).toEqual(["Notes"]);
    expect(searchTerms("a b c d e f g h i j")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("fold only ASCII letters", () => {
    expect(foldedText("Parse ÀÉ Dates")).toBe("parse ÀÉ dates");
    expect(normalisedQuery("  Notes   日期 ")).toBe("Notes 日期");
  });
});

describe("what a search looks through", () => {
  it("is the ticket's title and summary, its repository and each issue's title and summary, in both languages", () => {
    expect(searchedTexts(base)).toEqual([
      "解析笔记里的日期",
      "Parse dates in notes",
      "笔记里的日期",
      "Dates in notes",
      "novan-xu/garden-notes",
      "解析相对日期",
      "Parse relative dates",
      "把明天这样的词变成日期",
      "Words like tomorrow",
    ]);
  });

  it("finds a word from an issue's text in either language, and a repository by a part of its name", () => {
    expect(matchesTerms(base, ["明天"])).toBe(true);
    expect(matchesTerms(base, ["TOMORROW"])).toBe(true);
    expect(matchesTerms(base, ["garden"])).toBe(true);
    expect(matchesTerms(base, ["novan-xu/garden-notes"])).toBe(true);
  });

  it("wants every word, each in some text of the ticket, and never one spread over two texts", () => {
    expect(matchesTerms(base, ["明天", "garden"])).toBe(true);
    expect(matchesTerms(base, ["明天", "missing"])).toBe(false);
    expect(matchesTerms(base, ["notesParse"])).toBe(false);
    expect(matchesTerms(base, [])).toBe(true);
  });
});
