import { describe, expect, it } from "vitest";
import {
  arrangedAfter,
  type ChainNode,
  ChainStart,
  canStartAlone,
  findCycle,
  indexOf,
  inWorkingOrder,
  pendingBefore,
  readyToBegin,
  startGaps,
  unmetWaits,
  waitEdges,
  waitMet,
} from "./chains.js";
import type { TicketState } from "./tickets.js";

function node(id: number, state: TicketState = "pending", after: readonly (number | { ticket: number; deployment?: boolean; waived?: boolean })[] = [], deployedAt: number | null = null): ChainNode {
  return {
    id,
    state,
    deployedAt,
    waits: after.map((entry) =>
      typeof entry === "number" ? { ticket: entry, deployment: false, waived: false } : { ticket: entry.ticket, deployment: entry.deployment ?? false, waived: entry.waived ?? false },
    ),
  };
}

describe("a wait", () => {
  it("is met by a merged ticket, and by nothing short of merged", () => {
    for (const state of ["pending", "waiting", "working", "verifying", "delivered", "stopped"] as const) {
      expect(waitMet({ ticket: 1, deployment: false, waived: false }, node(1, state))).toBe(false);
    }
    expect(waitMet({ ticket: 1, deployment: false, waived: false }, node(1, "merged"))).toBe(true);
  });

  it("for a deployment is met only once the merged ticket is reported deployed", () => {
    const wait = { ticket: 1, deployment: true, waived: false };
    expect(waitMet(wait, node(1, "merged"))).toBe(false);
    expect(waitMet(wait, node(1, "merged", [], 5))).toBe(true);
  });

  it("is met when it was waived, whatever came of the ticket before", () => {
    expect(waitMet({ ticket: 1, deployment: true, waived: true }, node(1, "stopped"))).toBe(true);
    expect(waitMet({ ticket: 1, deployment: false, waived: true }, undefined)).toBe(true);
  });

  it("on a ticket that is not known is not met", () => {
    expect(waitMet({ ticket: 9, deployment: false, waived: false }, undefined)).toBe(false);
  });
});

describe("what can begin", () => {
  it("is a ticket whose waits are all met", () => {
    const index = indexOf([node(1, "merged"), node(2, "working"), node(3, "waiting", [1]), node(4, "waiting", [1, 2])]);
    expect(readyToBegin(node(3, "waiting", [1]), index)).toBe(true);
    expect(readyToBegin(node(4, "waiting", [1, 2]), index)).toBe(false);
    expect(unmetWaits(node(4, "waiting", [1, 2]), index).map((wait) => wait.ticket)).toEqual([2]);
  });

  it("alone is a pending ticket with nothing pending before it", () => {
    const index = indexOf([node(1), node(2, "working"), node(3, "pending", [1]), node(4, "pending", [2])]);
    expect(canStartAlone(node(1), index)).toBe(true);
    expect(canStartAlone(node(3, "pending", [1]), index)).toBe(false);
    expect(canStartAlone(node(4, "pending", [2]), index)).toBe(true);
    expect(canStartAlone(node(2, "working"), index)).toBe(false);
    expect(pendingBefore(node(3, "pending", [1, { ticket: 4, waived: true }]), index)).toEqual([1]);
  });
});

describe("a cycle", () => {
  it("is found and named", () => {
    expect(findCycle(new Map([[1, [2]], [2, [3]], [3, [1]]]))).toEqual([1, 2, 3, 1]);
  });

  it("of one ticket waiting for itself is found", () => {
    expect(findCycle(new Map([[5, [5]]]))).toEqual([5, 5]);
  });

  it("is not seen where two chains wait for the same ticket", () => {
    expect(findCycle(new Map([[1, []], [2, [1]], [3, [1]], [4, [2, 3]]]))).toBeUndefined();
  });

  it("does not count a waived wait", () => {
    expect(findCycle(waitEdges([node(1, "pending", [{ ticket: 2, waived: true }]), node(2, "pending", [1])]))).toBeUndefined();
    expect(findCycle(waitEdges([node(1, "pending", [2]), node(2, "pending", [1])]))).toEqual([1, 2, 1]);
  });
});

describe("what is arranged after a chain", () => {
  const tickets = [
    node(1),
    node(2, "pending", [1]),
    node(3, "pending", [2]),
    node(4),
    node(5, "pending", [1, 4]),
    node(6, "working"),
    node(7, "pending", [6]),
    node(8, "waiting", [1]),
  ];

  it("is every pending ticket behind it, in working order", () => {
    expect(arrangedAfter([1], tickets)).toEqual([1, 2, 3]);
  });

  it("leaves out a ticket that also waits for a pending chain that is not started", () => {
    expect(arrangedAfter([1], tickets)).not.toContain(5);
    expect(arrangedAfter([1, 4], tickets)).toEqual([1, 2, 3, 4, 5]);
  });

  it("is only the chain itself when nothing waits for it", () => {
    expect(arrangedAfter([7], tickets)).toEqual([7]);
  });

  it("is nothing for a ticket that is no longer pending", () => {
    expect(arrangedAfter([6], tickets)).toEqual([]);
  });

  it("puts what comes first first", () => {
    const index = indexOf([node(1, "pending", [3]), node(2), node(3, "pending", [2])]);
    expect(inWorkingOrder([1, 2, 3], index)).toEqual([2, 3, 1]);
  });
});

describe("a start", () => {
  const index = indexOf([node(1), node(2, "pending", [1]), node(3, "working"), node(4, "pending", [3])]);

  it("is whole when everything pending before what it starts is started with it", () => {
    expect(startGaps([1, 2], index)).toEqual([]);
    expect(startGaps([4], index)).toEqual([]);
  });

  it("names the pending tickets it would leave behind, and anything not pending", () => {
    expect(startGaps([2], index)).toEqual([1]);
    expect(startGaps([3], index)).toEqual([3]);
    expect(startGaps([99], index)).toEqual([99]);
  });

  it("names at least one chain and a fingerprint for each", () => {
    expect(ChainStart.safeParse({ chains: [] }).success).toBe(false);
    expect(ChainStart.safeParse({ chains: [{ ticket: 1, fingerprint: "a".repeat(64) }] }).success).toBe(true);
    expect(ChainStart.safeParse({ chains: [{ ticket: 1 }] }).success).toBe(false);
    expect(ChainStart.safeParse({ chains: [{ ticket: 1, fingerprint: "x" }] }).success).toBe(false);
  });
});
