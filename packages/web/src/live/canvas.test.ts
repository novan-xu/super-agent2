import { describe, expect, it } from "vitest";
import { canvasOf } from "./canvas.js";
import { ticket } from "./fixtures.js";

const after = (...ids: number[]) => ids.map((id) => ({ ticket: id, deployment: false, waived: false }));

describe("the workbench canvas", () => {
  it("keeps pending and queued work after its running predecessor", () => {
    const first = ticket(1, { state: "working" });
    const pending = ticket(2, { waitsFor: [1], waits: after(1) });
    const queued = { ...pending, state: "waiting" as const };
    for (const second of [pending, queued]) {
      const canvas = canvasOf([first, second], undefined);
      expect(canvas.running[0]?.map((node) => node.ticket.id)).toEqual([1, 2]);
      expect(canvas.running[0]?.[1]?.after).toEqual([1]);
    }
  });

  it("joins all predecessors and provides a reference across repositories", () => {
    const first = ticket(1, { state: "working", repository: "a/one" });
    const second = ticket(2, { state: "working", repository: "b/two" });
    const third = ticket(3, { repository: "a/one", waitsFor: [1, 2], waits: after(1, 2) });
    const all = canvasOf([first, second, third], undefined).running[0]!;
    expect(all.map((node) => node.ticket.id)).toEqual([1, 2, 3]);
    expect(all[2]?.after).toEqual([1, 2]);
    const scoped = canvasOf([first, second, third], "a/one").running[0]!;
    expect(scoped.find((node) => node.ticket.id === 2)?.reference).toBe(true);
  });

  it("lists tickets by their own repository even when they share a filing topic", () => {
    const conversation = "filing-topic";
    const code = ticket(1, { repository: "a/one", conversation });
    const other = ticket(2, { repository: "b/two", conversation });
    const daily = ticket(3, { repository: null, conversation });
    for (const current of [code, other, daily]) {
      const canvas = canvasOf([code, other, daily], current.repository);
      expect(canvas.ready.flat().map(({ ticket: entry }) => entry.id)).toEqual([current.id]);
    }
  });

  it("puts a chain that asks the owner in 等你 and excludes waived edges", () => {
    const first = ticket(1, { state: "working" });
    const second = ticket(2, { waitsFor: [1], waits: [{ ticket: 1, deployment: false, waived: true }] });
    const canvas = canvasOf([first, second], undefined, new Set([1]));
    expect(canvas.waits[0]?.map((node) => node.ticket.id)).toEqual([1]);
    expect(canvas.ready[0]?.map((node) => node.ticket.id)).toEqual([2]);
  });


});

describe("live workbench updates", () => {
  it("recomputes after work is inserted and started", () => {
    const running = ticket(1, { state: "working" });
    const inserted = ticket(2, { waits: after(1), waitsFor: [1] });
    expect(canvasOf([running], undefined).running[0]?.length).toBe(1);
    expect(canvasOf([running, inserted], undefined).running[0]?.map((node) => node.ticket.state)).toEqual(["working", "pending"]);
    expect(canvasOf([running, { ...inserted, state: "waiting" }], undefined).running[0]?.map((node) => node.ticket.state)).toEqual(["working", "waiting"]);
  });

  it("does not put a pending card after an already satisfied predecessor", () => {
    const pending = ticket(2, { waits: after(1), waitsFor: [1] });
    expect(canvasOf([pending], undefined, new Set(), new Map([[2, []]])).ready[0]?.[0]?.missing).toEqual([]);
  });
});
