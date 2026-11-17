import { z } from "zod";
import { TicketId, type TicketState, type TicketWait } from "./tickets.js";

export interface ChainNode {
  readonly id: number;
  readonly state: TicketState;
  readonly waits: readonly TicketWait[];
  readonly deployedAt: number | null;
}

export type ChainIndex<Node extends ChainNode = ChainNode> = ReadonlyMap<number, Node>;

export function indexOf<Node extends ChainNode>(tickets: readonly Node[]): Map<number, Node> {
  return new Map(tickets.map((ticket) => [ticket.id, ticket]));
}

export function waitMet(wait: TicketWait, before: ChainNode | undefined): boolean {
  if (wait.waived) {
    return true;
  }
  if (before === undefined || before.state !== "merged") {
    return false;
  }
  return !wait.deployment || before.deployedAt !== null;
}

export function unmetWaits(ticket: ChainNode, index: ChainIndex): TicketWait[] {
  return ticket.waits.filter((wait) => !waitMet(wait, index.get(wait.ticket)));
}

export function readyToBegin(ticket: ChainNode, index: ChainIndex): boolean {
  return unmetWaits(ticket, index).length === 0;
}

export function pendingBefore(ticket: ChainNode, index: ChainIndex): number[] {
  return ticket.waits.filter((wait) => !wait.waived && index.get(wait.ticket)?.state === "pending").map((wait) => wait.ticket);
}

export function canStartAlone(ticket: ChainNode, index: ChainIndex): boolean {
  return ticket.state === "pending" && pendingBefore(ticket, index).length === 0;
}

export function findCycle(edges: ReadonlyMap<number, readonly number[]>): number[] | undefined {
  const done = new Set<number>();
  const path: number[] = [];
  const onPath = new Set<number>();
  const visit = (node: number): number[] | undefined => {
    if (onPath.has(node)) {
      return [...path.slice(path.indexOf(node)), node];
    }
    if (done.has(node)) {
      return undefined;
    }
    onPath.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    path.pop();
    onPath.delete(node);
    done.add(node);
    return undefined;
  };
  for (const node of [...edges.keys()].sort((a, b) => a - b)) {
    const cycle = visit(node);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
}

export function waitEdges(tickets: readonly ChainNode[]): Map<number, number[]> {
  return new Map(tickets.map((ticket) => [ticket.id, ticket.waits.filter((wait) => !wait.waived).map((wait) => wait.ticket)]));
}

export function arrangedAfter(roots: readonly number[], tickets: readonly ChainNode[]): number[] {
  const index = indexOf(tickets);
  const chosen = new Set(roots.filter((root) => index.get(root)?.state === "pending"));
  let grew = true;
  while (grew) {
    grew = false;
    for (const ticket of tickets) {
      if (ticket.state !== "pending" || chosen.has(ticket.id)) {
        continue;
      }
      const before = pendingBefore(ticket, index);
      if (before.length > 0 && before.every((id) => chosen.has(id))) {
        chosen.add(ticket.id);
        grew = true;
      }
    }
  }
  return inWorkingOrder([...chosen], index);
}

export function inWorkingOrder(ids: readonly number[], index: ChainIndex): number[] {
  const wanted = new Set(ids);
  const placed = new Set<number>();
  const order: number[] = [];
  const place = (id: number, seen: Set<number>) => {
    if (placed.has(id) || seen.has(id)) {
      return;
    }
    seen.add(id);
    for (const wait of index.get(id)?.waits ?? []) {
      if (wanted.has(wait.ticket)) {
        place(wait.ticket, seen);
      }
    }
    placed.add(id);
    order.push(id);
  };
  for (const id of [...wanted].sort((a, b) => a - b)) {
    place(id, new Set());
  }
  return order;
}

export function startGaps(selected: readonly number[], index: ChainIndex): number[] {
  const chosen = new Set(selected);
  const gaps = new Set<number>();
  for (const id of selected) {
    const ticket = index.get(id);
    if (ticket === undefined || ticket.state !== "pending") {
      gaps.add(id);
      continue;
    }
    for (const before of pendingBefore(ticket, index)) {
      if (!chosen.has(before)) {
        gaps.add(before);
      }
    }
  }
  return [...gaps].sort((a, b) => a - b);
}

export const ChainStartItem = z.object({
  ticket: TicketId,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ChainStartItem = z.infer<typeof ChainStartItem>;

export const ChainStart = z.object({
  chains: z.array(ChainStartItem).min(1).max(200),
});
export type ChainStart = z.infer<typeof ChainStart>;
