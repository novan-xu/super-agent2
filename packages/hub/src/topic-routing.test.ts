import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protocolVersion, type TopicScope } from "@super-agent2/protocol";
import { dot, minute, type Scorer } from "@super-agent2/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HubDatabase, openDatabase } from "./database.js";
import type { Hub } from "./hub.js";
import { keySet, signingKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";
import { createTopicRouter, type ModelLoader, namedRepository, type RoutingMessage, type RoutingOptions } from "./topic-routing.js";

const vocabulary = ["alpha", "beta", "gamma", "delta"];

let dataDir: string;
let clock: TestClock;
let database: HubDatabase;
let embedded: string[];
let lines: string[];

function fakeScorer(fails: (text: string) => boolean = () => false): Scorer {
  return {
    name: "fake",
    loadMs: 0,
    represent: (text) => {
      embedded.push(text);
      if (fails(text)) {
        return Promise.reject(new Error("embedding broke"));
      }
      const vector = new Float32Array(vocabulary.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)));
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      return Promise.resolve(norm === 0 ? vector : vector.map((value) => value / norm));
    },
    similarity: dot,
  };
}

const fakeModel: ModelLoader = () => Promise.resolve(fakeScorer());

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-topic-routing-"));
  clock = new TestClock();
  database = openDatabase({ dataDir, clock });
  embedded = [];
  lines = [];
});

afterEach(() => {
  database.connection.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function topic(idleMinutes: number, options: { repository?: string; state?: "active" | "archived"; system?: boolean } = {}): string {
  const id = randomUUID();
  const at = clock.now() - idleMinutes * minute;
  database.connection
    .prepare("INSERT INTO conversations (id, title, state, created_at, updated_at, system, repository, topic_state) VALUES (?, 'Topic', 'idle', ?, ?, ?, ?, ?)")
    .run(id, at, at, options.system === true ? 1 : 0, options.repository ?? null, options.state ?? "active");
  return id;
}

function entry(conversation: string, kind: "owner" | "text" | "question", body: Record<string, unknown>, idleMinutes = 0): string {
  const id = randomUUID();
  database.connection
    .prepare(`INSERT INTO conversation_entries (id, conversation_id, seq, kind, body, created_at, stream_seq)
      VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM conversation_entries WHERE conversation_id = ?), ?, ?, ?,
        (SELECT coalesce(max(stream_seq), 0) + 1 FROM conversation_entries))`)
    .run(id, conversation, conversation, kind, JSON.stringify(body), clock.now() - idleMinutes * minute);
  return id;
}

function said(conversation: string, text: string, idleMinutes = 0): string {
  return entry(conversation, "owner", { text, attachments: [] }, idleMinutes);
}

function replied(conversation: string, text: string, idleMinutes = 0): string {
  return entry(conversation, "text", { text }, idleMinutes);
}

function ticket(id: number, conversation: string | null, repository = "owner/project"): void {
  database.connection
    .prepare(`INSERT INTO tickets (id, repository, kind, title_en, title_zh, summary_en, summary_zh, state, conversation_id, created_at, updated_at)
      VALUES (?, ?, 'feature', 'Title', '标题', 'Summary', '摘要', 'working', ?, 0, 0)`)
    .run(id, repository, conversation);
}

function message(text: string, scope: TopicScope = { kind: "daily" }, attachments = 0): RoutingMessage {
  return {
    text,
    scope,
    at: clock.now(),
    attachments: Array.from({ length: attachments }, (_, index) => ({ id: `file-${index}`, name: "photo.png", size: 1, mediaType: "image/png" })),
  };
}

async function router(options: RoutingOptions = { model: fakeModel }) {
  const created = createTopicRouter(database, { report: (line) => lines.push(line), ...options });
  await created.settled();
  return created;
}

describe("topic routing rules", () => {
  it("joins the most recent topic with an open question within 30 minutes, from a reply or an unanswered card", async () => {
    const asked = topic(40);
    said(asked, "alpha plan", 40);
    replied(asked, "Done.\nShall I continue?", 30);
    const other = topic(50);
    said(other, "beta notes", 50);
    const routing = await router();
    expect((await routing.route(message("delta is unrelated text"))).decided).toMatchObject({ configuration: "model", rule: "a", topic: asked });
    clock.advance(1);
    expect((await routing.route(message("delta is unrelated text"))).decided).toMatchObject({ rule: "d", topic: null });

    const card = topic(10);
    entry(card, "question", { questions: [{ id: "q1", text: "Which one", options: [] }], answer: null }, 10);
    expect((await routing.route(message("delta is unrelated text"))).decided).toMatchObject({ rule: "a", topic: card });
    said(card, "the first", 5);
    expect((await routing.route(message("delta is unrelated text"))).decided).toMatchObject({ rule: "d" });
  });

  it("joins the topic of a referenced ticket, issue or pull request, preferring the database to the text", async () => {
    const first = topic(60);
    said(first, "alpha", 60);
    const second = topic(90);
    said(second, "beta", 90);
    replied(second, "PR 99 is ready for review", 90);
    const archived = topic(120, { state: "archived" });
    ticket(7, second);
    ticket(8, first);
    ticket(9, archived);
    database.connection.prepare(`INSERT INTO ticket_issues (ticket_id, position, repository, number, url, title_en, title_zh, summary_en, summary_zh)
      VALUES (8, 0, 'owner/project', 42, 'https://github.com/owner/project/issues/42', 'Issue', '问题', 'Summary', '摘要')`).run();
    database.connection.prepare(`INSERT INTO ticket_pull_requests (ticket_id, seq, number, url, branch, state, handed_at)
      VALUES (8, 1, 55, 'https://github.com/owner/project/pull/55', 'branch', 'open', 0)`).run();
    replied(first, "工单 7 was mentioned here as well", 60);
    const routing = await router();
    expect((await routing.route(message("how is 工单 7 going today"))).decided).toMatchObject({ rule: "e", topic: second });
    expect((await routing.route(message("did issue #42 get fixed"))).decided).toMatchObject({ rule: "e", topic: first });
    expect((await routing.route(message("is PR 55 merged by now"))).decided).toMatchObject({ rule: "e", topic: first });
    expect((await routing.route(message("PR 99 should be merged"))).decided).toMatchObject({ rule: "e", topic: second });
    expect((await routing.route(message("what about 工单 9 then"))).decided).toMatchObject({ rule: "d" });
  });

  it("applies the rules in the order a, e, b, c", async () => {
    const recent = topic(10);
    said(recent, "alpha", 10);
    replied(recent, "Ready to go?", 10);
    const older = topic(20);
    said(older, "beta", 20);
    ticket(7, older);
    const routing = await router();
    expect((await routing.route(message("工单 7"))).decided).toMatchObject({ rule: "a", topic: recent });
    said(recent, "yes", 5);
    expect((await routing.route(message("工单 7"))).decided).toMatchObject({ rule: "e", topic: older });
    expect((await routing.route(message("beta again"))).decided).toMatchObject({ rule: "b", topic: recent });
    expect((await routing.route(message("more about beta here"))).decided).toMatchObject({ rule: "c", topic: older });
  });

  it("joins a short reply at 12 characters and 30 minutes, not beyond or with an attachment", async () => {
    const recent = topic(30);
    said(recent, "alpha", 30);
    const routing = await router();
    expect((await routing.route(message("twelve chars"))).decided).toMatchObject({ rule: "b", topic: recent });
    expect((await routing.route(message("thirteen char"))).decided).toMatchObject({ rule: "d" });
    expect((await routing.route(message("短", { kind: "daily" }, 1))).decided).toMatchObject({ rule: "d" });
    clock.advance(1);
    expect((await routing.route(message("ok"))).decided).toMatchObject({ rule: "d" });
  });

  it("joins the best score over the threshold and ahead by the margin, otherwise opens a topic with a possible match", async () => {
    const first = topic(60);
    said(first, "alpha project plan", 60);
    const second = topic(60);
    said(second, "beta release notes", 60);
    const routing = await router();
    const joined = await routing.route(message("tell me about alpha"));
    expect(joined.decided).toMatchObject({ rule: "c", topic: first, best: first });
    expect(joined.decided.bestScore).toBeCloseTo(1 - 0.048 * Math.log2(7), 5);
    expect(joined.decided.runnerUpScore).toBeCloseTo(-0.048 * Math.log2(7), 5);

    const level = await routing.route(message("both alpha and beta"));
    expect(level).toMatchObject({ topic: null, decided: { rule: "d" } });
    expect([first, second]).toContain(level.possibleMatch);

    const low = await routing.route(message("alpha with gamma and delta"));
    expect(low).toMatchObject({ topic: null, possibleMatch: first, decided: { rule: "d", best: first } });
  });

  it("leaves out archived, merged, system and out-of-scope topics", async () => {
    const daily = topic(5);
    said(daily, "alpha", 5);
    said(topic(1, { state: "archived" }), "alpha", 1);
    said(topic(1, { system: true }), "alpha", 1);
    said(topic(1, { repository: "owner/project" }), "alpha", 1);
    const routing = await router();
    const result = await routing.route(message("ok"));
    expect(result).toMatchObject({ candidates: 1, topic: daily });
    const code = await routing.route(message("ok", { kind: "repository", repository: "OWNER/PROJECT" }));
    expect(code.candidates).toBe(1);
    expect(code.topic).not.toBe(daily);
  });
});

describe("topic routing configurations", () => {
  it("decides with the model, records the bigram configuration as the shadow and switches by one setting", async () => {
    const first = topic(60);
    said(first, "alpha project plan", 60);
    const second = topic(60);
    said(second, "beta release notes", 60);
    const primary = await (await router()).route(message("tell me about alpha"));
    expect(primary).toMatchObject({
      fallback: null,
      decided: { configuration: "model", rule: "c", topic: first },
      shadow: { configuration: "bigram", rule: "d", topic: null },
    });
    const switched = await (await router({ model: fakeModel, primary: "bigram" })).route(message("tell me about alpha"));
    expect(switched).toMatchObject({
      fallback: null,
      decided: { configuration: "bigram", rule: "d", topic: null },
      shadow: { configuration: "model", rule: "c", topic: first },
    });
  });

  it("routes with the bigram configuration at once while the model is missing, loading, failing to load or failing to embed", async () => {
    const recent = topic(5);
    said(recent, "alpha", 5);
    const expected = { topic: recent, shadow: null, decided: { configuration: "bigram", rule: "b" } };
    expect(await (await router({})).route(message("ok"))).toMatchObject({ ...expected, fallback: "model not configured" });

    const loading = createTopicRouter(database, { model: () => new Promise<Scorer>(() => undefined) });
    expect(await loading.route(message("ok"))).toMatchObject({ ...expected, fallback: "model loading" });

    const failed = await router({ model: () => Promise.reject(new Error("files missing")) });
    expect(await failed.route(message("ok"))).toMatchObject({ ...expected, fallback: "model failed to load" });
    expect(lines).toContainEqual(expect.stringContaining("files missing"));

    const broken = await router({ model: () => Promise.resolve(fakeScorer((text) => text === "ok")) });
    expect(await broken.route(message("ok"))).toMatchObject({ ...expected, fallback: "embedding failed: Error" });
  });

  it("keeps topic text vectors so that routing embeds only the message", async () => {
    const first = topic(60);
    said(first, "alpha project plan", 60);
    replied(first, "Beta reply", 59);
    const routing = await router();
    expect(embedded).toEqual(["alpha project plan", "Beta reply"]);
    embedded = [];
    await routing.route(message("tell me about alpha"));
    expect(embedded).toEqual(["tell me about alpha"]);

    embedded = [];
    replied(first, "Gamma reply", 1);
    routing.refresh();
    await routing.settled();
    expect(embedded).toEqual(["Gamma reply"]);
    embedded = [];
    await routing.route(message("tell me about gamma"));
    expect(embedded).toEqual(["tell me about gamma"]);
  });
});

describe("repository of a new topic in all of code", () => {
  it("is set when the message names exactly one known repository", async () => {
    expect(namedRepository("deploy gamma please", ["owner/alpha", "Owner/Beta", "other/gamma"])).toBe("other/gamma");
    expect(namedRepository("fix OWNER/BETA today", ["owner/alpha", "Owner/Beta"])).toBe("Owner/Beta");
    expect(namedRepository("alpha and beta", ["owner/alpha", "Owner/Beta"])).toBeNull();
    expect(namedRepository("the alphabet", ["owner/alpha"])).toBeNull();
    expect(namedRepository("see alpha.", ["owner/alpha"])).toBe("owner/alpha");
    expect(namedRepository("project", ["one/project", "two/project"])).toBeNull();

    const coded = topic(60, { repository: "owner/alpha" });
    said(coded, "delta", 60);
    ticket(3, null, "other/gamma");
    const routing = await router();
    expect(await routing.route(message("start work in gamma", { kind: "code" }))).toMatchObject({ topic: null, repository: "other/gamma" });
    expect(await routing.route(message("start something new", { kind: "code" }))).toMatchObject({ topic: null, repository: null });
    expect(await routing.route(message("start work in gamma", { kind: "repository", repository: "owner/alpha" }))).toMatchObject({ repository: "owner/alpha" });
    expect(await routing.route(message("start work in gamma"))).toMatchObject({ repository: null });
  });
});

describe("routing in the hub", () => {
  let hub: Hub | undefined;

  afterEach(async () => {
    await hub?.close();
    hub = undefined;
  });

  async function start(): Promise<Hub> {
    hub = await startTestHub({
      config: testConfig(join(dataDir, "hub")),
      keySource: staticKeySource(keySet(await signingKey("key-1"))),
      clock,
      targets: [fakeTarget("hub")],
      credentials: testCredentials,
      routingModel: fakeModel,
      report: (line) => lines.push(line),
    });
    await hub.conversations.routingSettled();
    return hub;
  }

  const decisions = (running: Hub) => running.database.connection.prepare("SELECT * FROM routing_decisions ORDER BY rowid").all();

  it("routes only messages without a topic, records and logs each decision without its text and keeps a later move as a correction", async () => {
    const running = await start();
    const service = running.conversations;
    const topic = service.create().id;
    const first = service.send(topic, "alpha project plan")!;
    await service.sendToStream(topic, "beta inside the topic", []);
    await service.sendToStream(undefined, "a quoted gamma reply", [], { quotedMessage: first.id });
    const brain = service.attach({ send: () => undefined, close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    brain.receive({ type: "turn.started", conversation: topic, turn: "t", provider: "gpt", model: "test", inputs: [] });
    const card = service.askOwner(topic, "t", [{ id: "scope", prompt: "选择范围", required: true, multiple: false, options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }] }])!;
    expect(service.answerQuestions(topic, card, [{ question: "scope", options: ["a"], text: "" }])).toBeDefined();
    expect(decisions(running)).toEqual([]);

    const routed = (await service.sendToStream(undefined, "tell me more about alpha", []))!;
    expect(routed.topic.id).toBe(topic);
    expect(decisions(running)).toEqual([{
      entry: routed.entry.id, decided_at: clock.now(), scope: "daily", candidates: 1, configuration: "model", fallback_reason: null,
      rule: "c", topic, placed_in: topic, best_topic: topic, best_score: expect.any(Number), runner_up_score: null,
      shadow_configuration: "bigram", shadow_rule: "c", shadow_topic: topic, shadow_best_topic: topic, shadow_best_score: expect.any(Number), shadow_runner_up_score: null,
      moved_to: null, moved_at: null,
    }]);
    const logged = lines.filter((line) => line.startsWith("Topic routing decision "));
    expect(logged).toEqual([expect.stringContaining(`Topic routing decision ${routed.entry.id}: model rule c topic ${topic}`)]);
    expect(lines.some((line) => /alpha|beta|gamma/.test(line))).toBe(false);

    const other = service.create().id;
    clock.advance(minute);
    expect(service.move(routed.entry.id, other)).toEqual({ ok: true, value: other });
    expect(decisions(running)).toMatchObject([{ entry: routed.entry.id, placed_in: topic, moved_to: other, moved_at: clock.now() }]);
  });

  it("routes a message saved before a restart with the bigram configuration and records why", async () => {
    let running = await start();
    const topic = running.conversations.create().id;
    running.conversations.send(topic, "alpha");
    running.database.connection.prepare("INSERT INTO pending_topic_inputs (id, body, created_at) VALUES (?, ?, ?)").run(
      "pending", JSON.stringify({ message: "ok", attachments: [], scope: { kind: "daily" } }), clock.now(),
    );
    await running.close();
    hub = undefined;
    running = await start();
    expect(running.conversations.entries(topic).at(-1)).toMatchObject({ id: "pending", text: "ok" });
    expect(decisions(running)).toMatchObject([{ entry: "pending", configuration: "bigram", rule: "b", topic, fallback_reason: "recovered after a restart", shadow_rule: null }]);
    expect(running.database.connection.prepare("SELECT * FROM pending_topic_inputs").all()).toEqual([]);
  });
});
