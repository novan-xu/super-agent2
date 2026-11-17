import { describe, expect, it } from "vitest";
import { ServerMessage } from "./hub.js";
import { cardAddress, cardKey, PushPayload, PushSubscriptionRequest, WaitingCard, WaitingUpdate } from "./index.js";

const command = {
  id: "c1",
  target: "hub",
  command: "gh repo delete x --yes",
  account: "novan-xu",
  cwd: null,
  environment: { SUPERAGENT2_COMMIT: "abc1234" },
  state: "held",
  exitCode: null,
  signal: null,
  reason: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
};

const hold = {
  command: "c1",
  form: "repository-deletion",
  description: "删除仓库",
  evidence: "gh repo delete x",
  fingerprint: "ab".repeat(32),
  heldAt: 1,
  answer: null,
  answeredAt: null,
  answeredBy: null,
};

const card = { kind: "hold", key: cardKey("hold", "c1"), at: 1, command, hold };

describe("what waits", () => {
  it("names a card by its kind and its subject", () => {
    expect(cardKey("hold", "c1")).toBe("hold:c1");
  });

  it("carries a held command with everything the owner needs to answer it", () => {
    expect(WaitingCard.parse(card)).toEqual(card);
  });

  it("refuses a kind of card it does not know yet", () => {
    expect(WaitingCard.safeParse({ ...card, kind: "question" }).success).toBe(false);
  });

  it("reaches the page as a message with the whole list", () => {
    expect(ServerMessage.parse({ type: "waiting", cards: [card] })).toEqual({ type: "waiting", cards: [card] });
    expect(WaitingUpdate.parse({ type: "waiting", cards: [] }).cards).toEqual([]);
  });
});

describe("a notification", () => {
  it("opens the card it names", () => {
    expect(cardAddress("hold:c1")).toBe("/workbench?card=hold%3Ac1");
  });

  it("carries text and an address on this site, never another", () => {
    const payload = { title: "等你", body: "有一条命令等你确认", url: cardAddress("hold:c1"), tag: "hold:c1" };
    expect(PushPayload.parse(payload)).toEqual(payload);
    expect(PushPayload.safeParse({ ...payload, url: "https://elsewhere.example.com/" }).success).toBe(false);
    expect(PushPayload.safeParse({ ...payload, url: "//elsewhere.example.com/" }).success).toBe(false);
  });
});

describe("a push subscription", () => {
  const subscription = { endpoint: "https://push.example.net/x", keys: { p256dh: "AAAA", auth: "BBBB" }, applicationServerKey: "CCCC" };

  it("names an endpoint, the device's keys and the key it was made for", () => {
    expect(PushSubscriptionRequest.parse(subscription)).toEqual(subscription);
  });

  it("refuses an endpoint that is not an address and keys that are not base64", () => {
    expect(PushSubscriptionRequest.safeParse({ ...subscription, endpoint: "x" }).success).toBe(false);
    expect(PushSubscriptionRequest.safeParse({ ...subscription, keys: { p256dh: "a b", auth: "BBBB" } }).success).toBe(false);
  });
});
