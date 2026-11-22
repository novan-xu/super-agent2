import { describe, expect, it } from "vitest";
import { bigramConfiguration, modelConfiguration } from "./configurations.js";
import { decide, minute, rank, type RouteCandidate, type RouteInput, type Rules } from "./rules.js";
import { bgeSmallZh, type ModelSpec, modelIdentity } from "./model.js";
import { characterLength, endsWithQuestion, namedReferences, referencesIn } from "./signals.js";
import { bigramScorer, bigramUnits } from "./vectors.js";

const flat: Rules = { ...modelConfiguration.rules, threshold: 0.5, margin: 0.125, time: { kind: "decay", beta: 0 } };

function candidate(topic: string, idleMinutes: number, extra: Partial<RouteCandidate> = {}): RouteCandidate {
  return { topic, idleMs: idleMinutes * minute, open: false, openCard: false, referenced: false, ...extra };
}

function input(candidates: readonly RouteCandidate[], extra: Partial<RouteInput> = {}): RouteInput {
  return { length: 40, attachments: false, hasReferences: false, candidates, ...extra };
}

describe("rules", () => {
  it("joins at the threshold and at the margin, not below either", () => {
    const pair = input([candidate("a", 60), candidate("b", 60)]);
    expect(decide(pair, flat, [0.5, 0.25])).toEqual({ topic: "a", rule: "c" });
    expect(decide(pair, flat, [0.4999, 0.1])).toEqual({ topic: null, rule: "d" });
    expect(decide(pair, flat, [0.75, 0.625])).toEqual({ topic: "a", rule: "c" });
    expect(decide(pair, flat, [0.75, 0.6251])).toEqual({ topic: null, rule: "d" });
    expect(decide(pair, flat, [0.1, 0.8])).toEqual({ topic: "b", rule: "c" });
    expect(decide(pair, flat, undefined)).toEqual({ topic: null, rule: "d" });
  });

  it("subtracts the decay per doubling of idle time beyond ten minutes", () => {
    const decayed = rank([candidate("a", 0), candidate("b", 10), candidate("c", 30)], [0.8, 0.8, 0.8], { kind: "decay", beta: 0.1 });
    expect(decayed.best).toBe("a");
    expect(decayed.bestScore).toBeCloseTo(0.8, 10);
    expect(decayed.runnerUpScore).toBeCloseTo(0.7, 10);
    expect(rank([candidate("a", 0), candidate("b", 31)], [0.5, 0.9], { kind: "window", ms: 30 * minute })).toEqual({ best: "a", bestScore: 0.5, runnerUpScore: -Infinity });
  });

  it("checks an open question, then a reference, then a short reply, then the score", () => {
    const rules = modelConfiguration.rules;
    const recent = candidate("recent", 30, { open: true });
    const referenced = candidate("other", 5, { referenced: true });
    expect(decide(input([recent, referenced], { length: 3, hasReferences: true }), rules, [0, 1])).toEqual({ topic: "recent", rule: "a" });
    expect(decide(input([{ ...recent, idleMs: 30 * minute + 1 }, referenced], { length: 3, hasReferences: true }), rules, [0, 1])).toEqual({ topic: "other", rule: "e" });
    expect(decide(input([candidate("recent", 30), candidate("x", 5, { referenced: true }), candidate("y", 5, { referenced: true })], { length: 12, hasReferences: true }), rules, [0, 1, 0])).toEqual({ topic: "recent", rule: "b" });
    expect(decide(input([candidate("recent", 30), candidate("x", 40)], { length: 12, attachments: true }), rules, [0, 1])).toEqual({ topic: "x", rule: "c" });
    expect(decide(input([candidate("recent", 30)], { length: 13 }), rules, [0])).toEqual({ topic: null, rule: "d" });
    expect(decide(input([candidate("recent", 30, { open: true })], { length: 3 }), bigramConfiguration.rules, [0])).toEqual({ topic: "recent", rule: "b" });
    expect(decide(input([candidate("recent", 31, { open: true })], { length: 3 }), bigramConfiguration.rules, [0])).toEqual({ topic: null, rule: "d" });
    expect(decide(input([candidate("card", 1, { openCard: true })]), { ...rules, question: "card" }, [0])).toEqual({ topic: "card", rule: "a" });
    expect(decide(input([]), rules, [])).toEqual({ topic: null, rule: "d" });
  });
});

describe("signals", () => {
  it("reads references with their kind and the key the text rule compares", () => {
    expect(namedReferences("看一下工单77、issue 5、#6 和 PR #7，还有 512", true).map(({ kind, value }) => `${kind}:${value}`)).toEqual([
      "ticket:77", "issue:5", "issue:6", "issue:7", "number:77", "number:512",
    ]);
    expect([...referencesIn("tkt_1A2B3C4D5E and T-12", false)].sort()).toEqual(["t:12", "tkt:1a2b3c4d"]);
    expect([...referencesIn("下午 3:30 跑 20 次，占 15%", true)]).toEqual([]);
  });

  it("measures characters and recognises a closing question", () => {
    expect(characterLength("  好的👍 ")).toBe(3);
    expect(endsWithQuestion("Done.\nShall I start it?")).toBe(true);
    expect(endsWithQuestion("要我继续吗？（可选）")).toBe(true);
    expect(endsWithQuestion("Is it done? Yes, it is done and deployed to the server now.")).toBe(false);
  });

  it("compares texts by their character bigrams and words", async () => {
    expect(bigramUnits("Deploy v2.1 到服务器")).toEqual(["w:deploy", "w:v2.1", "b:到服", "b:服务", "b:务器"]);
    const scorer = bigramScorer();
    const same = await scorer.represent("部署相册");
    expect(scorer.similarity(same, await scorer.represent("部署相册"))).toBeCloseTo(1, 6);
    expect(scorer.similarity(same, await scorer.represent("天气预报"))).toBe(0);
  });

  it("names a model by everything that makes its vectors differ", () => {
    const variants: ModelSpec[] = [
      bgeSmallZh,
      { ...bgeSmallZh, name: "renamed" },
      { ...bgeSmallZh, model: "Xenova/other" },
      { ...bgeSmallZh, revision: "0000000000000000000000000000000000000000" },
      { ...bgeSmallZh, revision: undefined },
      { ...bgeSmallZh, dtype: "q8" },
      { ...bgeSmallZh, pooling: "mean" },
      { ...bgeSmallZh, prefix: "query: " },
    ];
    const identities = variants.map(modelIdentity);
    expect(new Set(identities).size).toBe(variants.length);
    expect(modelIdentity({ ...bgeSmallZh })).toBe(identities[0]);
    expect(identities).not.toContain(bigramScorer().identity);
  });
});
