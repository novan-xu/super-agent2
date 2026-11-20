import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrainInput, protocolVersion, type TopicScope } from "@super-agent2/protocol";
import { dot, minute, type Scorer } from "@super-agent2/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sleep } from "./clock.js";
import { type HubDatabase, openDatabase } from "./database.js";
import type { Hub } from "./hub.js";
import { assertion, keySet, type SigningKey, signingKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";
import { createTopicRouter, type ModelLoader, namedRepository, type RoutingMessage, type RoutingOptions } from "./topic-routing.js";

const vocabulary = ["alpha", "beta", "gamma", "delta"];

let dataDir: string;
let clock: TestClock;
let database: HubDatabase;
let embedded: string[];
let lines: string[];

function fakeScorer(fails: (text: string) => boolean = () => false, identity = "fake"): Scorer {
  return {
    name: "fake",
    identity,
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

function heldModel() {
  const scorer = fakeScorer();
  const started: string[] = [];
  const held: (() => void)[] = [];
  const starting: ((text: string) => void)[] = [];
  const state = { holding: true };
  const model: ModelLoader = () => Promise.resolve({
    ...scorer,
    represent: (text) => {
      if (!state.holding) return scorer.represent(text);
      started.push(text);
      for (const notify of starting.splice(0)) notify(text);
      return new Promise((resolve, reject) => held.push(() => void scorer.represent(text).then(resolve, reject)));
    },
  });
  const nextStart = () => new Promise<string>((resolve) => starting.push(resolve));
  const release = () => held.shift()?.();
  const releaseThenNext = () => {
    const next = nextStart();
    release();
    return next;
  };
  return { model, state, started, nextStart, release, releaseThenNext };
}

function manualSleep() {
  const waits: { readonly milliseconds: number; readonly end: () => void }[] = [];
  const sleep: Sleep = (milliseconds, signal) => new Promise<void>((resolve) => {
    waits.push({ milliseconds, end: resolve });
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { sleep, waits };
}

const never: Sleep = () => new Promise<void>(() => undefined);

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

function started(conversation: string): string {
  const id = randomUUID();
  database.connection
    .prepare("INSERT INTO turns (id, conversation_id, provider, model, state, started_at) VALUES (?, ?, 'gpt', 'test', 'running', ?)")
    .run(id, conversation, clock.now());
  return id;
}

function ended(turn: string, state: "completed" | "interrupted"): void {
  database.connection.prepare("UPDATE turns SET state = ?, ended_at = ? WHERE id = ?").run(state, clock.now(), turn);
}

function streamed(conversation: string, turn: string, text: string): string {
  const id = entry(conversation, "text", { text });
  database.connection.prepare("UPDATE conversation_entries SET turn_id = ? WHERE id = ?").run(turn, id);
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
    .prepare(`INSERT INTO tickets (id, repository, kind, title_en, title_zh, summary_en, summary_zh, state, conversation_id, created_at, updated_at, code, code_date)
      VALUES (?, ?, 'feature', 'Title', '标题', 'Summary', '摘要', 'working', ?, 0, 0, ?, '1969-12-31')`)
    .run(id, repository, conversation, String.fromCharCode(97 + Math.floor(id / 26), 97 + id % 26));
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
    expect((await routing.route(message("how is ticket ah going today"))).decided).toMatchObject({ rule: "e", topic: second });
    expect((await routing.route(message("工单 AI-1969-12-31 怎么样"))).decided).toMatchObject({ rule: "e", topic: first });
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

describe("stored topic text vectors", () => {
  const stored = () =>
    database.connection.prepare("SELECT entry, model, hex(text_hash) AS hash FROM routing_vectors ORDER BY entry, model").all().map((row) => ({ ...row }));
  const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").toUpperCase();
  const setBody = (id: string, body: Record<string, unknown>) =>
    database.connection.prepare("UPDATE conversation_entries SET body = ? WHERE id = ?").run(JSON.stringify(body), id);

  it("are read back by a later router, which computes none of them in the background or when routing", async () => {
    const first = topic(60);
    said(first, "alpha project plan", 60);
    replied(first, "Beta reply", 59);
    said(topic(30), "gamma notes", 30);
    (await router()).close();
    expect([...embedded].sort()).toEqual(["Beta reply", "alpha project plan", "gamma notes"]);
    expect(stored()).toHaveLength(3);

    embedded = [];
    const later = await router();
    later.refresh();
    await later.settled();
    expect(embedded).toEqual([]);
    expect((await later.route(message("tell me about alpha"))).decided).toMatchObject({ configuration: "model", rule: "c", topic: first });
    expect(embedded).toEqual(["tell me about alpha"]);
  });

  it("computes each distinct text once when several routings start together", async () => {
    const routing = await router();
    const first = topic(60);
    said(first, "alpha project plan", 60);
    replied(first, "Beta reply", 59);
    said(topic(60), "gamma notes", 60);
    const results = await Promise.all([
      routing.route(message("tell me about alpha")),
      routing.route(message("what about gamma")),
      routing.route(message("tell me about alpha")),
      routing.route(message("tell me about alpha")),
    ]);
    expect(results.map(({ decided }) => decided.configuration)).toEqual(["model", "model", "model", "model"]);
    expect([...embedded].sort()).toEqual(["Beta reply", "alpha project plan", "gamma notes", "tell me about alpha", "what about gamma"]);
  });

  it("computes a previewed draft once however often it is previewed", async () => {
    said(topic(60), "alpha project plan", 60);
    const routing = await router();
    embedded = [];
    await routing.route(message("tell me about alpha"));
    await routing.route(message("tell me about alpha"));
    expect(embedded).toEqual(["tell me about alpha"]);
  });

  it("stores a routed message's vector under its entry without computing it again", async () => {
    const first = topic(60);
    said(first, "alpha project plan", 60);
    const routing = await router();
    embedded = [];
    const text = "tell me about alpha";
    await routing.route(message(text));
    const id = said(first, text);
    routing.refresh();
    await routing.settled();
    expect(embedded).toEqual([text]);
    expect(stored()).toContainEqual({ entry: id, model: "fake", hash: hashOf(text) });
  });

  it("computes an entry's changed text once, replaces its row and ignores changes past the length limit", async () => {
    const first = topic(5);
    const reply = replied(first, "Beta", 5);
    const routing = await router();
    const grown = `Beta reply grows ${"x".repeat(400)}`;
    setBody(reply, { text: grown });
    embedded = [];
    routing.refresh();
    await routing.settled();
    setBody(reply, { text: `${grown} and further` });
    routing.refresh();
    await routing.settled();
    await routing.route(message("tell me about beta"));
    expect(embedded).toEqual([grown.slice(0, 320), "tell me about beta"]);
    expect(stored()).toEqual([{ entry: reply, model: "fake", hash: hashOf(grown.slice(0, 320)) }]);

    embedded = [];
    await router();
    expect(embedded).toEqual([]);
  });

  it("never uses vectors stored under another model identity", async () => {
    const first = topic(60);
    const owner = said(first, "alpha project plan", 60);
    await router();
    embedded = [];
    const other = await router({ model: () => Promise.resolve(fakeScorer(() => false, "other")) });
    expect(embedded).toEqual(["alpha project plan"]);
    expect(stored()).toEqual([
      { entry: owner, model: "fake", hash: hashOf("alpha project plan") },
      { entry: owner, model: "other", hash: hashOf("alpha project plan") },
    ]);
    embedded = [];
    await other.route(message("tell me about alpha"));
    await router();
    expect(embedded).toEqual(["tell me about alpha"]);
  });

  it("keeps stored vectors while a topic is archived and removes them with their entry", async () => {
    const first = topic(60);
    const owner = said(first, "alpha project plan", 60);
    const reply = replied(first, "Beta reply", 59);
    const routing = await router();
    const state = database.connection.prepare("UPDATE conversations SET topic_state = ? WHERE id = ?");
    state.run("archived", first);
    routing.refresh();
    await routing.settled();
    expect(stored()).toHaveLength(2);

    state.run("active", first);
    embedded = [];
    routing.refresh();
    await routing.settled();
    expect(embedded).toEqual([]);

    database.connection.prepare("DELETE FROM conversation_entries WHERE id = ?").run(reply);
    expect(stored()).toEqual([{ entry: owner, model: "fake", hash: hashOf("alpha project plan") }]);
  });

  it("computes a streaming reply once, after its turn ends", async () => {
    const first = topic(5);
    said(first, "alpha project plan", 5);
    const routing = await router();
    const turn = started(first);
    const reply = streamed(first, turn, "Beta");
    embedded = [];
    routing.refresh();
    await routing.settled();
    setBody(reply, { text: "Beta reply" });
    await routing.route(message("tell me about beta"));
    setBody(reply, { text: "Beta reply grows" });
    routing.refresh();
    await routing.settled();
    expect(embedded).toEqual(["tell me about beta"]);

    ended(turn, "completed");
    routing.refresh();
    await routing.settled();
    await routing.route(message("tell me about beta"));
    expect(embedded).toEqual(["tell me about beta", "Beta reply grows"]);
    expect(stored().filter(({ entry }) => entry === reply)).toEqual([{ entry: reply, model: "fake", hash: hashOf("Beta reply grows") }]);
  });

  it("computes a streaming reply once its text passes the length limit, and not again when its turn ends", async () => {
    const first = topic(5);
    const routing = await router();
    const turn = started(first);
    const long = `Beta reply ${"x".repeat(400)}`;
    const reply = streamed(first, turn, long);
    routing.refresh();
    await routing.settled();
    expect(embedded).toEqual([long.slice(0, 320)]);
    setBody(reply, { text: `${long} and more` });
    routing.refresh();
    await routing.settled();
    ended(turn, "completed");
    routing.refresh();
    await routing.settled();
    await routing.route(message("tell me about beta"));
    expect(embedded).toEqual([long.slice(0, 320), "tell me about beta"]);
  });

  it("computes the reply of an interrupted turn once", async () => {
    const first = topic(5);
    const routing = await router();
    const turn = started(first);
    const reply = streamed(first, turn, "Beta partial");
    routing.refresh();
    await routing.settled();
    expect(embedded).toEqual([]);
    ended(turn, "interrupted");
    routing.refresh();
    await routing.settled();
    routing.refresh();
    await routing.settled();
    expect(embedded).toEqual(["Beta partial"]);
    expect(stored()).toEqual([{ entry: reply, model: "fake", hash: hashOf("Beta partial") }]);
  });

  it("never computes an entry with empty text", async () => {
    const first = topic(5);
    said(first, "", 5);
    replied(first, "  ", 5);
    const routing = await router();
    await routing.route(message("tell me about beta"));
    expect(embedded).toEqual(["tell me about beta"]);
    expect(stored()).toEqual([]);
  });

  it("routes from a topic's other items while one of its replies streams", async () => {
    const first = topic(60);
    said(first, "alpha project plan", 60);
    streamed(first, started(first), "alpha alpha beta");
    const routing = await router();
    const routed = await routing.route(message("tell me about alpha"));
    expect(routed.decided).toMatchObject({ configuration: "model", rule: "c", topic: first });
    expect(embedded).toEqual(["alpha project plan", "tell me about alpha"]);
  });
});

describe("the model's queue", () => {
  const storedEntries = () => database.connection.prepare("SELECT entry FROM routing_vectors ORDER BY entry").all().map(({ entry }) => entry);

  it("runs a send's computations before queued previews and refresh work, without interrupting the one running", async () => {
    const held = heldModel();
    const routing = await router({ model: held.model, sleep: never });
    said(topic(60), "beta notes", 60);
    said(topic(60), "gamma notes", 60);
    const first = topic(50);
    said(first, "alpha project plan", 50);
    const running = held.nextStart();
    routing.refresh();
    expect(await running).toBe("alpha project plan");
    const previews = Promise.all([routing.route(message("preview one")), routing.route(message("preview two"))]);
    let previewed = false;
    void previews.then(() => {
      previewed = true;
    });
    const sent = routing.route(message("tell me about alpha"), { purpose: "send" });
    expect(await held.releaseThenNext()).toBe("gamma notes");
    expect(await held.releaseThenNext()).toBe("beta notes");
    expect(await held.releaseThenNext()).toBe("tell me about alpha");
    expect(await held.releaseThenNext()).toBe("preview one");
    expect(await sent).toMatchObject({ fallback: null, decided: { configuration: "model", rule: "c", topic: first } });
    expect(previewed).toBe(false);
    expect(await held.releaseThenNext()).toBe("preview two");
    held.release();
    await previews;
    await routing.settled();
    expect(held.started).toEqual(["alpha project plan", "gamma notes", "beta notes", "tell me about alpha", "preview one", "preview two"]);
  });

  it("places a send with the bigram configuration when the model is not ready within the limit, and still stores what it started", async () => {
    const held = heldModel();
    const { sleep, waits } = manualSleep();
    const routing = await router({ model: held.model, sleep });
    const first = topic(60);
    const plan = said(first, "alpha project plan", 60);
    const running = held.nextStart();
    const preview = routing.route(message("other words"));
    expect(await running).toBe("other words");
    const sent = routing.route(message("tell me about alpha"), { purpose: "send" });
    expect(waits.map(({ milliseconds }) => milliseconds)).toEqual([2000]);
    waits[0]!.end();
    expect(await sent).toMatchObject({ fallback: "model busy", shadow: null, decided: { configuration: "bigram" } });
    expect(held.started).toEqual(["other words"]);
    expect(await held.releaseThenNext()).toBe("alpha project plan");
    expect(await held.releaseThenNext()).toBe("tell me about alpha");
    held.release();
    await preview;
    expect(storedEntries()).toEqual([plan]);
    expect((await routing.route(message("tell me about alpha"), { purpose: "send" })).decided).toMatchObject({ configuration: "model", topic: first });
    expect(held.started).toEqual(["other words", "alpha project plan", "tell me about alpha"]);

    const shorter = manualSleep();
    const quick = await router({ model: held.model, sleep: shorter.sleep, sendWaitMilliseconds: 50 });
    void quick.route(message("one more"), { purpose: "send" });
    expect(shorter.waits.map(({ milliseconds }) => milliseconds)).toEqual([50]);
  });

  it("skips a preview's computation once every caller has gone, but not one it shares with a send", async () => {
    said(topic(60), "alpha project plan", 60);
    (await router()).close();
    const held = heldModel();
    const routing = await router({ model: held.model, sleep: never });
    const running = held.nextStart();
    const busy = routing.route(message("first words"));
    expect(await running).toBe("first words");
    const dropped = new AbortController();
    const shared = new AbortController();
    const droppedPreview = routing.route(message("dropped words"), { signal: dropped.signal });
    const sharedPreview = routing.route(message("shared words"), { signal: shared.signal });
    const sent = routing.route(message("shared words"), { purpose: "send" });
    dropped.abort();
    shared.abort();
    await expect(droppedPreview).rejects.toBe(dropped.signal.reason);
    await expect(sharedPreview).rejects.toBe(shared.signal.reason);
    await expect(routing.route(message("late words"), { signal: dropped.signal })).rejects.toBe(dropped.signal.reason);
    expect(await held.releaseThenNext()).toBe("shared words");
    held.release();
    expect((await sent).decided.configuration).toBe("model");
    await busy;
    await routing.settled();
    expect(held.started).toEqual(["first words", "shared words"]);
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

  let key: SigningKey | undefined;

  async function start({ model = fakeModel, sleep }: { model?: ModelLoader; sleep?: Sleep } = {}): Promise<Hub> {
    key ??= await signingKey("key-1");
    hub = await startTestHub({
      config: testConfig(join(dataDir, "hub")),
      keySource: staticKeySource(keySet(key)),
      clock,
      targets: [fakeTarget("hub")],
      credentials: testCredentials,
      routingModel: model,
      ...(sleep === undefined ? {} : { routingSleep: sleep }),
      report: (line) => lines.push(line),
    });
    await hub.conversations.routingSettled();
    return hub;
  }

  const decisions = (running: Hub) => running.database.connection.prepare("SELECT * FROM routing_decisions ORDER BY rowid").all();

  it("uses the loaded model for a preview and records its scores at send time without embedding the draft again", async () => {
    const running = await start();
    const service = running.conversations;
    const topic = service.create().id;
    service.send(topic, "alpha project plan");
    const text = "tell me more about alpha";
    const { proposal } = await service.previewStream({ text, scope: { kind: "daily" }, attachmentNames: [] });
    expect(proposal.decided).toMatchObject({ configuration: "model", rule: "c", topic });
    expect(proposal.shadow?.configuration).toBe("bigram");
    expect(decisions(running)).toEqual([]);
    expect(lines.some((line) => line.startsWith("Topic routing decision "))).toBe(false);
    const item = (await service.sendToStream(topic, text, [], { proposal }))!;
    await service.routingSettled();
    expect(embedded.filter((input) => input === text)).toEqual([text]);
    expect(decisions(running)).toMatchObject([{
      entry: item.entry.id, topic, placed_in: topic, owner_changed: 0, owner_placed: 1,
      configuration: proposal.decided.configuration, best_score: proposal.decided.bestScore,
      shadow_configuration: proposal.shadow?.configuration, shadow_best_score: proposal.shadow?.bestScore,
    }]);
  });

  it("routes only messages without a topic, records and logs each decision without its text and keeps a later move as a correction", async () => {
    const running = await start();
    const service = running.conversations;
    const topic = service.create().id;
    const first = service.send(topic, "alpha project plan")!;
    const direct = (await service.sendToStream(topic, "beta inside the topic", []))!;
    const quoted = (await service.sendToStream(undefined, "a quoted gamma reply", [], { quotedMessage: first.id }))!;
    const inputs: BrainInput[] = [];
    const brain = service.attach({ send: (message) => { if (message.type === "input") inputs.push(message.input); }, close: () => undefined });
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    brain.receive({ type: "turn.started", conversation: topic, turn: "t", provider: "gpt", model: "test", inputs: [] });
    const card = service.askOwner(topic, "t", [{ id: "scope", prompt: "选择范围", required: true, multiple: false, options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }] }])!;
    const answer = service.answerQuestions(topic, card, [{ question: "scope", options: ["a"], text: "" }])!;
    expect(inputs.map(({ id }) => id)).toContain(answer.id);
    expect(inputs.filter(({ id }) => id !== answer.id).map(({ id }) => id)).toEqual([first.id, direct.entry.id, quoted.entry.id]);
    expect(inputs.find(({ id }) => id === quoted.entry.id)?.quote?.id).toBe(first.id);
    expect(inputs.find(({ id }) => id === answer.id)?.questionResponse?.card).toBe(card);
    for (const input of inputs) expect(input).not.toHaveProperty("routing");
    expect(decisions(running)).toEqual([]);

    const routed = (await service.sendToStream(undefined, "tell me more about alpha", []))!;
    expect(routed.topic.id).toBe(topic);
    expect(inputs.at(-1)).toMatchObject({ id: routed.entry.id, routing: { placement: "existing", rule: "c" } });
    expect(decisions(running)).toEqual([{
      entry: routed.entry.id, decided_at: clock.now(), scope: "daily", candidates: 1, configuration: "model", fallback_reason: null,
      rule: "c", topic, placed_in: topic, best_topic: topic, best_score: expect.any(Number), runner_up_score: null,
      shadow_configuration: "bigram", shadow_rule: "c", shadow_topic: topic, shadow_best_topic: topic, shadow_best_score: expect.any(Number), shadow_runner_up_score: null,
      moved_to: null, moved_at: null, owner_changed: 0, owner_placed: 0, brain_moved_to: null, brain_moved_at: null, brain_overridden: 0,
    }]);
    const logged = lines.filter((line) => line.startsWith("Topic routing decision "));
    expect(logged).toEqual([expect.stringContaining(`Topic routing decision ${routed.entry.id}: model rule c topic ${topic}`)]);
    expect(lines.some((line) => /alpha|beta|gamma/.test(line))).toBe(false);

    const other = service.create().id;
    clock.advance(minute);
    expect(service.move(routed.entry.id, other)).toEqual({ ok: true, value: other });
    expect(decisions(running)).toMatchObject([{ entry: routed.entry.id, placed_in: topic, moved_to: other, moved_at: clock.now() }]);
  });

  it("computes a streamed reply once its turn ends, and the reply of a turn the brain lost once", async () => {
    const running = await start();
    const service = running.conversations;
    const topic = service.create().id;
    service.send(topic, "alpha project plan");
    const quiet = { send: () => undefined, close: () => undefined };
    const brain = service.attach(quiet);
    brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
    brain.receive({ type: "turn.started", conversation: topic, turn: "t1", provider: "gpt", model: "test", inputs: [] });
    brain.receive({ type: "text", conversation: topic, turn: "t1", block: "b", delta: "Beta" });
    await service.routingSettled();
    await service.previewStream({ text: "tell me about beta", scope: { kind: "daily" }, attachmentNames: [] });
    brain.receive({ type: "text", conversation: topic, turn: "t1", block: "b", delta: " reply" });
    await service.routingSettled();
    const replies = () => embedded.filter((text) => /^(Beta|Gamma)/.test(text));
    expect(replies()).toEqual([]);
    brain.receive({ type: "turn.finished", conversation: topic, turn: "t1", outcome: "completed", reason: null });
    await service.routingSettled();
    expect(replies()).toEqual(["Beta reply"]);

    brain.receive({ type: "turn.started", conversation: topic, turn: "t2", provider: "gpt", model: "test", inputs: [] });
    brain.receive({ type: "text", conversation: topic, turn: "t2", block: "c", delta: "Gamma partial" });
    await service.routingSettled();
    service.attach(quiet).receive({ type: "hello", protocol: protocolVersion, running: [] });
    await service.routingSettled();
    expect(replies()).toEqual(["Beta reply", "Gamma partial"]);
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

  async function primed(sleep: Sleep = never) {
    const held = heldModel();
    held.state.holding = false;
    const running = await start({ model: held.model, sleep });
    const service = running.conversations;
    const topic = service.create().id;
    service.send(topic, "alpha project plan");
    await service.routingSettled();
    held.state.holding = true;
    const headers = { "Cf-Access-Jwt-Assertion": await assertion({ key: key!, clock }), "content-type": "application/json" };
    const post = (path: string, body: object, signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${running.address.port}${path}`, { method: "POST", headers, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
    return { held, running, service, topic, post };
  }

  const daily = { kind: "daily" } as const;

  it("places a send with the bigram configuration and records why when the model is busy, and stores the vector it started", async () => {
    const { sleep, waits } = manualSleep();
    const { held, running, service } = await primed(sleep);
    const occupied = held.nextStart();
    const preview = service.previewStream({ text: "other words", scope: daily, attachmentNames: [] });
    expect(await occupied).toBe("other words");
    const sending = service.sendToStream(undefined, "tell me about alpha", []);
    expect(waits.map(({ milliseconds }) => milliseconds)).toEqual([2000]);
    waits[0]!.end();
    const item = (await sending)!;
    expect(decisions(running)).toMatchObject([{ entry: item.entry.id, configuration: "bigram", fallback_reason: "model busy", shadow_configuration: null }]);
    expect(lines).toContainEqual(expect.stringContaining(`Topic routing decision ${item.entry.id}: bigram`));
    expect(await held.releaseThenNext()).toBe("tell me about alpha");
    held.release();
    await preview;
    await service.routingSettled();
    expect(held.started).toEqual(["other words", "tell me about alpha"]);
    expect(running.database.connection.prepare("SELECT 1 FROM routing_vectors WHERE entry = ?").all(item.entry.id)).toHaveLength(1);
  });

  it("skips the computation of a preview whose request has gone", async () => {
    const { held, service, post } = await primed();
    const occupied = held.nextStart();
    const busy = service.previewStream({ text: "first words", scope: daily, attachmentNames: [] });
    expect(await occupied).toBe("first words");
    const reached = Promise.withResolvers<AbortSignal>();
    const preview = service.previewStream;
    service.previewStream = (request, signal) => {
      reached.resolve(signal!);
      return preview(request, signal);
    };
    const leaving = new AbortController();
    const request = post("/api/stream/preview", { text: "dropped words", scope: daily, attachmentNames: [] }, leaving.signal);
    const signal = await reached.promise;
    leaving.abort();
    await expect(request).rejects.toThrow();
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    held.release();
    await busy;
    await service.routingSettled();
    expect(held.started).toEqual(["first words"]);
  });

  it("answers a send repeated while it is routed with the same entry, routes it once and refuses other content under its id", async () => {
    const { held, running, service, topic, post } = await primed();
    const reached = { count: 0, second: Promise.withResolvers<void>() };
    const sendOwner = service.sendOwner;
    service.sendOwner = (request) => {
      reached.count += 1;
      if (reached.count === 2) reached.second.resolve();
      return sendOwner(request);
    };
    const id = randomUUID();
    const message = { id, text: "tell me about alpha", scope: daily };
    const occupied = held.nextStart();
    const first = post("/api/stream", message);
    expect(await occupied).toBe("tell me about alpha");
    const second = post("/api/stream", message);
    await reached.second.promise;
    expect((await post("/api/stream", { ...message, text: "something else" })).status).toBe(409);
    held.release();
    const answers = await Promise.all([first, second]);
    expect(answers.map(({ status }) => status)).toEqual([202, 202]);
    const [one, two] = await Promise.all(answers.map((answer) => answer.json()));
    expect(one).toMatchObject({ topic: { id: topic }, entry: { id, text: message.text } });
    expect(two).toEqual(one);
    await service.routingSettled();
    expect(decisions(running)).toMatchObject([{ entry: id }]);
    expect(service.entries(topic).filter(({ kind }) => kind === "owner")).toHaveLength(2);
    expect(running.database.connection.prepare("SELECT * FROM pending_topic_inputs").all()).toEqual([]);
    expect(held.started).toEqual(["tell me about alpha"]);
  });
});
