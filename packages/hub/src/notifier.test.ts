import type { HoldCard, StartCard, Ticket, WaitingCard } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { arrivals, fitsPush, noticeKey, payloadOf } from "./notifier.js";
import { encryptPayload, generateVapidKeys } from "./push.js";

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
    pullRequests: [],
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

function hold(command: string, environment: Readonly<Record<string, string>> = {}): HoldCard {
  return {
    kind: "hold",
    key: "hold:c1",
    at: 1,
    command: {
      id: "c1",
      target: "studio",
      command,
      account: "novan-xu",
      cwd: null,
      environment: { ...environment },
      state: "held",
      exitCode: null,
      signal: null,
      reason: null,
      createdAt: 1,
      startedAt: null,
      endedAt: null,
    },
    hold: {
      command: "c1",
      form: "repository-deletion",
      description: "删除仓库",
      evidence: "gh repo delete",
      fingerprint: "a".repeat(64),
      heldAt: 1,
      answer: null,
      answeredAt: null,
      answeredBy: null,
    },
  };
}

describe("notifying about a held command", () => {
  it("names where it runs and the command itself", () => {
    expect(payloadOf(hold("gh repo delete novan-xu/old --yes"))).toEqual({
      title: "等你",
      body: "studio 上有一条命令等你确认：\ngh repo delete novan-xu/old --yes",
      url: "/workbench?card=hold%3Ac1",
      tag: "hold:c1",
    });
  });

  it("never shows the command's environment", () => {
    const payload = payloadOf(hold("rm -rf \"$TARGET\"", { TARGET: "/srv/secret-value-1234" }));
    expect(payload.body).toContain("rm -rf");
    expect(payload.body).not.toContain("secret-value-1234");
  });

  it("clips a command too long for a push message, visibly, so that the message still goes", () => {
    const long = `${"x".repeat(2_000)}${"删".repeat(2_000)}TAIL`;
    const payload = payloadOf(hold(long));
    expect(fitsPush(payload)).toBe(true);
    expect(payload.body.endsWith("…")).toBe(true);
    expect(payload.body).not.toContain("TAIL");
    expect(payload.body.length).toBeGreaterThan(1_000);
    const device = generateVapidKeys();
    expect(() => encryptPayload(Buffer.from(JSON.stringify(payload)), device.publicKey, "AAAAAAAAAAAAAAAAAAAAAA")).not.toThrow();
  });

  it("keeps whole characters when it clips", () => {
    const payload = payloadOf(hold("😀".repeat(5_000)));
    expect(fitsPush(payload)).toBe(true);
    expect(payload.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});
