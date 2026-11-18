import type { ConversationEntry, StreamEntry, TextEntry, Turn } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { ConversationState } from "./conversation.js";
import { streamItems } from "./stream.js";
import { initialTopicStream, receiveStream, resumeStream } from "./topic-stream.js";

const id = "c1";
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();
const now = at(17, 12);

function turn(fields: Partial<Turn> = {}): Turn {
  return { id: "t1", conversation: id, provider: "claude", model: "m", state: "completed", reason: null, startedAt: at(17, 9), endedAt: at(17, 10), ...fields };
}

function owner(seq: number, time: number): ConversationEntry {
  return { id: `o${seq}`, conversation: id, seq, at: time, kind: "owner", text: "hi", attachments: [], taken: true };
}

function text(seq: number, time: number, turnId = "t1"): TextEntry {
  return { id: `x${seq}`, conversation: id, seq, at: time, kind: "text", turn: turnId, text: "a" };
}

function tool(seq: number, time: number, state: "running" | "done" = "done"): ConversationEntry {
  return { id: `k${seq}`, conversation: id, seq, at: time, kind: "tool", turn: "t1", name: "run", input: "ls", output: "", state };
}

function state(entries: ConversationEntry[], turns: Turn[], working = false): ConversationState {
  return {
    id,
    conversation: { id, title: "", state: working ? "working" : "idle", topicState: "active", repository: null, provider: null, createdAt: 0, updatedAt: 0 },
    turns,
    entries,
  };
}

describe("streamItems", () => {
  it("marks days and leads each run of the brain's work once", () => {
    const items = streamItems(state([owner(1, at(16, 9)), owner(2, at(17, 9)), text(3, at(17, 9)), tool(4, at(17, 9)), text(5, at(17, 9))], [turn()]), now);
    expect(items.map((item) => (item.kind === "entry" ? `${item.key}${item.lead ? "*" : ""}` : item.kind === "day" ? item.day.relative : item.kind))).toEqual([
      "yesterday",
      "o1",
      "today",
      "o2",
      "x3*",
      "x5",
    ]);
  });

  it("names an older day by its date", () => {
    const [first] = streamItems(state([owner(1, at(3, 9))], []), now);
    expect(first).toMatchObject({ kind: "day", day: { year: 2026, month: 11, day: 3, relative: null } });
  });

  it("shows where a turn was interrupted or failed", () => {
    const stopped = turn({ state: "interrupted", reason: "r" });
    const failed = turn({ id: "t2", state: "failed", reason: "none", startedAt: at(17, 11) });
    const items = streamItems(state([owner(1, at(17, 9)), text(2, at(17, 9)), owner(3, at(17, 11)), owner(4, at(17, 12))], [stopped, failed]), now);
    expect(items.filter((item) => item.kind !== "day").map((item) => item.key)).toEqual(["o1", "x2", "ended-t1", "o3", "ended-t2", "o4"]);
  });

  it("shows one status while working, including during streamed text", () => {
    const running = turn({ state: "running", endedAt: null });
    const writing = streamItems(state([owner(1, at(17, 9)), text(2, at(17, 9))], [running], true), now);
    expect(writing.find((item) => item.key === "x2")).toMatchObject({ kind: "entry", live: true });
    expect(writing.at(-1)).toMatchObject({ kind: "status", tool: null });
    const thinking = streamItems(state([owner(1, at(17, 9)), tool(2, at(17, 9))], [running], true), now);
    expect(thinking.at(-1)).toMatchObject({ kind: "status", tool: null });
    const active = streamItems(state([tool(1, at(17, 9), "running"), tool(2, at(17, 9), "running")], [running], true), now);
    expect(active.filter((item) => item.kind === "status")).toEqual([{ kind: "status", key: "status", tool: tool(2, at(17, 9), "running") }]);
    expect(active.some((item) => item.kind === "entry")).toBe(false);
    const idle = streamItems(state([tool(1, at(17, 9), "running")], [turn()]), now);
    expect(idle.some((item) => item.kind === "status")).toBe(false);
  });

  it.each(["interrupted", "failed"] as const)("keeps the %s ending after a hidden tool", (endState) => {
    const items = streamItems(state([owner(1, at(17, 9)), text(2, at(17, 9)), tool(3, at(17, 9), "running"), owner(4, at(17, 11))], [turn({ state: endState })]), now);
    expect(items.filter((item) => item.kind !== "day").map((item) => item.key)).toEqual(["o1", "x2", "ended-t1", "o4"]);
    expect(items.some((item) => item.kind === "status")).toBe(false);
  });

  it("ignores hidden tools when deciding which text needs a header", () => {
    const items = streamItems(state([tool(1, at(17, 9)), text(2, at(17, 9)), tool(3, at(17, 9)), text(4, at(17, 9)), text(5, at(17, 9), "t2")], [turn()]), now);
    expect(items.filter((item) => item.kind === "entry").map((item) => [item.key, item.lead])).toEqual([["x2", true], ["x4", false], ["x5", true]]);
  });
});

it("replays unfinished text across topics without changing position or duplicating deltas", () => {
  const time = at(17, 9);
  const item = (position: number, entry: ConversationEntry): StreamEntry => ({
    position, entry, topic: { id: entry.conversation, title: entry.conversation, repository: null },
  });
  const first = item(5, text(2, time));
  const second = item(6, { ...owner(1, time), conversation: "c2" });
  const running = turn({ state: "running", endedAt: null });
  const page = receiveStream(initialTopicStream, { type: "stream.page", entries: [first, second], turns: [running], before: 5 });
  expect(resumeStream(page)).toBe(4);
  const delta = { type: "delta", conversation: id, entry: first.entry.id, field: "text", text: "b" } as const;
  const streamed = receiveStream(page, delta);
  expect(streamed.entries[0]?.entry).toMatchObject({ text: "ab" });
  const finished = receiveStream(streamed, { type: "turn", turn: turn() });
  const replay = receiveStream(finished, { ...item(5, { ...text(2, time), text: "ab" }), type: "stream.entry" });
  const older = receiveStream(replay, { type: "stream.page", entries: [item(4, owner(1, time))], turns: [], before: null });
  expect(older.entries.map(({ position }) => position)).toEqual([4, 5, 6]);
  expect(older.entries[1]?.entry).toMatchObject({ text: "ab" });
  expect(resumeStream(older)).toBe(6);
});
