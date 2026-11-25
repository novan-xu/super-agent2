import type { CanvasChain, CanvasNode } from "./canvas.js";

export interface GraphEdge {
  readonly from: number;
  readonly to: number;
  readonly lane: number;
}

export interface GraphRow {
  readonly node: CanvasNode;
  readonly lane: number;
  readonly incoming: readonly GraphEdge[];
  readonly passing: readonly GraphEdge[];
  readonly outgoing: readonly GraphEdge[];
}

export function graphOf(chain: CanvasChain): { readonly lanes: number; readonly rows: readonly GraphRow[] } {
  const successors = new Map<number, number[]>();
  for (const node of chain) {
    for (const id of new Set(node.after)) {
      const next = successors.get(id) ?? [];
      next.push(node.ticket.id);
      successors.set(id, next);
    }
  }

  let active: GraphEdge[] = [];
  let lanes = 0;
  const rows = chain.map((node): GraphRow => {
    const id = node.ticket.id;
    const incoming = active.filter((edge) => edge.to === id);
    const passing = active.filter((edge) => edge.to !== id);
    const occupied = new Set(passing.map((edge) => edge.lane));
    const reserve = (preferred = 0) => {
      let lane = preferred;
      while (occupied.has(lane)) lane++;
      occupied.add(lane);
      lanes = Math.max(lanes, lane + 1);
      return lane;
    };
    const lane = reserve(incoming.length === 0 ? 0 : Math.min(...incoming.map((edge) => edge.lane)));
    const outgoing = (successors.get(id) ?? []).map((to, index): GraphEdge => ({ from: id, to, lane: index === 0 ? lane : reserve() }));
    active = [...passing, ...outgoing];
    return { node, lane, incoming, passing, outgoing };
  });
  return { lanes, rows };
}
