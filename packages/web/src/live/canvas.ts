import { type Ticket, ticketProject } from "@super-agent2/protocol";

export type CanvasSection = "waits" | "running" | "ready" | "later";
export interface CanvasNode {
  readonly ticket: Ticket;
  readonly reference: boolean;
  readonly after: readonly number[];
  readonly missing: readonly number[];
}
export type CanvasChain = readonly CanvasNode[];
export type Canvas = Readonly<Record<CanvasSection, readonly CanvasChain[]>>;

export function canvasOf(tickets: readonly Ticket[], repository: string | null | undefined, asking: ReadonlySet<number> = new Set(), unresolved?: ReadonlyMap<number, readonly number[]>): Canvas {
  const all = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const predecessors = (ticket: Ticket) => {
    const allowed = unresolved?.get(ticket.id);
    return ticket.waits.filter((wait) => !wait.waived && (allowed === undefined || allowed.includes(wait.ticket))).map((wait) => wait.ticket);
  };
  const belongs = (ticket: Ticket) => repository === undefined || (ticketProject(ticket)?.toLowerCase() ?? null) === (repository?.toLowerCase() ?? null);
  const selected = tickets.filter(belongs);
  const ids = new Set(selected.map((ticket) => ticket.id));
  const refs = new Set<number>();
  if (repository !== undefined && repository !== null) {
    for (const ticket of selected) {
      for (const id of predecessors(ticket)) {
        if (all.has(id) && !ids.has(id)) refs.add(id);
      }
    }
  }
  const visible = [...selected, ...[...refs].map((id) => all.get(id)!)];
  const keys = new Set(visible.map((ticket) => ticket.id));
  const parent = new Map(visible.map((ticket) => [ticket.id, ticket.id]));
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const ticket of visible) {
    if (refs.has(ticket.id)) continue;
    for (const id of predecessors(ticket)) {
      if (keys.has(id) && id !== ticket.id) parent.set(find(ticket.id), find(id));
    }
  }
  const depths = new Map<number, number>();
  const visiting = new Set<number>();
  const depth = (id: number): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ticket = all.get(id);
    const before = refs.has(id) || ticket === undefined ? [] : predecessors(ticket).filter((value) => keys.has(value) && value !== id);
    const value = before.length === 0 ? 0 : 1 + Math.max(...before.map(depth));
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  const groups = new Map<number, Ticket[]>();
  for (const ticket of visible) {
    const root = find(ticket.id);
    groups.set(root, [...(groups.get(root) ?? []), ticket]);
  }
  const result: Record<CanvasSection, CanvasChain[]> = { waits: [], running: [], ready: [], later: [] };
  for (const group of groups.values()) {
    group.sort((a, b) => depth(a.id) - depth(b.id) || a.id - b.id);
    const chain = group.map((ticket): CanvasNode => ({
      ticket,
      reference: refs.has(ticket.id),
      after: refs.has(ticket.id) ? [] : predecessors(ticket).filter((id) => keys.has(id)),
      missing: refs.has(ticket.id) ? [] : predecessors(ticket).filter((id) => !keys.has(id)),
    }));
    const first = chain[0]!;
    const section: CanvasSection = group.some((ticket) => asking.has(ticket.id)) ? "waits"
      : first.ticket.state !== "pending" ? "running"
        : first.missing.length > 0 ? "later" : "ready";
    result[section].push(chain);
  }
  return result;
}

export interface CanvasCell { readonly node: CanvasNode; readonly column: number; readonly line: number }

export function layoutChains(chains: readonly CanvasChain[], columns: number): CanvasCell[] {
  const width = Math.max(1, Math.floor(columns));
  const cells: CanvasCell[] = [];
  let line = 0;
  let column = 0;
  for (const chain of chains) {
    if (chain.length === 1) {
      cells.push({ node: chain[0]!, line, column });
      if (++column === width) { column = 0; line++; }
    } else if (chain.length > 1) {
      if (column > 0) { column = 0; line++; }
      chain.forEach((node, index) => {
        const row = Math.floor(index / width);
        const offset = index % width;
        cells.push({ node, line: line + row, column: row % 2 === 0 ? offset : width - 1 - offset });
      });
      line += Math.ceil(chain.length / width);
    }
  }
  return cells;
}
