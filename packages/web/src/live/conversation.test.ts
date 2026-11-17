import type { Conversation, ConversationEntry, OwnerEntry, ServerMessage, ToolEntry, Turn } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { type ConversationState, emptyConversation, isWorking, receive, receiveDetail, receiveOwn, resumeAfter } from "./conversation.js";

const id = "c1";

function conversation(fields: Partial<Conversation> = {}): Conversation {
  return { id, title: "t", state: "idle", provider: null, createdAt: 1, updatedAt: 1, ...fields };
}

function turn(fields: Partial<Turn> = {}): Turn {
  return { id: "t1", conversation: id, provider: "claude", model: "m", state: "running", reason: null, startedAt: 10, endedAt: null, ...fields };
}

function owner(seq: number, fields: Partial<OwnerEntry> = {}): OwnerEntry {
  return { id: `o${seq}`, conversation: id, seq, at: seq, kind: "owner", text: "hi", taken: true, ...fields };
}

function textEntry(seq: number, text: string, turnId = "t1"): ConversationEntry {
  return { id: `x${seq}`, conversation: id, seq, at: seq, kind: "text", turn: turnId, text };
}

function tool(seq: number, fields: Partial<ToolEntry> = {}): ConversationEntry {
  return { id: `k${seq}`, conversation: id, seq, at: seq, kind: "tool", turn: "t1", name: "run_command", input: "ls", output: "", state: "running", ...fields };
}

function apply(state: ConversationState, ...messages: ServerMessage[]): ConversationState {
  return messages.reduce(receive, state);
}

const entry = (value: ConversationEntry): ServerMessage => ({ type: "entry", entry: value });
const delta = (entryId: string, text: string, field: "text" | "output" = "text"): ServerMessage => ({ type: "delta", conversation: id, entry: entryId, field, text });

function texts(state: ConversationState): string[] {
  return state.entries.map((value) => (value.kind === "tool" ? `${value.id}:${value.output}` : `${value.id}:${value.text}`));
}

describe("receive", () => {
  it("grows a text entry delta by delta", () => {
    const state = apply(emptyConversation(id), entry(textEntry(2, "我")), delta("x2", "来"), delta("x2", "查"));
    expect(texts(state)).toEqual(["x2:我来查"]);
  });

  it("grows a tool's output, not its text", () => {
    const state = apply(emptyConversation(id), entry(tool(3)), delta("k3", "a\n", "output"), delta("k3", "ignored", "text"));
    expect(texts(state)).toEqual(["k3:a\n"]);
  });

  it("takes a whole entry as it is, so a snapshot after deltas neither loses nor repeats text", () => {
    const state = apply(emptyConversation(id), entry(textEntry(2, "ab")), delta("x2", "c"), entry(textEntry(2, "abc")), delta("x2", "d"));
    expect(texts(state)).toEqual(["x2:abcd"]);
  });

  it("ignores a delta for an entry it has not seen", () => {
    const state = apply(emptyConversation(id), delta("x9", "lost"));
    expect(state.entries).toEqual([]);
  });

  it("keeps entries in the hub's order whatever order they arrive in", () => {
    const state = apply(emptyConversation(id), entry(textEntry(3, "c")), entry(owner(1)), entry(tool(2)));
    expect(state.entries.map((value) => value.seq)).toEqual([1, 2, 3]);
  });

  it("ignores what belongs to another conversation", () => {
    const other = { ...textEntry(1, "x"), conversation: "c2" };
    const start = emptyConversation(id);
    const state = apply(
      start,
      entry(other),
      { type: "delta", conversation: "c2", entry: "x1", field: "text", text: "y" },
      { type: "turn", turn: turn({ conversation: "c2" }) },
      { type: "conversation", conversation: conversation({ id: "c2" }) },
      { type: "brain", brain: { linked: true } },
    );
    expect(state).toBe(start);
  });

  it("keeps a finished turn finished when a late running copy arrives", () => {
    const done = turn({ state: "completed", endedAt: 20 });
    const state = apply(emptyConversation(id), { type: "turn", turn: done }, { type: "turn", turn: turn() });
    expect(state.turns).toEqual([done]);
  });

  it("takes the newest conversation", () => {
    const state = apply(
      emptyConversation(id),
      { type: "conversation", conversation: conversation({ state: "working", updatedAt: 5 }) },
      { type: "conversation", conversation: conversation({ state: "idle", updatedAt: 4 }) },
    );
    expect(state.conversation?.state).toBe("working");
  });
});

describe("receiveDetail", () => {
  it("does not let an older reading undo a newer change", () => {
    const live = apply(emptyConversation(id), { type: "conversation", conversation: conversation({ state: "idle", updatedAt: 9 }) }, {
      type: "turn",
      turn: turn({ state: "completed", endedAt: 9 }),
    });
    const state = receiveDetail(live, { conversation: conversation({ state: "working", updatedAt: 8 }), turns: [turn()] });
    expect(state.conversation?.state).toBe("idle");
    expect(state.turns[0]?.state).toBe("completed");
    expect(state).toBe(live);
  });

  it("fills in what the page missed", () => {
    const state = receiveDetail(emptyConversation(id), {
      conversation: conversation({ state: "working", updatedAt: 3 }),
      turns: [turn({ id: "t2", startedAt: 30 }), turn({ state: "completed", startedAt: 10 })],
    });
    expect(state.turns.map((value) => value.id)).toEqual(["t1", "t2"]);
    expect(isWorking(state)).toBe(true);
  });
});

describe("receiveOwn", () => {
  it("adds the owner's message once, whichever of the answer and the socket comes first", () => {
    const sent = owner(4, { taken: false });
    const first = receiveOwn(apply(emptyConversation(id), entry(sent)), sent);
    expect(first.entries).toHaveLength(1);
    const taken = apply(emptyConversation(id), entry({ ...sent, taken: true }));
    const late = receiveOwn(taken, sent);
    expect(late.entries).toEqual([{ ...sent, taken: true }]);
    const early = apply(receiveOwn(emptyConversation(id), sent), entry({ ...sent, taken: true }));
    expect(early.entries).toEqual([{ ...sent, taken: true }]);
  });
});

describe("resumeAfter", () => {
  it("asks for everything after the last entry when all is settled", () => {
    const state = apply(emptyConversation(id), { type: "turn", turn: turn({ state: "completed", endedAt: 5 }) }, entry(owner(1)), entry(textEntry(2, "a")));
    expect(resumeAfter(state)).toBe(2);
  });

  it("asks again for entries that may have changed while the page was away", () => {
    const running = apply(emptyConversation(id), { type: "turn", turn: turn() }, entry(owner(1)), entry(textEntry(2, "a")), entry(tool(3)));
    expect(resumeAfter(running)).toBe(1);
    const untaken = apply(emptyConversation(id), entry(owner(1)), entry(owner(2, { taken: false })), entry(owner(3)));
    expect(resumeAfter(untaken)).toBe(1);
    const unknownTurn = apply(emptyConversation(id), entry(owner(1)), entry(textEntry(2, "a", "t9")));
    expect(resumeAfter(unknownTurn)).toBe(1);
  });

  it("starts from nothing for an empty conversation", () => {
    expect(resumeAfter(emptyConversation(id))).toBe(0);
  });

  it("loses and repeats nothing across a dropped connection", () => {
    const before = apply(
      emptyConversation(id),
      { type: "turn", turn: turn() },
      entry(owner(1)),
      entry(textEntry(2, "我来")),
      delta("x2", "查"),
      entry(tool(3)),
      delta("k3", "one\n", "output"),
    );
    const after = resumeAfter(before);
    const stored = [owner(1), textEntry(2, "我来查。"), tool(3, { output: "one\ntwo\n", state: "done" }), textEntry(4, "好了")];
    const replay = stored.filter((value) => value.seq > after).map(entry);
    const resumed = apply(before, ...replay, delta("x4", "。"));
    expect(texts(resumed)).toEqual(["o1:hi", "x2:我来查。", "k3:one\ntwo\n", "x4:好了。"]);
    expect(resumed.entries.find((value) => value.id === "k3")).toMatchObject({ state: "done" });
  });
});
