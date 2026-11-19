import { type Config, type Decision, decide, hour, minute, newTopicOnly, type Outcome, outcomeOf, type QuestionRule, type Rule, type ScoredDecision, type TimeMode } from "./replay.js";

export interface Tally {
  readonly total: number;
  readonly correct: number;
  readonly wrongJoin: number;
  readonly wrongSplit: number;
}

export const emptyTally: Tally = { total: 0, correct: 0, wrongJoin: 0, wrongSplit: 0 };

export function add(tally: Tally, outcome: Outcome): Tally {
  return { ...tally, total: tally.total + 1, [outcome]: tally[outcome] + 1 };
}

export const wrongJoinWeight = 2;

export function cost(tally: Tally, weight: number = wrongJoinWeight): number {
  return weight * tally.wrongJoin + tally.wrongSplit;
}

export function tallyOf(decisions: readonly ScoredDecision[], config: Config, filter: (decision: Decision) => boolean = () => true): Tally {
  let total = 0;
  let correct = 0;
  let wrongJoin = 0;
  let wrongSplit = 0;
  for (const decision of decisions) {
    if (!filter(decision)) {
      continue;
    }
    total += 1;
    const outcome = outcomeOf(decision, decide(decision, config));
    if (outcome === "correct") {
      correct += 1;
    } else if (outcome === "wrongJoin") {
      wrongJoin += 1;
    } else {
      wrongSplit += 1;
    }
  }
  return { total, correct, wrongJoin, wrongSplit };
}

export function ruleTallies(decisions: readonly ScoredDecision[], config: Config): Record<Rule, Tally> {
  const result: Record<Rule, Tally> = { a: emptyTally, e: emptyTally, b: emptyTally, c: emptyTally, r: emptyTally, d: emptyTally };
  for (const decision of decisions) {
    const choice = decide(decision, config);
    result[choice.rule] = add(result[choice.rule], outcomeOf(decision, choice));
  }
  return result;
}

export function wilson(errors: number, total: number): readonly [number, number] {
  if (total === 0) {
    return [0, 0];
  }
  const z = 1.96;
  const p = errors / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, centre - spread), Math.min(1, centre + spread)];
}

export function auc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) {
    return Number.NaN;
  }
  const all = [...positives.map((value) => ({ value, positive: true })), ...negatives.map((value) => ({ value, positive: false }))].sort((left, right) => left.value - right.value);
  let rankSum = 0;
  let index = 0;
  while (index < all.length) {
    let end = index;
    while (end + 1 < all.length && all[end + 1]!.value === all[index]!.value) {
      end += 1;
    }
    const rank = (index + end) / 2 + 1;
    for (let item = index; item <= end; item += 1) {
      if (all[item]!.positive) {
        rankSum += rank;
      }
    }
    index = end + 1;
  }
  return (rankSum - (positives.length * (positives.length + 1)) / 2) / (positives.length * negatives.length);
}

export function quantile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))));
  return sorted[position]!;
}

export function spreadOf(decisions: readonly ScoredDecision[], score: string): { readonly sd: number; readonly sorted: number[] } {
  const values = decisions.flatMap((decision) => decision.scores[score]!.filter((value) => Number.isFinite(value)));
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  return { sd: Math.sqrt(variance), sorted: values.sort((left, right) => left - right) };
}

export interface RuleGrid {
  readonly question: readonly QuestionRule[];
  readonly references: readonly boolean[];
  readonly questionWindows: readonly number[];
  readonly shortLengths: readonly number[];
  readonly shortWindows: readonly number[];
}

export const ruleGrid: RuleGrid = {
  question: ["off", "card", "text"],
  references: [false, true],
  questionWindows: [30 * minute, 2 * hour, 24 * hour],
  shortLengths: [0, 4, 8, 12, 20],
  shortWindows: [10 * minute, 30 * minute, 2 * hour],
};

export function ruleConfigs(grid: RuleGrid = ruleGrid): Config[] {
  const configs: Config[] = [];
  for (const question of grid.question) {
    for (const questionWindowMs of question === "off" ? [0] : grid.questionWindows) {
      for (const references of grid.references) {
        for (const shortLength of grid.shortLengths) {
          for (const shortWindowMs of shortLength === 0 ? [0] : grid.shortWindows) {
            configs.push({ ...newTopicOnly, question, questionWindowMs, references, shortLength, shortWindowMs });
          }
        }
      }
    }
  }
  return configs;
}

export const windows = [30 * minute, 2 * hour, 6 * hour, 24 * hour];
export const decays = [0.25, 0.5, 1, 2];
export const margins = [0, 0.25, 0.5, 1];
export const thresholdShares = Array.from({ length: 29 }, (_, index) => 0.3 + index * 0.025);

export interface ScoreSpace {
  readonly times: readonly ("window" | "decay")[];
  readonly margins: readonly number[];
  readonly absolute: boolean;
}

export const fullSpace: ScoreSpace = { times: ["window", "decay"], margins, absolute: true };

export function scoreConfigs(base: Config, score: string, sd: number, sorted: readonly number[], space: ScoreSpace = fullSpace): Config[] {
  const times: TimeMode[] = [];
  if (space.times.includes("window")) {
    times.push(...windows.map((ms): TimeMode => ({ kind: "window", ms })));
  }
  if (space.times.includes("decay")) {
    times.push(...decays.map((beta): TimeMode => ({ kind: "decay", beta: beta * sd })));
  }
  const thresholds = space.absolute ? [...new Set(thresholdShares.map((share) => quantile(sorted, share)))] : [-Infinity];
  const configs: Config[] = [];
  for (const time of times) {
    for (const threshold of thresholds) {
      for (const margin of space.margins) {
        configs.push({ ...base, score, time, threshold, margin: margin * sd });
      }
    }
  }
  return configs;
}

export function best(decisions: readonly ScoredDecision[], configs: readonly Config[], weight: number = wrongJoinWeight): { readonly config: Config; readonly tally: Tally } {
  let chosen: { config: Config; tally: Tally } | undefined;
  for (const config of configs) {
    const tally = tallyOf(decisions, config);
    if (chosen === undefined || cost(tally, weight) < cost(chosen.tally, weight) || (cost(tally, weight) === cost(chosen.tally, weight) && tally.wrongJoin < chosen.tally.wrongJoin)) {
      chosen = { config, tally };
    }
  }
  return chosen!;
}

export function recencyConfigs(): Config[] {
  return [10 * minute, 30 * minute, hour, 2 * hour, 6 * hour, 24 * hour].map((recencyWindowMs) => ({ ...newTopicOnly, recencyWindowMs }));
}
