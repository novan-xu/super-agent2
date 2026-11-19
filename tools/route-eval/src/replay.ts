import type { History } from "./history.js";
import type { Vector } from "./scorers.js";

export const minute = 60_000;
export const hour = 60 * minute;
export const activeWindow = 24 * hour;
export const recentOwnerItems = 5;
export const recentReplyItems = 3;

export type Variant = "owner" | "all";
export const variants: readonly Variant[] = ["owner", "all"];

export interface Candidate {
  readonly topic: string;
  readonly idleMs: number;
  readonly open: boolean;
  readonly openCard: boolean;
  readonly referenced: boolean;
  readonly owner: readonly string[];
  readonly replies: readonly string[];
}

export interface Decision {
  readonly dataset: string;
  readonly id: string;
  readonly at: number;
  readonly length: number;
  readonly truth: string;
  readonly expected: string | null;
  readonly routed: boolean;
  readonly hasReferences: boolean;
  readonly part: "train" | "test";
  readonly candidates: readonly Candidate[];
}

interface TopicState {
  scope: string;
  lastActivity: number;
  open: boolean;
  openCard: boolean;
  title: string;
  owner: string[];
  replies: string[];
  references: Set<string>;
}

export function characterLength(text: string): number {
  return [...text.trim()].length;
}

const unitAfterNumber = /^\s*(个|轮|次|项|条|张|小时|分钟|分|秒|天|号|月|年|点|岁|万|千|百|%|ms\b|s\b|k\b|g\b|gb\b|mb\b|kb\b|px\b)/i;

export function referencesIn(text: string, bare: boolean): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/tkt_([0-9a-f]{6,})/gi)) {
    found.add(`tkt:${match[1]!.slice(0, 8).toLowerCase()}`);
  }
  for (const match of text.matchAll(/\bT-(\d{1,5})\b/g)) {
    found.add(`t:${Number(match[1])}`);
  }
  for (const match of text.matchAll(/(?:#|工单\s*|issue\s*|PR\s*#?)(\d{1,5})(?![\d.:])/gi)) {
    found.add(`n:${Number(match[1])}`);
  }
  if (bare) {
    for (const match of text.matchAll(/(?<![\d.:#\w-])(\d{2,4})(?![\d.:%\w-])/g)) {
      const rest = text.slice((match.index ?? 0) + match[0].length);
      if (!unitAfterNumber.test(rest)) {
        found.add(`n:${Number(match[1])}`);
      }
    }
  }
  return found;
}

export function buildDecisions(history: History, labels: Readonly<Record<string, string>>, trainShare: number): Decision[] {
  const events = [
    ...history.messages.map((message) => ({ at: message.at, order: 1, message, reply: undefined })),
    ...history.replies.map((reply) => ({ at: reply.at, order: 0, message: undefined, reply })),
  ].sort((left, right) => left.at - right.at || left.order - right.order);
  const topics = new Map<string, TopicState>();
  const decisions: Decision[] = [];
  const trainCount = Math.round(history.messages.length * trainShare);
  for (const event of events) {
    if (event.reply !== undefined) {
      const topic = labels[event.reply.about];
      const state = topic === undefined ? undefined : topics.get(topic);
      if (state === undefined) {
        continue;
      }
      state.lastActivity = Math.max(state.lastActivity, event.reply.at);
      state.open = event.reply.asks;
      state.openCard = event.reply.card;
      state.replies.push(event.reply.id);
      for (const reference of referencesIn(event.reply.text, false)) {
        state.references.add(reference);
      }
      continue;
    }
    const message = event.message!;
    const truth = labels[message.id];
    if (truth === undefined) {
      throw new Error(`No label for message ${message.id} in ${history.name}`);
    }
    const references = referencesIn(message.text, true);
    const candidates: Candidate[] = [...topics.entries()]
      .filter(([, state]) => state.scope === message.scope && message.at - state.lastActivity <= activeWindow)
      .map(([topic, state]) => ({
        topic,
        idleMs: Math.max(0, message.at - state.lastActivity),
        open: state.open,
        openCard: state.openCard,
        referenced: [...references].some((reference) => state.references.has(reference)),
        owner: [...new Set([state.title, ...state.owner.slice(-recentOwnerItems)])],
        replies: state.replies.slice(-recentReplyItems),
      }))
      .sort((left, right) => left.idleMs - right.idleMs);
    const expected = candidates.some((candidate) => candidate.topic === truth) ? truth : null;
    decisions.push({
      dataset: history.name,
      id: message.id,
      at: message.at,
      length: characterLength(message.text),
      truth,
      expected,
      routed: message.routed,
      hasReferences: references.size > 0,
      part: decisions.length < trainCount ? "train" : "test",
      candidates,
    });
    const state = topics.get(truth) ?? { scope: message.scope, lastActivity: message.at, open: false, openCard: false, title: message.id, owner: [], replies: [], references: new Set<string>() };
    state.lastActivity = Math.max(state.lastActivity, message.at);
    state.open = false;
    state.openCard = false;
    state.owner.push(message.id);
    for (const reference of references) {
      state.references.add(reference);
    }
    topics.set(truth, state);
  }
  return decisions;
}

export interface ScoredDecision extends Decision {
  readonly scores: Readonly<Record<string, readonly number[]>>;
}

export function scoreKey(scorer: string, variant: Variant): string {
  return `${scorer}/${variant}`;
}

export function attachScores(
  decisions: readonly Decision[],
  scorer: string,
  vectors: ReadonlyMap<string, Vector>,
  similarity: (left: Vector, right: Vector) => number,
  previous: readonly ScoredDecision[] | undefined,
): ScoredDecision[] {
  return decisions.map((decision, index) => {
    const message = vectors.get(decision.id)!;
    const base = previous?.[index]?.scores ?? {};
    const scores: Record<string, readonly number[]> = { ...base };
    for (const variant of variants) {
      scores[scoreKey(scorer, variant)] = decision.candidates.map((candidate) => {
        const items = variant === "owner" ? candidate.owner : [...candidate.owner, ...candidate.replies];
        let best = -Infinity;
        for (const item of items) {
          const vector = vectors.get(item);
          if (vector !== undefined) {
            best = Math.max(best, similarity(message, vector));
          }
        }
        return best;
      });
    }
    return { ...decision, scores };
  });
}

export type QuestionRule = "off" | "card" | "text";
export type TimeMode = { readonly kind: "window"; readonly ms: number } | { readonly kind: "decay"; readonly beta: number };

export interface Config {
  readonly question: QuestionRule;
  readonly questionWindowMs: number;
  readonly references: boolean;
  readonly shortLength: number;
  readonly shortWindowMs: number;
  readonly score: string | null;
  readonly threshold: number;
  readonly margin: number;
  readonly time: TimeMode;
  readonly recencyWindowMs: number;
}

export const newTopicOnly: Config = {
  question: "off",
  questionWindowMs: 0,
  references: false,
  shortLength: 0,
  shortWindowMs: 0,
  score: null,
  threshold: Infinity,
  margin: 0,
  time: { kind: "window", ms: activeWindow },
  recencyWindowMs: 0,
};

export type Rule = "a" | "e" | "b" | "c" | "r" | "d";

export interface Choice {
  readonly topic: string | null;
  readonly rule: Rule;
}

export function decide(decision: ScoredDecision, config: Config): Choice {
  const recent = decision.candidates[0];
  if (recent !== undefined) {
    const asked = config.question === "card" ? recent.openCard : config.question === "text" ? recent.open : false;
    if (asked && recent.idleMs <= config.questionWindowMs) {
      return { topic: recent.topic, rule: "a" };
    }
  }
  if (config.references && decision.hasReferences) {
    const matches = decision.candidates.filter((candidate) => candidate.referenced);
    if (matches.length === 1) {
      return { topic: matches[0]!.topic, rule: "e" };
    }
  }
  if (recent !== undefined) {
    if (config.shortLength > 0 && decision.length <= config.shortLength && recent.idleMs <= config.shortWindowMs) {
      return { topic: recent.topic, rule: "b" };
    }
  }
  if (config.score !== null) {
    const raw = decision.scores[config.score]!;
    let best = -Infinity;
    let second = -Infinity;
    let bestTopic: string | null = null;
    decision.candidates.forEach((candidate, index) => {
      let value = raw[index]!;
      if (config.time.kind === "window") {
        if (candidate.idleMs > config.time.ms) {
          return;
        }
      } else {
        value -= config.time.beta * Math.log2(1 + candidate.idleMs / (10 * minute));
      }
      if (value > best) {
        second = best;
        best = value;
        bestTopic = candidate.topic;
      } else if (value > second) {
        second = value;
      }
    });
    if (bestTopic !== null && best >= config.threshold && best - second >= config.margin) {
      return { topic: bestTopic, rule: "c" };
    }
  }
  if (recent !== undefined && config.recencyWindowMs > 0 && recent.idleMs <= config.recencyWindowMs) {
    return { topic: recent.topic, rule: "r" };
  }
  return { topic: null, rule: "d" };
}

export type Outcome = "correct" | "wrongJoin" | "wrongSplit";

export function outcomeOf(decision: Decision, choice: Choice): Outcome {
  if (choice.topic === decision.expected) {
    return "correct";
  }
  return choice.topic === null ? "wrongSplit" : "wrongJoin";
}
