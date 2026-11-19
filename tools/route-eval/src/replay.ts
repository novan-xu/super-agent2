import { type Choice, characterLength, decide as decideRoute, hour, minute, recentOwnerItems, recentReplyItems, referencesIn, type Rules } from "@super-agent2/routing";
import type { History } from "./history.js";
import type { Vector } from "./scorers.js";

export { characterLength, type Choice, hour, minute, type QuestionRule, referencesIn, type Rule, type TimeMode } from "@super-agent2/routing";

export const activeWindow = 24 * hour;

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
  readonly attachments: boolean;
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
      attachments: message.attachments,
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

export interface Config extends Rules {
  readonly score: string | null;
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

export function decide(decision: ScoredDecision, config: Config): Choice {
  return decideRoute(decision, config, config.score === null ? undefined : decision.scores[config.score]!);
}

export type Outcome = "correct" | "wrongJoin" | "wrongSplit";

export function outcomeOf(decision: Decision, choice: Choice): Outcome {
  if (choice.topic === decision.expected) {
    return "correct";
  }
  return choice.topic === null ? "wrongSplit" : "wrongJoin";
}
