import { describe, expect, it } from "vitest";
import { workEvent } from "./fixtures.js";
import { emptyLog, lastEventId, receiveWork } from "./work.js";

describe("a worker's log", () => {
  it("joins the text of one block as it is written", () => {
    const log = receiveWork(emptyLog(1), [
      workEvent(1, { kind: "text", block: "a", delta: "Reading " }),
      workEvent(2, { kind: "text", block: "a", delta: "the issue" }),
    ]);
    expect(log.attempts).toHaveLength(1);
    expect(log.attempts[0]?.items).toEqual([{ kind: "text", key: "1:text:a", at: 10_001, text: "Reading the issue" }]);
  });

  it("folds a command with its output, and takes the finished output when there is one", () => {
    const started = receiveWork(emptyLog(1), [
      workEvent(1, { kind: "tool.started", call: "c1", name: "shell", input: '{"command":"pnpm test"}' }),
      workEvent(2, { kind: "tool.output", call: "c1", delta: "ok 1\n" }),
    ]);
    expect(started.attempts[0]?.items[0]).toMatchObject({ kind: "tool", name: "shell", output: "ok 1\n", state: "running" });
    const done = receiveWork(started, [workEvent(3, { kind: "tool.finished", call: "c1", output: "ok 1\nok 2\n", ok: true })]);
    expect(done.attempts[0]?.items[0]).toMatchObject({ output: "ok 1\nok 2\n", state: "done" });
    const failed = receiveWork(started, [workEvent(3, { kind: "tool.finished", call: "c1", output: null, ok: false })]);
    expect(failed.attempts[0]?.items[0]).toMatchObject({ output: "ok 1\n", state: "failed" });
  });

  it("keeps messages, the ending and each attempt apart", () => {
    const log = receiveWork(emptyLog(1), [
      workEvent(1, { kind: "message", id: "m1", from: "owner", text: "Use tabs", delivery: "steered" }),
      workEvent(2, { kind: "failed", failure: "program", reason: "exit 1" }),
      workEvent(3, { kind: "text", block: "a", delta: "Again" }, { attempt: 2, seq: 1 }),
      workEvent(4, { kind: "finished", pullRequest: 9, url: "https://github.com/o/r/pull/9", report: { en: "Done", zh: "做完了" } }, { attempt: 2, seq: 2 }),
    ]);
    expect(log.attempts.map((attempt) => [attempt.attempt, attempt.ended, attempt.items.map((item) => item.kind)])).toEqual([
      [1, true, ["message", "failed"]],
      [2, true, ["text", "finished"]],
    ]);
  });

  it("shows a delivery's files without their bytes", () => {
    const log = receiveWork(emptyLog(1), [
      workEvent(1, { kind: "delivered", text: "Hello", files: [{ name: "a.txt", size: 3, mediaType: "text/plain" }], report: { en: "Sent", zh: "交了" } }),
    ]);
    expect(log.attempts[0]?.items[0]).toEqual({ kind: "delivered", key: "1:end:1", at: 10_001, text: "Hello", files: [{ name: "a.txt", size: 3 }], report: { en: "Sent", zh: "交了" } });
  });

  it("takes each event once, whether it comes by the socket or by a page of the history", () => {
    const first = receiveWork(emptyLog(1), [workEvent(1, { kind: "text", block: "a", delta: "x" })]);
    const again = receiveWork(first, [workEvent(1, { kind: "text", block: "a", delta: "x" })]);
    expect(again).toBe(first);
    const twice = receiveWork(emptyLog(1), [workEvent(1, { kind: "text", block: "a", delta: "x" }), workEvent(1, { kind: "text", block: "a", delta: "x" })]);
    expect(twice.attempts[0]?.items[0]).toMatchObject({ text: "x" });
  });

  it("puts an older event that arrives late in its place", () => {
    const late = receiveWork(emptyLog(1), [workEvent(3, { kind: "text", block: "a", delta: "c" })]);
    const filled = receiveWork(late, [workEvent(2, { kind: "text", block: "a", delta: "b" }), workEvent(1, { kind: "text", block: "a", delta: "a" })]);
    expect(filled.attempts[0]?.items[0]).toMatchObject({ text: "abc" });
    expect(filled.events.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(lastEventId(filled)).toBe(3);
  });

  it("ignores another ticket's events, and changes nothing for an event it does not show", () => {
    const log = emptyLog(1);
    expect(receiveWork(log, [workEvent(1, { kind: "text", block: "a", delta: "x" }, { ticket: 2 })])).toBe(log);
    const phase = receiveWork(log, [workEvent(1, { kind: "phase", phase: "started", detail: "Started" })]);
    expect(phase.attempts[0]?.items).toEqual([]);
    expect(lastEventId(phase)).toBe(1);
  });

  it("leaves earlier items unchanged when text streams into the last one", () => {
    const log = receiveWork(emptyLog(1), [
      workEvent(1, { kind: "tool.started", call: "c1", name: "shell", input: "ls" }),
      workEvent(2, { kind: "text", block: "b", delta: "a" }),
    ]);
    const next = receiveWork(log, [workEvent(3, { kind: "text", block: "b", delta: "b" })]);
    expect(next.attempts[0]?.items[0]).toBe(log.attempts[0]?.items[0]);
  });
});
