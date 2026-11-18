import type { WaitingCard } from "@super-agent2/protocol";
import type { Failure } from "../hub/api.js";

export type Verdict = "release" | "refuse" | "resume" | "give-up";

export type CardStep = "idle" | "sending";

export interface CardUse {
  readonly step: CardStep;
  readonly verdict: Verdict | null;
  readonly failure: Failure | null;
}

export interface WaitingState {
  readonly known: boolean;
  readonly cards: readonly WaitingCard[];
  readonly use: Readonly<Record<string, CardUse>>;
  readonly answered: ReadonlySet<string>;
}

export type WaitingAction =
  | { readonly type: "snapshot"; readonly cards: readonly WaitingCard[] }
  | { readonly type: "sending"; readonly key: string; readonly verdict: Verdict }
  | { readonly type: "starting"; readonly keys: readonly string[] }
  | { readonly type: "choosing"; readonly key: string }
  | { readonly type: "chosen"; readonly key: string }
  | { readonly type: "failed"; readonly key: string; readonly failure: Failure }
  | { readonly type: "answered"; readonly key: string };

export const initialWaiting: WaitingState = { known: false, cards: [], use: {}, answered: new Set() };

const untouched: CardUse = { step: "idle", verdict: null, failure: null };

export function useOf(state: WaitingState, key: string): CardUse {
  return state.use[key] ?? untouched;
}

export function cardOf(state: WaitingState, key: string): WaitingCard | undefined {
  return state.cards.find((card) => card.key === key);
}

export function waitingCount(state: WaitingState): number {
  return state.cards.length;
}

export function canAnswer(state: WaitingState, key: string): boolean {
  if (cardOf(state, key) === undefined) {
    return false;
  }
  const { step } = useOf(state, key);
  if (step === "sending") {
    return false;
  }
  return true;
}

function ordered(cards: readonly WaitingCard[]): WaitingCard[] {
  const seen = new Set<string>();
  return cards
    .filter((card) => (seen.has(card.key) ? false : (seen.add(card.key), true)))
    .sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
}

function withUse(state: WaitingState, key: string, use: CardUse): WaitingState {
  return { ...state, use: { ...state.use, [key]: use } };
}

function fingerprintOf(card: WaitingCard): string {
  switch (card.kind) {
    case "hold":
      return card.hold.fingerprint;
    case "start":
      return card.fingerprint;
    case "stuck":
      return String(card.ticket.stuck?.at ?? 0);
  }
}

function shownCard(card: WaitingCard, before: WaitingCard | undefined): boolean {
  return before === undefined || (before.kind === card.kind && fingerprintOf(before) === fingerprintOf(card));
}

export function canStart(state: WaitingState, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => cardOf(state, key)?.kind === "start" && useOf(state, key).step === "idle");
}

function receive(state: WaitingState, incoming: readonly WaitingCard[]): WaitingState {
  const cards = ordered(incoming).filter((card) => !state.answered.has(card.key));
  const use: Record<string, CardUse> = {};
  for (const card of cards) {
    const before = state.use[card.key];
    if (before !== undefined && shownCard(card, cardOf(state, card.key))) {
      use[card.key] = before;
    }
  }
  const present = new Set(ordered(incoming).map((card) => card.key));
  const answered = new Set([...state.answered].filter((key) => present.has(key)));
  return { known: true, cards, use, answered };
}

export function waitingReducer(state: WaitingState, action: WaitingAction): WaitingState {
  switch (action.type) {
    case "snapshot":
      return receive(state, action.cards);
    case "sending":
      return canAnswer(state, action.key)
        ? withUse(state, action.key, { step: "sending", verdict: action.verdict, failure: null })
        : state;
    case "starting":
      return canStart(state, action.keys)
        ? { ...state, use: { ...state.use, ...Object.fromEntries(action.keys.map((key) => [key, { step: "sending", verdict: null, failure: null } satisfies CardUse])) } }
        : state;
    case "choosing":
      return cardOf(state, action.key)?.kind === "start" && useOf(state, action.key).step === "idle"
        ? withUse(state, action.key, { step: "sending", verdict: null, failure: null })
        : state;
    case "chosen":
      return useOf(state, action.key).step === "sending" ? withUse(state, action.key, untouched) : state;
    case "failed":
      return cardOf(state, action.key) === undefined ? state : withUse(state, action.key, { step: "idle", verdict: null, failure: action.failure });
    case "answered": {
      const use = { ...state.use };
      delete use[action.key];
      return { ...state, cards: state.cards.filter((card) => card.key !== action.key), use, answered: new Set([...state.answered, action.key]) };
    }
  }
}
