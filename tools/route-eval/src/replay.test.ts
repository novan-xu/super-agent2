import { describe, expect, it } from "vitest";
import { auc, tallyOf } from "./evaluate.js";
import { endsWithQuestion, type History, isCardAction } from "./history.js";
import { attachScores, buildDecisions, type Config, decide, hour, minute, newTopicOnly, referencesIn } from "./replay.js";
import { bigramScorer, type Vector } from "./scorers.js";

const start = Date.UTC(2026, 10, 1, 12);

const history: History = {
  name: "sample",
  messages: [
    { id: "m1", at: start, text: "deploy the photo gallery to the server", scope: "daily", group: null, explicit: false, routed: true, origin: "test" },
    { id: "m2", at: start + 5 * minute, text: "ok", scope: "daily", group: null, explicit: false, routed: true, origin: "test" },
    { id: "m3", at: start + 20 * minute, text: "what is the weather tomorrow", scope: "daily", group: null, explicit: false, routed: true, origin: "test" },
    { id: "m4", at: start + 30 * minute, text: "the photo gallery deploy failed on the server", scope: "daily", group: null, explicit: false, routed: true, origin: "test" },
    { id: "m5", at: start + 40 * minute, text: "ticket 42 stuck?", scope: "daily", group: null, explicit: false, routed: true, origin: "test" },
    { id: "m6", at: start + 30 * hour, text: "photo gallery again", scope: "daily", group: null, explicit: false, routed: true, origin: "test" },
  ],
  replies: [
    { id: "r1", at: start + minute, text: "Started ticket #42 for the gallery. Shall I deploy it now?", about: "m1", asks: true, card: false },
    { id: "r3", at: start + 21 * minute, text: "Sunny.", about: "m3", asks: false, card: false },
  ],
};

const labels = { m1: "gallery", m2: "gallery", m3: "weather", m4: "gallery", m5: "gallery", m6: "gallery" };

async function scored() {
  const scorer = bigramScorer();
  const vectors = new Map<string, Vector>();
  for (const item of [...history.messages, ...history.replies]) {
    vectors.set(item.id, await scorer.represent(item.text));
  }
  return attachScores(buildDecisions(history, labels, 0.5), scorer.name, vectors, scorer.similarity, undefined);
}

describe("replay", () => {
  it("expects a new topic when the true topic is idle for more than a day", async () => {
    const decisions = await scored();
    expect(decisions.map((decision) => decision.expected)).toEqual([null, "gallery", null, "gallery", "gallery", null]);
    expect(decisions.map((decision) => decision.part)).toEqual(["train", "train", "train", "test", "test", "test"]);
  });

  it("joins an open question's topic and a short reply's recent topic", async () => {
    const decisions = await scored();
    const question: Config = { ...newTopicOnly, question: "text", questionWindowMs: hour };
    expect(decide(decisions[1]!, question)).toEqual({ topic: "gallery", rule: "a" });
    const short: Config = { ...newTopicOnly, shortLength: 4, shortWindowMs: 10 * minute };
    expect(decide(decisions[1]!, short)).toEqual({ topic: "gallery", rule: "b" });
    expect(decide(decisions[2]!, short)).toEqual({ topic: null, rule: "d" });
  });

  it("joins the topic that a reference names", async () => {
    const decisions = await scored();
    expect(decide(decisions[4]!, { ...newTopicOnly, references: true })).toEqual({ topic: "gallery", rule: "e" });
  });

  it("joins the most similar topic over the threshold and counts wrong joins and splits", async () => {
    const decisions = await scored();
    const config: Config = { ...newTopicOnly, score: "bigram/owner", threshold: 0.3, margin: 0, time: { kind: "window", ms: 24 * hour } };
    expect(decide(decisions[3]!, config)).toEqual({ topic: "gallery", rule: "c" });
    expect(tallyOf(decisions, newTopicOnly)).toEqual({ total: 6, correct: 3, wrongJoin: 0, wrongSplit: 3 });
    expect(tallyOf(decisions, { ...newTopicOnly, recencyWindowMs: 24 * hour })).toEqual({ total: 6, correct: 4, wrongJoin: 2, wrongSplit: 0 });
  });
});

describe("signals", () => {
  it("reads references to tickets and issues but not times or quantities", () => {
    expect([...referencesIn("512 进度如何？看一下工单77 和 tkt_1a2b3c4d，PR #7", true)].sort()).toEqual(["n:512", "n:7", "n:77", "tkt:1a2b3c4d"]);
    expect([...referencesIn("下午 3:30 跑 20 次，占 15%", true)]).toEqual([]);
    expect([...referencesIn("512 is open", false)]).toEqual([]);
  });

  it("recognises questions and card buttons", () => {
    expect(endsWithQuestion("Done.\nShall I start it?")).toBe(true);
    expect(endsWithQuestion("Done.")).toBe(false);
    expect(isCardAction("开始：Fix the build")).toBe(true);
    expect(isCardAction("开始，先跑测试")).toBe(false);
  });

  it("computes AUC with ties", () => {
    expect(auc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(auc([0.5], [0.5])).toBe(0.5);
  });
});
