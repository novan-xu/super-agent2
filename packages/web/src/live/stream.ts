import type { ConversationEntry, ToolEntry, Turn } from "@super-agent2/protocol";
import { type ConversationState, isWorking } from "./conversation.js";

export interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly relative: "today" | "yesterday" | null;
}

export type StreamItem =
  | { readonly kind: "day"; readonly key: string; readonly day: Day }
  | { readonly kind: "entry"; readonly key: string; readonly entry: Exclude<ConversationEntry, ToolEntry>; readonly lead: boolean; readonly live: boolean }
  | { readonly kind: "ended"; readonly key: string; readonly turn: Turn }
  | { readonly kind: "status"; readonly key: string; readonly tool: ToolEntry | null };

function dayOf(at: number): { readonly year: number; readonly month: number; readonly day: number } {
  const date = new Date(at);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function sameDay(a: { readonly year: number; readonly month: number; readonly day: number }, b: typeof a): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function describeDay(at: number, now: number): Day {
  const day = dayOf(at);
  const today = dayOf(now);
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  const yesterday = dayOf(before.getTime());
  return { ...day, relative: sameDay(day, today) ? "today" : sameDay(day, yesterday) ? "yesterday" : null };
}

function turnOf(entry: ConversationEntry): string | null {
  return entry.kind === "owner" ? null : entry.turn;
}

function isBrain(entry: ConversationEntry): boolean {
  return entry.kind === "text";
}

function endedTurns(turns: readonly Turn[]): readonly Turn[] {
  return turns.filter((turn) => turn.state === "interrupted" || turn.state === "failed");
}

export function streamItems(state: ConversationState, now: number): readonly StreamItem[] {
  return itemsOf(state, now, isWorking(state), false);
}

export function combinedStreamItems(entries: readonly ConversationEntry[], turns: readonly Turn[], now: number): readonly StreamItem[] {
  return itemsOf({ entries, turns }, now, false, true);
}

function itemsOf(state: Pick<ConversationState, "entries" | "turns">, now: number, working: boolean, combined: boolean): readonly StreamItem[] {
  const items: StreamItem[] = [];
  const running = new Set(state.turns.filter((turn) => turn.state === "running").map((turn) => turn.id));
  const ended = endedTurns(state.turns);
  const lastOfTurn = new Map<string, string>();
  for (const entry of state.entries) {
    const turn = turnOf(entry);
    if (turn !== null) {
      lastOfTurn.set(turn, entry.id);
    }
  }
  const endings = new Map<string, Turn[]>();
  const loose: Turn[] = [];
  for (const turn of ended) {
    const last = lastOfTurn.get(turn.id);
    if (last === undefined && !combined) {
      loose.push(turn);
    } else if (last !== undefined) {
      endings.set(last, [...(endings.get(last) ?? []), turn]);
    }
  }
  let previousDay: ReturnType<typeof dayOf> | undefined;
  let previous: ConversationEntry | undefined;
  const pushDay = (at: number, anchor: string) => {
    const day = dayOf(at);
    if (previousDay === undefined || !sameDay(previousDay, day)) {
      items.push({ kind: "day", key: `day-${anchor}`, day: describeDay(at, now) });
      previousDay = day;
    }
  };
  const pushLoose = (before: number) => {
    while (loose.length > 0 && (loose[0]?.startedAt ?? 0) < before) {
      const turn = loose.shift();
      if (turn !== undefined) {
        pushDay(turn.endedAt ?? turn.startedAt, `ended-${turn.id}`);
        items.push({ kind: "ended", key: `ended-${turn.id}`, turn });
        previous = undefined;
      }
    }
  };
  const lastEntry = state.entries.at(-1);
  for (const entry of state.entries) {
    pushLoose(entry.at);
    if (entry.kind !== "tool") {
      pushDay(entry.at, entry.id);
      const lead = isBrain(entry) && !(previous !== undefined && isBrain(previous) && turnOf(previous) === turnOf(entry));
      const live = entry.kind === "text" && running.has(entry.turn) && (combined ? lastOfTurn.get(entry.turn) === entry.id : entry === lastEntry && working);
      items.push({ kind: "entry", key: entry.id, entry, lead, live });
      previous = entry;
    }
    for (const turnEnded of endings.get(entry.id) ?? []) {
      pushDay(entry.at, entry.id);
      items.push({ kind: "ended", key: `ended-${turnEnded.id}`, turn: turnEnded });
      previous = undefined;
    }
  }
  pushLoose(Number.POSITIVE_INFINITY);
  if (working) {
    const tool = state.entries.findLast((entry): entry is ToolEntry => entry.kind === "tool" && entry.state === "running" && running.has(entry.turn)) ?? null;
    items.push({ kind: "status", key: "status", tool });
  }
  return items;
}
