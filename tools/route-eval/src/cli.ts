import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configurations, ownerTextLimit, replyTextLimit } from "@super-agent2/routing";
import { auc, best, type RuleGrid, ruleConfigs, ruleGrid, ruleTallies, recencyConfigs, scoreConfigs, type ScoreSpace, fullSpace, spreadOf, type Tally, tallyOf, wilson, cost, quantile, wrongJoinWeight } from "./evaluate.js";
import { type History, readSuperAgent, readSuperAgent2 } from "./history.js";
import { activeWindow, attachScores, buildDecisions, characterLength, type Config, decide, type Decision, newTopicOnly, outcomeOf, type ScoredDecision, scoreKey, variants } from "./replay.js";
import { bigramScorer, modelScorer, modelSpecs, type Scorer, type Vector } from "./scorers.js";

const { values } = parseArgs({
  options: {
    superagent: { type: "string" },
    superagent2: { type: "string" },
    labels: { type: "string" },
    models: { type: "string" },
    out: { type: "string" },
    scorers: { type: "string", default: ["bigram", ...modelSpecs.map((spec) => spec.name)].join(",") },
    train: { type: "string", default: "0.6" },
    short: { type: "string", default: "10" },
  },
});

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error(`--${name} is required`);
  }
  return resolve(value);
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = required("out", values.out);
if (!relative(repository, out).startsWith("..")) {
  throw new Error(`--out must be outside the repository (${repository}); the detailed files hold chat text`);
}
mkdirSync(out, { recursive: true });
const trainShare = Number(values.train);
const shortLength = Number(values.short);
const labelFile = JSON.parse(readFileSync(required("labels", values.labels), "utf8")) as Record<string, Record<string, string>>;
const histories: History[] = [readSuperAgent(required("superagent", values.superagent)), readSuperAgent2(required("superagent2", values.superagent2))];

const lines: string[] = [];
function say(line = ""): void {
  lines.push(line);
  process.stdout.write(`${line}\n`);
}

function percent(part: number, total: number): string {
  return total === 0 ? "-" : `${((100 * part) / total).toFixed(1)}%`;
}

function row(name: string, tally: Tally): string {
  const errors = tally.wrongJoin + tally.wrongSplit;
  const [low, high] = wilson(errors, tally.total);
  return `| ${name} | ${tally.total} | ${percent(tally.correct, tally.total)} | ${tally.wrongJoin} (${percent(tally.wrongJoin, tally.total)}) | ${tally.wrongSplit} (${percent(tally.wrongSplit, tally.total)}) | ${(100 * low).toFixed(0)}–${(100 * high).toFixed(0)}% |`;
}

const tableHead = ["| Router | Messages | Correct | Wrong joins | Wrong splits | Error 95% CI |", "|---|---|---|---|---|---|"];

function describe(config: Config): string {
  const parts: string[] = [];
  if (config.question !== "off") {
    parts.push(`a=${config.question}≤${config.questionWindowMs / 60_000}m`);
  }
  if (config.references) {
    parts.push("e=references");
  }
  if (config.shortLength > 0) {
    parts.push(`b=len≤${config.shortLength},idle≤${config.shortWindowMs / 60_000}m`);
  }
  if (config.score !== null) {
    const time = config.time.kind === "window" ? `window ${config.time.ms / 60_000}m` : `decay ${config.time.beta.toFixed(4)}/log2`;
    parts.push(`c=${config.score} T=${Number.isFinite(config.threshold) ? config.threshold.toFixed(3) : "none"} M=${config.margin.toFixed(3)} ${time}`);
  }
  if (config.recencyWindowMs > 0) {
    parts.push(`recent≤${config.recencyWindowMs / 60_000}m`);
  }
  return parts.length === 0 ? "always new" : parts.join("; ");
}

const decisionsBySet = histories.map((history) => {
  const labels = labelFile[history.name];
  if (labels === undefined) {
    throw new Error(`The label file has no entry for ${history.name}`);
  }
  return buildDecisions(history, labels, trainShare);
});
let decisions: ScoredDecision[] = decisionsBySet.flat().map((decision) => ({ ...decision, scores: {} }));
const train = (items: readonly ScoredDecision[]) => items.filter((decision) => decision.part === "train");
const test = (items: readonly ScoredDecision[]) => items.filter((decision) => decision.part === "test");

say("# Routing evaluation (aggregate numbers only)");
say();
say(`Train share ${trainShare}, short message ≤ ${shortLength} characters, active window ${activeWindow / 3_600_000} h.`);
say();
say("| Data set | Messages | Topics | Messages per topic (median) | Single-message topics | Short messages | Addressed or card actions (not routed) | Expected join | Expected new | Train / test |");
say("|---|---|---|---|---|---|---|---|---|---|");
histories.forEach((history, index) => {
  const labels = labelFile[history.name]!;
  const sizes = new Map<string, number>();
  for (const message of history.messages) {
    sizes.set(labels[message.id]!, (sizes.get(labels[message.id]!) ?? 0) + 1);
  }
  const counts = [...sizes.values()].sort((left, right) => left - right);
  const set = decisionsBySet[index]!;
  say(
    `| ${history.name} | ${history.messages.length} | ${sizes.size} | ${counts[Math.floor(counts.length / 2)]} | ${counts.filter((count) => count === 1).length} | ${history.messages.filter((message) => characterLength(message.text) <= shortLength).length} | ${history.messages.filter((message) => !message.routed).length} | ${set.filter((decision) => decision.routed && decision.expected !== null).length} | ${set.filter((decision) => decision.routed && decision.expected === null).length} | ${set.filter((decision) => decision.part === "train").length} / ${set.filter((decision) => decision.part === "test").length} |`,
  );
});
say();
for (const history of histories) {
  const labels = labelFile[history.name]!;
  const groups = new Map<string, Set<string>>();
  for (const message of history.messages) {
    if (message.group !== null && message.explicit) {
      const members = groups.get(message.group) ?? new Set<string>();
      members.add(labels[message.id]!);
      groups.set(message.group, members);
    }
  }
  const split = [...groups.values()].filter((members) => members.size > 1).length;
  say(`${history.name}: ${groups.size} owner-chosen groups among explicit messages, ${split} of them labelled with more than one topic.`);
}
say();

interface PairSummary {
  readonly name: string;
  readonly all: number;
  readonly short: number;
  readonly same: number;
  readonly other: number;
}

const pairSummary: PairSummary[] = [];
const scorerNames = values.scorers!.split(",").filter((name) => name !== "");
const timings: Array<{ name: string; loadMs: number; median: number; p95: number; replyMedian: number }> = [];

for (const name of scorerNames) {
  const spec = modelSpecs.find((item) => item.name === name);
  const scorer: Scorer = spec === undefined ? bigramScorer() : await modelScorer(spec, { directory: required("models", values.models), offline: false });
  const vectors = new Map<string, Vector>();
  const ownerTimes: number[] = [];
  const replyTimes: number[] = [];
  for (const history of histories) {
    for (const message of history.messages) {
      const started = performance.now();
      vectors.set(message.id, await scorer.represent(message.text.slice(0, ownerTextLimit)));
      ownerTimes.push(performance.now() - started);
    }
    for (const reply of history.replies) {
      const started = performance.now();
      vectors.set(reply.id, await scorer.represent(reply.text.slice(0, replyTextLimit)));
      replyTimes.push(performance.now() - started);
    }
  }
  ownerTimes.sort((left, right) => left - right);
  replyTimes.sort((left, right) => left - right);
  timings.push({
    name,
    loadMs: scorer.loadMs,
    median: ownerTimes[Math.floor(ownerTimes.length / 2)]!,
    p95: ownerTimes[Math.floor(ownerTimes.length * 0.95)]!,
    replyMedian: replyTimes[Math.floor(replyTimes.length / 2)] ?? 0,
  });
  decisions = attachScores(decisions, name, vectors, scorer.similarity, decisions);
  const pairs = { same: [] as number[], other: [] as number[], sameShort: [] as number[], otherShort: [] as number[] };
  for (const history of histories) {
    const labels = labelFile[history.name]!;
    history.messages.forEach((message, index) => {
      const short = characterLength(message.text) <= shortLength;
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const previous = history.messages[earlier]!;
        if (message.at - previous.at > activeWindow) {
          break;
        }
        if (previous.scope !== message.scope) {
          continue;
        }
        const value = scorer.similarity(vectors.get(message.id)!, vectors.get(previous.id)!);
        const same = labels[message.id] === labels[previous.id];
        (same ? pairs.same : pairs.other).push(value);
        if (short) {
          (same ? pairs.sameShort : pairs.otherShort).push(value);
        }
      }
    });
  }
  pairSummary.push({ name, all: auc(pairs.same, pairs.other), short: auc(pairs.sameShort, pairs.otherShort), same: pairs.same.length, other: pairs.other.length });
}


const everything = decisions;
decisions = decisions.filter((decision) => decision.routed);
const textOf = new Map(histories.flatMap((history) => history.messages.map((message) => [message.id, message.text] as const)));
const isShort = (decision: Decision) => decision.length <= shortLength;
const rulesOnly = ruleConfigs();
const noRules: RuleGrid = { ...ruleGrid, question: ["off"], references: [false], shortLengths: [0] };
const withoutReferences: RuleGrid = { ...ruleGrid, references: [false] };

function tune(set: readonly ScoredDecision[], score: string | null, space: ScoreSpace = fullSpace, rules: readonly Config[] = rulesOnly, weight: number = wrongJoinWeight): Config {
  let current = best(set, rules, weight).config;
  if (score === null) {
    return current;
  }
  const { sd, sorted } = spreadOf(set, score);
  for (let round = 0; round < 3; round += 1) {
    current = best(set, scoreConfigs(current, score, sd, sorted, space), weight).config;
    const base = current;
    current = best(
      set,
      rules.map((rule) => ({ ...base, question: rule.question, questionWindowMs: rule.questionWindowMs, references: rule.references, shortLength: rule.shortLength, shortWindowMs: rule.shortWindowMs })),
      weight,
    ).config;
  }
  return current;
}

function results(name: string, config: Config): void {
  for (const history of histories) {
    say(row(`${name}, test, ${history.name}`, tallyOf(test(decisions), config, (decision) => decision.dataset === history.name)));
  }
  say(row(`${name}, test, both`, tallyOf(test(decisions), config)));
  say(row(`${name}, test, short`, tallyOf(test(decisions), config, isShort)));
  say(row(`${name}, test, long`, tallyOf(test(decisions), config, (decision) => !isShort(decision))));
  say(row(`${name}, train, both`, tallyOf(train(decisions), config)));
}

say("## Separation");
say();
say("Pairs of owner messages at most 24 h apart in the same scope; AUC of same-topic against different-topic pairs.");
say();
say("| Scorer | Pair AUC | Pair AUC, later message short | Same / different pairs |");
say("|---|---|---|---|");
for (const summary of pairSummary) {
  say(`| ${summary.name} | ${summary.all.toFixed(3)} | ${summary.short.toFixed(3)} | ${summary.same} / ${summary.other} |`);
}
say();
say("Message against active topics, where the true topic is active and at least one other topic is: AUC of the true topic's score against the others', and how often the true topic scores highest.");
say();
say("| Scorer / topic text | AUC | Top-1 | Top-1 short | Top-1 long | Decisions |");
say("|---|---|---|---|---|---|");
const contested = decisions.filter((decision) => decision.expected !== null && decision.candidates.length >= 2);
function topShare(filter: (decision: Decision) => boolean, winner: (decision: ScoredDecision) => string): string {
  const set = contested.filter(filter);
  return percent(set.filter((decision) => winner(decision) === decision.expected).length, set.length);
}
{
  const recent = (decision: ScoredDecision) => decision.candidates[0]!.topic;
  say(`| most recent topic | - | ${topShare(() => true, recent)} | ${topShare(isShort, recent)} | ${topShare((decision) => !isShort(decision), recent)} | ${contested.length} |`);
}
for (const name of scorerNames) {
  for (const variant of variants) {
    const key = scoreKey(name, variant);
    const positives: number[] = [];
    const negatives: number[] = [];
    for (const decision of contested) {
      decision.candidates.forEach((candidate, index) => {
        (candidate.topic === decision.expected ? positives : negatives).push(decision.scores[key]![index]!);
      });
    }
    const winner = (decision: ScoredDecision) => {
      const scores = decision.scores[key]!;
      return decision.candidates[scores.indexOf(Math.max(...scores))]!.topic;
    };
    say(`| ${key} | ${auc(positives, negatives).toFixed(3)} | ${topShare(() => true, winner)} | ${topShare(isShort, winner)} | ${topShare((decision) => !isShort(decision), winner)} | ${contested.length} |`);
  }
}
say();

say("## Baselines without a scorer (tuned on the train part)");
say();
const rulesAB = best(train(decisions), ruleConfigs(withoutReferences)).config;
const rulesAEB = tune(train(decisions), null);
const baselines: Array<[string, Config]> = [
  ["always new (today)", newTopicOnly],
  ["recency only", best(train(decisions), recencyConfigs()).config],
  ["rule a only", best(train(decisions), ruleConfigs({ ...withoutReferences, shortLengths: [0] })).config],
  ["rule b only", best(train(decisions), ruleConfigs({ ...withoutReferences, question: ["off"] })).config],
  ["rule e only", best(train(decisions), ruleConfigs({ ...ruleGrid, question: ["off"], references: [true], shortLengths: [0] })).config],
  ["rules a + b", rulesAB],
  ["rules a + e + b", rulesAEB],
];
for (const [name, config] of baselines) {
  say(`- ${name}: ${describe(config)}`);
}
say();
tableHead.forEach((line) => say(line));
for (const [name, config] of baselines) {
  results(name, config);
}
say();

const chosen = new Map<string, Config>();
say("## Rules a + b + score c (tuned on the train part)");
say();
for (const name of scorerNames) {
  const options = variants.map((variant) => tune(train(decisions), scoreKey(name, variant)));
  const config = options.reduce((left, right) => (cost(tallyOf(train(decisions), right)) < cost(tallyOf(train(decisions), left)) ? right : left));
  chosen.set(name, config);
  say(`- ${name}: ${describe(config)}`);
}
say();
tableHead.forEach((line) => say(line));
for (const [name, config] of chosen) {
  results(name, config);
}
say();

say("## Shipped configurations (constants from @super-agent2/routing)");
say();
const shipped = Object.values(configurations).filter((configuration) => scorerNames.includes(configuration.scorer));
for (const configuration of shipped) {
  say(`- ${configuration.name}: ${describe({ ...configuration.rules, score: scoreKey(configuration.scorer, "all") })}`);
}
say();
tableHead.forEach((line) => say(line));
for (const configuration of shipped) {
  results(configuration.name, { ...configuration.rules, score: scoreKey(configuration.scorer, "all") });
}
say();

say("## Ablations (each tuned on the train part, measured on the test part of both data sets)");
say();
tableHead.forEach((line) => say(line));
for (const [name, config] of chosen) {
  const score = config.score!;
  const ablations: Array<[string, Config]> = [
    ["score only, no a/b/e", tune(train(decisions), score, fullSpace, ruleConfigs(noRules))],
    ["a + b + c, no e", tune(train(decisions), score, fullSpace, ruleConfigs(withoutReferences))],
    ["absolute threshold, no margin", tune(train(decisions), score, { ...fullSpace, margins: [0] })],
    ["margin, no absolute threshold", tune(train(decisions), score, { ...fullSpace, absolute: false })],
    ["hard window", tune(train(decisions), score, { ...fullSpace, times: ["window"] })],
    ["time decay", tune(train(decisions), score, { ...fullSpace, times: ["decay"] })],
  ];
  for (const [label, ablation] of ablations) {
    say(row(`${name}: ${label}`, tallyOf(test(decisions), ablation)));
    say(`|   ${describe(ablation)} | | | | | |`);
  }
}
say();

say("## Which rule decided (test part, both data sets)");
say();
say("| Router | Rule | Decisions | Correct | Wrong joins | Wrong splits |");
say("|---|---|---|---|---|---|");
for (const [name, config] of [["rules a + b", rulesAB] as [string, Config], ["rules a + e + b", rulesAEB] as [string, Config], ...chosen]) {
  const tallies = ruleTallies(test(decisions), config);
  for (const [rule, tally] of Object.entries(tallies)) {
    if (tally.total > 0) {
      say(`| ${name} | ${rule} | ${tally.total} | ${tally.correct} | ${tally.wrongJoin} | ${tally.wrongSplit} |`);
    }
  }
}
say();

say("## Remaining errors by kind (test part, both data sets)");
say();
say("| Router | Wrong join, should be new | Wrong join, belongs to another active topic | Wrong split, belongs to the most recent topic | Wrong split, belongs to an older active topic |");
say("|---|---|---|---|---|");
for (const [name, config] of [["rules a + e + b", rulesAEB] as [string, Config], ...chosen]) {
  const counts = [0, 0, 0, 0];
  for (const decision of test(decisions)) {
    const choice = decide(decision, config);
    const outcome = outcomeOf(decision, choice);
    if (outcome === "wrongJoin") {
      counts[decision.expected === null ? 0 : 1]! += 1;
    } else if (outcome === "wrongSplit") {
      counts[decision.candidates[0]?.topic === decision.expected ? 2 : 3]! += 1;
    }
  }
  say(`| ${name} | ${counts.join(" | ")} |`);
}
say();

say("## Paired comparison of cost (2 × wrong joins + wrong splits) on the test part, 10 000 bootstrap resamples");
say();
say("| Router | Against | Cost | Cost of the other | Difference, 95% interval | Share of resamples where the router is better |");
say("|---|---|---|---|---|---|");
{
  const set = test(decisions);
  const costs = (config: Config) => set.map((decision) => {
    const outcome = outcomeOf(decision, decide(decision, config));
    return outcome === "wrongJoin" ? wrongJoinWeight : outcome === "wrongSplit" ? 1 : 0;
  });
  let seed = 139;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const indices = Array.from({ length: 10_000 }, () => Array.from({ length: set.length }, () => Math.floor(random() * set.length)));
  const pairs: Array<[string, Config, string, Config]> = [];
  for (const [name, config] of chosen) {
    pairs.push([name, config, "rules a + e + b", rulesAEB]);
    if (name !== "bigram" && chosen.has("bigram")) {
      pairs.push([name, config, "bigram", chosen.get("bigram")!]);
    }
  }
  for (const [name, config, otherName, other] of pairs) {
    const mine = costs(config);
    const theirs = costs(other);
    const differences = indices.map((sample) => sample.reduce((sum, index) => sum + mine[index]! - theirs[index]!, 0)).sort((left, right) => left - right);
    const better = differences.filter((value) => value < 0).length / differences.length;
    const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
    say(`| ${name} | ${otherName} | ${total(mine)} | ${total(theirs)} | ${quantile(differences, 0.025)} to ${quantile(differences, 0.975)} | ${(100 * better).toFixed(0)}% |`);
  }
}
say();

say("## Wrong joins against wrong splits (test part, both data sets)");
say();
{
  const set = test(decisions);
  const names = ["bigram", "bge-small-zh", "bge-m3"].filter((name) => chosen.has(name));
  const counts = (config: Config, outcome: "wrongJoin" | "wrongSplit") => set.map((decision) => (outcomeOf(decision, decide(decision, config)) === outcome ? 1 : 0));
  let seed = 142;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const samples = Array.from({ length: 10_000 }, () => Array.from({ length: set.length }, () => Math.floor(random() * set.length)));
  const paired = (mine: readonly number[], theirs: readonly number[]) => {
    const differences = samples.map((sample) => sample.reduce((sum, index) => sum + mine[index]! - theirs[index]!, 0)).sort((left, right) => left - right);
    return { low: quantile(differences, 0.025), high: quantile(differences, 0.975), better: differences.filter((value) => value < 0).length / differences.length };
  };
  const curves = new Map<string, Array<{ config: Config; tally: Tally }>>();
  for (const name of names) {
    const config = chosen.get(name)!;
    const key = config.score!;
    const values = set.flatMap((decision) => decision.scores[key]!.filter((value) => Number.isFinite(value)));
    const low = Math.min(...values);
    const high = Math.max(...values);
    const thresholds = [...Array.from({ length: 801 }, (_, index) => low + ((high - low) * index) / 800), Infinity];
    curves.set(name, thresholds.map((threshold) => ({ config: { ...config, threshold }, tally: tallyOf(set, { ...config, threshold }) })));
  }
  const at = (name: string, limit: number) => {
    let chosenPoint: { config: Config; tally: Tally } | undefined;
    for (const point of curves.get(name)!) {
      if (point.tally.wrongJoin <= limit && (chosenPoint === undefined || point.tally.wrongSplit < chosenPoint.tally.wrongSplit)) {
        chosenPoint = point;
      }
    }
    return chosenPoint;
  };
  say("Rules a, e and b, the decay and the margin are kept as chosen for each scorer; only the absolute threshold moves. Each cell is the fewest wrong splits reachable with at most that many wrong joins (actual wrong joins in brackets). The floor is the threshold at infinity: the rules alone.");
  say();
  say(`| Wrong joins at most | ${names.join(" | ")} |`);
  say(`|---|${names.map(() => "---").join("|")}|`);
  const floor = new Map(names.map((name) => [name, curves.get(name)!.at(-1)!.tally] as const));
  say(`| floor (rules only) | ${names.map((name) => `${floor.get(name)!.wrongSplit} (${floor.get(name)!.wrongJoin})`).join(" | ")} |`);
  const smallest = Math.min(...names.map((name) => floor.get(name)!.wrongJoin));
  for (let limit = smallest; limit <= 22; limit += 1) {
    say(`| ${limit} | ${names.map((name) => {
      const point = at(name, limit);
      return point === undefined ? "-" : `${point.tally.wrongSplit} (${point.tally.wrongJoin})`;
    }).join(" | ")} |`);
  }
  say();
  {
    const part = train(decisions);
    say("The same curve on the train part (234 messages), where the constants were chosen:");
    say();
    say(`| Wrong joins at most | ${names.join(" | ")} |`);
    say(`|---|${names.map(() => "---").join("|")}|`);
    const trainCurves = new Map(names.map((name) => {
      const config = chosen.get(name)!;
      const thresholds = curves.get(name)!.map((point) => point.config.threshold);
      return [name, thresholds.map((threshold) => tallyOf(part, { ...config, threshold }))] as const;
    }));
    const trainFloor = Math.min(...names.map((name) => trainCurves.get(name)!.at(-1)!.wrongJoin));
    for (let limit = trainFloor; limit <= 32; limit += 1) {
      say(`| ${limit} | ${names.map((name) => {
        const reachable = trainCurves.get(name)!.filter((tally) => tally.wrongJoin <= limit);
        if (reachable.length === 0) {
          return "-";
        }
        const fewest = reachable.reduce((left, right) => (right.wrongSplit < left.wrongSplit ? right : left));
        return `${fewest.wrongSplit} (${fewest.wrongJoin})`;
      }).join(" | ")} |`);
    }
    say();
  }
  say("Wrong joins by rule at the matched points:");
  say();
  say("| Wrong joins at most | Scorer | Threshold | a | e | b | c | Wrong splits |");
  say("|---|---|---|---|---|---|---|---|");
  for (const limit of [13, 10, 7]) {
    for (const name of names) {
      const point = at(name, limit);
      if (point === undefined) {
        say(`| ${limit} | ${name} | not reachable | | | | | |`);
        continue;
      }
      const rules = ruleTallies(set, point.config);
      say(`| ${limit} | ${name} | ${Number.isFinite(point.config.threshold) ? point.config.threshold.toFixed(3) : "none"} | ${rules.a.wrongJoin} | ${rules.e.wrongJoin} | ${rules.b.wrongJoin} | ${rules.c.wrongJoin} | ${point.tally.wrongSplit} |`);
    }
  }
  say();
  say("Constants chosen on the train part with a heavier weight on wrong joins, measured on the test part:");
  say();
  tableHead.forEach((line) => say(line));
  const weighted = new Map<string, Config>();
  for (const weight of [3, 4]) {
    for (const name of names) {
      const options = variants.map((variant) => tune(train(decisions), scoreKey(name, variant), fullSpace, rulesOnly, weight));
      const config = options.reduce((left, right) => (cost(tallyOf(train(decisions), right), weight) < cost(tallyOf(train(decisions), left), weight) ? right : left));
      weighted.set(`${name}/${weight}`, config);
      say(row(`${name}, weight ${weight}`, tallyOf(set, config)));
      const byRule = ruleTallies(set, config);
      say(`|   ${describe(config)}; wrong joins by rule a ${byRule.a.wrongJoin}, e ${byRule.e.wrongJoin}, b ${byRule.b.wrongJoin}, c ${byRule.c.wrongJoin}; decided by c ${byRule.c.total} | | | | | |`);
    }
  }
  say();
  say("Paired bootstrap, bge-small-zh minus bigram (10 000 resamples of the test messages; negative favours bge-small-zh):");
  say();
  say("| Comparison | bge-small-zh | bigram | Difference, 95% interval | Share of resamples where bge-small-zh is better |");
  say("|---|---|---|---|---|");
  if (names.includes("bge-small-zh")) {
    const comparisons: Array<[string, Config, Config, "wrongJoin" | "wrongSplit"]> = [
      ["wrong joins, constants chosen with weight 2", chosen.get("bge-small-zh")!, chosen.get("bigram")!, "wrongJoin"],
      ["wrong splits, constants chosen with weight 2", chosen.get("bge-small-zh")!, chosen.get("bigram")!, "wrongSplit"],
    ];
    for (const weight of [3, 4]) {
      comparisons.push([`wrong joins, constants chosen with weight ${weight}`, weighted.get(`bge-small-zh/${weight}`)!, weighted.get(`bigram/${weight}`)!, "wrongJoin"]);
      comparisons.push([`wrong splits, constants chosen with weight ${weight}`, weighted.get(`bge-small-zh/${weight}`)!, weighted.get(`bigram/${weight}`)!, "wrongSplit"]);
    }
    for (const limit of [13, 10, 7]) {
      const mine = at("bge-small-zh", limit);
      const theirs = at("bigram", limit);
      if (mine !== undefined && theirs !== undefined) {
        comparisons.push([`wrong splits at most ${limit} wrong joins`, mine.config, theirs.config, "wrongSplit"]);
      }
    }
    for (const [label, mine, theirs, outcome] of comparisons) {
      const left = counts(mine, outcome);
      const right = counts(theirs, outcome);
      const result = paired(left, right);
      const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
      say(`| ${label} | ${sum(left)} | ${sum(right)} | ${result.low} to ${result.high} | ${(100 * result.better).toFixed(0)}% |`);
    }
  }
  say();
}

say("## Time per decision on this machine (one message embedded alone; reported, not asserted)");
say();
say("| Scorer | Model load | Median per owner message | p95 per owner message | Median per reply (paid when it is written) |");
say("|---|---|---|---|---|");
for (const timing of timings) {
  say(`| ${timing.name} | ${(timing.loadMs / 1000).toFixed(1)} s | ${timing.median.toFixed(1)} ms | ${timing.p95.toFixed(1)} ms | ${timing.replyMedian.toFixed(1)} ms |`);
}
say();

say("## All messages, including those addressed to a ticket or sent by a card button (test part)");
say();
tableHead.forEach((line) => say(line));
for (const [name, config] of [["rules a + e + b", rulesAEB] as [string, Config], ...chosen]) {
  say(row(name, tallyOf(test(everything), config)));
}
say();
writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
for (const [name, config] of [["rules-a-e-b", rulesAEB] as [string, Config], ...chosen]) {
  const listing = ["dataset\tpart\ttime\tlength\ttruth\texpected\tchosen\trule\toutcome\ttext"];
  for (const decision of decisions) {
    if (!decision.routed) {
      continue;
    }
    const choice = decide(decision, config);
    const text = (textOf.get(decision.id) ?? "").replace(/\s+/g, " ").slice(0, 120);
    listing.push(
      [decision.dataset, decision.part, new Date(decision.at).toISOString(), decision.length, decision.truth, decision.expected ?? "(new)", choice.topic ?? "(new)", choice.rule, outcomeOf(decision, choice), text].join("\t"),
    );
  }
  writeFileSync(join(out, `decisions-${name}.tsv`), `${listing.join("\n")}\n`);
}
process.stdout.write(`\nWrote ${join(out, "report.md")} and the per-message listings to ${out}\n`);
