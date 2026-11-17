import type { ChainBefore, StartCard, WaitingCard } from "@super-agent2/protocol";

export interface StartGroup {
  readonly key: string;
  readonly before: readonly ChainBefore[];
  readonly cards: readonly StartCard[];
}

export interface StartView {
  readonly now: readonly StartCard[];
  readonly later: readonly StartGroup[];
  readonly all: readonly string[];
}

function byTicket(a: StartCard, b: StartCard): number {
  return a.ticket.id - b.ticket.id;
}

export function startCards(cards: readonly WaitingCard[]): StartCard[] {
  return cards.flatMap((card) => (card.kind === "start" ? [card] : [])).sort(byTicket);
}

export function startView(cards: readonly WaitingCard[]): StartView {
  const starts = startCards(cards);
  const now = starts.filter((card) => card.before.length === 0);
  const groups = new Map<string, { before: ChainBefore[]; cards: StartCard[] }>();
  for (const card of starts) {
    if (card.before.length === 0) {
      continue;
    }
    const before = [...card.before].sort((a, b) => a.id - b.id);
    const key = before.map((entry) => entry.id).join(",");
    const group = groups.get(key) ?? { before, cards: [] };
    group.cards.push(card);
    groups.set(key, group);
  }
  const later = [...groups.entries()]
    .map(([key, group]) => ({ key, before: group.before, cards: group.cards }))
    .sort((a, b) => (a.before[0]?.id ?? 0) - (b.before[0]?.id ?? 0) || (a.key < b.key ? -1 : 1));
  return { now, later, all: starts.map((card) => card.key) };
}

export function startedWith(cards: readonly WaitingCard[], keys: readonly string[]): StartCard[] {
  const wanted = new Set(keys);
  return startCards(cards).filter((card) => wanted.has(card.key));
}
