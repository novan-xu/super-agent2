import type { StartCard, Ticket, WaitingCard } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { arrivals, noticeKey, payloadOf } from "./notifier.js";

function ticket(id: number): Ticket {
  const title = { en: `Work ${id}`, zh: `工作 ${id}` };
  const repository = "novan-xu/super-agent-sandbox";
  return {
    id,
    repository,
    issues: [{ repository, number: id, url: `https://github.com/${repository}/issues/${id}`, title, summary: title }],
    title,
    summary: title,
    kind: "feature",
    difficulty: null,
    difficultyReason: null,
    platform: null,
    brainEngine: null,
    ownerChoice: { machine: null, engine: null, model: null, effort: null },
    state: "pending",
    machine: null,
    engine: null,
    model: null,
    effort: null,
    chosenBy: null,
    chosenAt: null,
    ran: null,
    branch: null,
    pullRequest: null,
    round: 0,
    freeRetry: false,
    stuck: null,
    waitsFor: [],
    waits: [],
    deployedAt: null,
    beginFailure: null,
    report: null,
    work: null,
    verification: null,
    stopReason: null,
    joinedInto: null,
    endedAt: null,
    conversation: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function start(id: number, ready: boolean): StartCard {
  return {
    kind: "start",
    key: `start:${id}`,
    at: 1,
    ticket: ticket(id),
    fingerprint: "a".repeat(64),
    before: ready ? [] : [{ id: 99, title: { en: "Before", zh: "之前" }, repository: null, state: "working" }],
    startable: true,
    choice: { machine: null, engine: null, model: null, effort: null, by: { machine: "default", engine: "default", model: "default", effort: "default" }, missing: ["defaults"] },
    machines: [],
  };
}

describe("notifying about chains", () => {
  it("sends one notification for any number of chains that became ready together", () => {
    const cards: WaitingCard[] = [start(1, true), start(2, true), start(3, false)];
    const arrived = arrivals(new Set(), cards);
    expect(arrived.map((card) => card.key)).toEqual(["start:1"]);
    expect(payloadOf(arrived[0] ?? start(1, true))).toEqual({ title: "等你", body: "有新的工单可以开始", url: "/workbench?card=start%3A1", tag: "start" });
  });

  it("does not send for a chain that waits, and sends when it becomes ready", () => {
    expect(noticeKey(start(3, false))).toBeUndefined();
    expect(arrivals(new Set(), [start(3, false)])).toEqual([]);
    expect(arrivals(new Set(["start:1:ready"]), [start(1, true)])).toEqual([]);
    expect(arrivals(new Set(["start:1:ready"]), [start(1, true), start(3, true)]).map((card) => card.key)).toEqual(["start:3"]);
  });
});
