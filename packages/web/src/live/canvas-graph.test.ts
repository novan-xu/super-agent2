import { describe, expect, it } from "vitest";
import { graphOf } from "./canvas-graph.js";
import { canvasOf } from "./canvas.js";
import { ticket } from "./fixtures.js";

describe("workbench graph lanes", () => {
  it.each([
    { shape: "a line", after: [[], [1], [2]], order: [1, 2, 3], lanes: [0, 0, 0], width: 1 },
    { shape: "a fork", after: [[], [1], [1]], order: [1, 2, 3], lanes: [0, 0, 1], width: 2 },
    { shape: "a merge", after: [[], [1], [], [2, 3], [4]], order: [1, 3, 2, 4, 5], lanes: [0, 1, 0, 0, 0], width: 2 },
    { shape: "a fork then a merge", after: [[], [1], [2], [2], [3, 4]], order: [1, 2, 3, 4, 5], lanes: [0, 0, 0, 1, 0], width: 2 },
    { shape: "two roots merging", after: [[], [], [1, 2]], order: [1, 2, 3], lanes: [0, 1, 0], width: 2 },
    { shape: "a lane reused after a dead end", after: [[], [1], [1], [2], [4], [4]], order: [1, 2, 3, 4, 5, 6], lanes: [0, 0, 1, 0, 0, 1], width: 2 },
    { shape: "a shortcut across another row", after: [[], [1], [1, 2]], order: [1, 2, 3], lanes: [0, 0, 0], width: 2 },
  ])("assigns lanes and preserves the dependencies for $shape", ({ after, order, lanes, width }) => {
    const tickets = after.map((ids, index) => ticket(index + 1, { waits: ids.map((id) => ({ ticket: id, deployment: false, waived: false })) }));
    const chain = canvasOf(tickets.reverse(), undefined).ready[0]!;
    const graph = graphOf(chain);
    expect(graph.lanes).toBe(width);
    expect(graph.rows.map((row) => row.node.ticket.id)).toEqual(order);
    expect(graph.rows.map((row) => row.lane)).toEqual(lanes);

    const edges = graph.rows.flatMap((row) => row.outgoing);
    const pairs = after.flatMap((ids, index) => ids.map((id) => [id, index + 1]));
    expect(edges.map(({ from, to }) => [from, to]).sort()).toEqual(pairs.sort());
    for (const [index, { node, incoming, passing, outgoing }] of graph.rows.entries()) {
      expect(incoming).toEqual(edges.filter((edge) => edge.to === node.ticket.id));
      expect(passing).toEqual(edges.filter((edge) => order.indexOf(edge.from) < index && order.indexOf(edge.to) > index));
      expect(new Set([...passing, ...outgoing].map((edge) => edge.lane)).size).toBe(passing.length + outgoing.length);
    }
  });
});
