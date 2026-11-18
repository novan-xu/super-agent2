import type { BrainInput, Prepared } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { estimateTokens, topicPrompt } from "./seed.js";

const input: BrainInput = {
  id: "next",
  text: "Current owner input",
  source: "owner",
  attachments: [],
  quote: { id: "quoted", item: { kind: "notice", text: "Quoted details" } },
};

const context: Prepared = {
  type: "prepared",
  request: "r",
  session: "saved",
  history: [],
  seed: {
    summary: "Earlier project history",
    olderTurns: 4,
    turns: [
      [{ kind: "owner", text: `Oldest turn ${"A".repeat(800)}`, attachments: [] }],
      [{ kind: "text", provider: "claude", text: `Newest turn ${"B".repeat(160)}` }],
    ],
    tickets: [
      { own: true, line: "#11 This topic's ticket" },
      { own: false, line: `#12 Another topic's ticket ${"T".repeat(760)}` },
    ],
  },
  memory: { first: true, memories: [{ id: 1, text: `Owner's preference ${"M".repeat(500)}` }], pending: [], setAside: [], changes: [] },
  board: [{ id: "other", title: "Another topic", repository: null, state: "active", status: `Current status ${"S".repeat(800)}`, mergedInto: null }],
};

function build(capacity: number, prepared = context, current = input, softShare = 0.15) {
  return topicPrompt({ conversation: "topic", inputs: [current], prepared, capacity, softShare, provider: "gpt", attachments: "/tmp/attachments" }).text;
}

describe("the topic seed", () => {
  it("keeps the quote, history, memory, tickets and board in order with room to spare", () => {
    const result = build(12_000);
    const parts = ["Quoted details", "Earlier project history", "Oldest turn", "Newest turn", "Owner's preference", "#11 This topic's ticket", "#12 Another topic's ticket", "Current status"];
    const positions = parts.map((part) => result.indexOf(part));
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(result).toContain("4 older history turn(s) omitted. Use read_topic_history");
    expect(result.endsWith(input.text)).toBe(true);
  });

  it("uses the model's soft share to omit statuses, older turns, other tickets and memory in order", () => {
    const withoutStatus = build(5_500);
    expect(withoutStatus).toContain("1 topic board status line(s) omitted. Use read_topic_board");
    expect(withoutStatus).toContain("other Another topic");
    expect(withoutStatus).toContain("Oldest turn");

    const withoutOldest = build(4_500);
    expect(withoutOldest).not.toContain("Oldest turn");
    expect(withoutOldest).toContain("5 older history turn(s) omitted. Use read_topic_history");
    expect(withoutOldest).toContain("#12 Another topic's ticket");

    const withoutOtherTicket = build(2_900);
    expect(withoutOtherTicket).toContain("1 other-topic ticket line(s) omitted. Use read_seed_material");
    expect(withoutOtherTicket).toContain("Owner's preference");

    const withoutMemory = build(1_700);
    expect(withoutMemory).toContain('1 confirmed memory item(s) and 0 other memory record(s) omitted. Use read_seed_material with section="memory"');
    for (const required of ["Earlier project history", "Newest turn", "Quoted details", "#11 This topic's ticket", "Current owner input"]) {
      expect(withoutMemory).toContain(required);
    }
    expect(build(1_700, context, input, 0.8)).toContain("Current status");
  });

  it("keeps recent turns when the quote and newest turn already put the prompt over the soft line", () => {
    const quoted = { ...input, quote: { id: "quoted", item: { kind: "notice" as const, text: "quoted context ".repeat(170) } } };
    const result = build(3_500, context, quoted);
    expect(result).toContain("Oldest turn");
    expect(result).toContain("Newest turn");
    expect(result).toContain("quoted context ".repeat(170));
    expect(result).toContain("read_topic_board");
    expect(estimateTokens(result, "gpt")).toBeLessThanOrEqual(3_500);
  });

  it("keeps the newest turn above the soft line, preserves long logs verbatim when they fit, and uses the hard capacity for quotes", () => {
    const log = "trace data ".repeat(450);
    const prepared: Prepared = {
      ...context,
      memory: null,
      board: [],
      seed: { summary: "", olderTurns: 0, tickets: [], turns: [[{ kind: "tool", provider: "gpt", name: "build", input: "build all", output: log }]] },
    };
    const result = build(5_000, prepared);
    expect(result).toContain(log);
    expect(estimateTokens(result, "gpt")).toBeGreaterThan(750);

    const oversized = { ...input, quote: { id: "quoted", item: { kind: "notice" as const, text: "quote ".repeat(4_000) } } };
    const narrowed = build(1_000, prepared, oversized);
    expect(narrowed).toContain('1 quoted message omitted. Use read_topic_history with message="quoted"');
    expect(narrowed).toContain("1 older history turn(s) omitted");
    expect(narrowed.endsWith(input.text)).toBe(true);
    expect(estimateTokens(narrowed, "gpt")).toBeLessThanOrEqual(1_000);
  });
});
