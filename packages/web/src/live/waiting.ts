import type { WaitingCard } from "@super-agent2/protocol";
import type { Failure } from "../hub/api.js";

export type Verdict = "release" | "refuse";

export type CardStep = "idle" | "armed" | "sending";

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
  | { readonly type: "arm"; readonly key: string }
  | { readonly type: "disarm"; readonly key: string }
  | { readonly type: "sending"; readonly key: string; readonly verdict: Verdict }
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

export function canAnswer(state: WaitingState, key: string, verdict: Verdict): boolean {
  if (cardOf(state, key) === undefined) {
    return false;
  }
  const { step } = useOf(state, key);
  if (step === "sending") {
    return false;
  }
  return verdict === "release" ? step === "armed" : true;
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

function shownCard(card: WaitingCard, before: WaitingCard | undefined): boolean {
  return before === undefined || before.hold.fingerprint === card.hold.fingerprint;
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
    case "arm":
      return useOf(state, action.key).step === "idle" && cardOf(state, action.key) !== undefined
        ? withUse(state, action.key, { step: "armed", verdict: null, failure: null })
        : state;
    case "disarm":
      return useOf(state, action.key).step === "armed" ? withUse(state, action.key, untouched) : state;
    case "sending":
      return canAnswer(state, action.key, action.verdict)
        ? withUse(state, action.key, { step: "sending", verdict: action.verdict, failure: null })
        : state;
    case "failed":
      return cardOf(state, action.key) === undefined ? state : withUse(state, action.key, { step: "idle", verdict: null, failure: action.failure });
    case "answered": {
      const use = { ...state.use };
      delete use[action.key];
      return { ...state, cards: state.cards.filter((card) => card.key !== action.key), use, answered: new Set([...state.answered, action.key]) };
    }
  }
}
