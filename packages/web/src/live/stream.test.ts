import type { ConversationEntry, Turn } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { ConversationState } from "./conversation.js";
import { streamItems } from "./stream.js";

const id = "c1";
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();
const now = at(17, 12);

function turn(fields: Partial<Turn> = {}): Turn {
  return { id: "t1", conversation: id, provider: "claude", model: "m", state: "completed", reason: null, startedAt: at(17, 9), endedAt: at(17, 10), ...fields };
}

function owner(seq: number, time: number): ConversationEntry {
  return { id: `o${seq}`, conversation: id, seq, at: time, kind: "owner", text: "hi", taken: true };
}

function text(seq: number, time: number, turnId = "t1"): ConversationEntry {
  return { id: `x${seq}`, conversation: id, seq, at: time, kind: "text", turn: turnId, text: "a" };
}

function tool(seq: number, time: number, state: "running" | "done" = "done"): ConversationEntry {
  return { id: `k${seq}`, conversation: id, seq, at: time, kind: "tool", turn: "t1", name: "run", input: "ls", output: "", state };
}

function state(entries: ConversationEntry[], turns: Turn[], working = false): ConversationState {
  return {
    id,
    conversation: { id, title: "", state: working ? "working" : "idle", provider: null, createdAt: 0, updatedAt: 0 },
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
      "k4",
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

  it("marks the text being written and waits visibly while the brain is busy", () => {
    const running = turn({ state: "running", endedAt: null });
    const writing = streamItems(state([owner(1, at(17, 9)), text(2, at(17, 9))], [running], true), now);
    expect(writing.at(-1)).toMatchObject({ kind: "entry", live: true });
    const thinking = streamItems(state([owner(1, at(17, 9))], [], true), now);
    expect(thinking.at(-1)).toMatchObject({ kind: "typing" });
    const runningTool = streamItems(state([owner(1, at(17, 9)), tool(2, at(17, 9), "running")], [running], true), now);
    expect(runningTool.at(-1)).toMatchObject({ kind: "entry" });
    const stopped = streamItems(state([owner(1, at(17, 9)), tool(2, at(17, 9), "running")], [turn({ state: "interrupted" })]), now);
    expect(stopped.find((item) => item.key === "k2")).toMatchObject({ kind: "entry", live: false });
    const runningCommand = streamItems(state([owner(1, at(17, 9)), tool(2, at(17, 9), "running")], [running], true), now);
    expect(runningCommand.find((item) => item.key === "k2")).toMatchObject({ kind: "entry", live: true });
    const idle = streamItems(state([owner(1, at(17, 9)), text(2, at(17, 9))], [turn()]), now);
    expect(idle.at(-1)).toMatchObject({ kind: "entry", live: false });
  });
});
