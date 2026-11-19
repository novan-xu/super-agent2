export const minute = 60_000;
export const hour = 60 * minute;

export type QuestionRule = "off" | "card" | "text";
export type TimeMode = { readonly kind: "window"; readonly ms: number } | { readonly kind: "decay"; readonly beta: number };

export interface Rules {
  readonly question: QuestionRule;
  readonly questionWindowMs: number;
  readonly references: boolean;
  readonly shortLength: number;
  readonly shortWindowMs: number;
  readonly threshold: number;
  readonly margin: number;
  readonly time: TimeMode;
  readonly recencyWindowMs: number;
}

export interface RouteCandidate {
  readonly topic: string;
  readonly idleMs: number;
  readonly open: boolean;
  readonly openCard: boolean;
  readonly referenced: boolean;
}

export interface RouteInput {
  readonly length: number;
  readonly attachments: boolean;
  readonly hasReferences: boolean;
  readonly candidates: readonly RouteCandidate[];
}

export type Rule = "a" | "e" | "b" | "c" | "r" | "d";

export interface Choice {
  readonly topic: string | null;
  readonly rule: Rule;
}

export interface Ranking {
  readonly best: string | null;
  readonly bestScore: number;
  readonly runnerUpScore: number;
}

export function adjusted(score: number, idleMs: number, time: TimeMode): number {
  if (time.kind === "window") {
    return idleMs > time.ms ? -Infinity : score;
  }
  return score - time.beta * Math.log2(1 + idleMs / (10 * minute));
}

export function rank(candidates: readonly RouteCandidate[], scores: readonly number[], time: TimeMode): Ranking {
  let best = -Infinity;
  let second = -Infinity;
  let bestTopic: string | null = null;
  candidates.forEach((candidate, index) => {
    if (time.kind === "window" && candidate.idleMs > time.ms) {
      return;
    }
    const value = adjusted(scores[index]!, candidate.idleMs, time);
    if (value > best) {
      second = best;
      best = value;
      bestTopic = candidate.topic;
    } else if (value > second) {
      second = value;
    }
  });
  return { best: bestTopic, bestScore: best, runnerUpScore: second };
}

export function decide(input: RouteInput, rules: Rules, scores: readonly number[] | undefined): Choice {
  const recent = input.candidates[0];
  if (recent !== undefined) {
    const asked = rules.question === "card" ? recent.openCard : rules.question === "text" ? recent.open : false;
    if (asked && recent.idleMs <= rules.questionWindowMs) {
      return { topic: recent.topic, rule: "a" };
    }
  }
  if (rules.references && input.hasReferences) {
    const matches = input.candidates.filter((candidate) => candidate.referenced);
    if (matches.length === 1) {
      return { topic: matches[0]!.topic, rule: "e" };
    }
  }
  if (recent !== undefined) {
    if (rules.shortLength > 0 && input.length <= rules.shortLength && !input.attachments && recent.idleMs <= rules.shortWindowMs) {
      return { topic: recent.topic, rule: "b" };
    }
  }
  if (scores !== undefined) {
    const { best, bestScore, runnerUpScore } = rank(input.candidates, scores, rules.time);
    if (best !== null && bestScore >= rules.threshold && bestScore - runnerUpScore >= rules.margin) {
      return { topic: best, rule: "c" };
    }
  }
  if (recent !== undefined && rules.recencyWindowMs > 0 && recent.idleMs <= rules.recencyWindowMs) {
    return { topic: recent.topic, rule: "r" };
  }
  return { topic: null, rule: "d" };
}
