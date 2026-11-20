import { createHash } from "node:crypto";
import { type Clock, type Sleep, systemClock, systemSleep } from "./clock.js";
import { ticketReferences } from "./ticket-codes.js";
import { openTicketStates, RoutingProposal, type TopicScope } from "@super-agent2/protocol";
import {
  bigramConfiguration,
  bigramSimilarity,
  bigramVector,
  characterLength,
  type Configuration,
  type ConfigurationName,
  configurations,
  decide,
  endsWithQuestion,
  namedReferences,
  ownerTextLimit,
  rank,
  recentOwnerItems,
  recentReplyItems,
  type Reference,
  referencesIn,
  replyTextLimit,
  type RouteCandidate,
  type RouteInput,
  type Scorer,
  type Vector,
} from "@super-agent2/routing";
import { z } from "zod";
import type { HubDatabase } from "./database.js";

export type ModelLoader = () => Promise<Scorer>;

export interface RoutingOptions {
  readonly primary?: ConfigurationName | undefined;
  readonly model?: ModelLoader | undefined;
  readonly report?: ((line: string) => void) | undefined;
  readonly clock?: Clock | undefined;
  readonly sendWaitMilliseconds?: number | undefined;
  readonly sleep?: Sleep | undefined;
}

export const defaultSendWaitMilliseconds = 2000;

export type RoutingPurpose = "send" | "preview";

export interface RouteOptions {
  readonly purpose?: RoutingPurpose | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RoutingMessage {
  readonly text: string;
  readonly attachments: readonly { readonly name: string }[];
  readonly scope: TopicScope;
  readonly at: number;
}

type ConfigurationDecision = RoutingProposal["decided"];

export interface Routing extends RoutingProposal {
  readonly topic: string | null;
  readonly repository: string | null;
}

export interface TopicRouter {
  route(message: RoutingMessage, options?: RouteOptions): Promise<Routing>;
  routeNow(message: RoutingMessage, reason: string): Routing;
  repositoryFor(text: string, scope: TopicScope): string | null;
  record(entry: string, placedIn: string, scope: TopicScope["kind"], routing: RoutingProposal, at: number, owner: { ownerChanged: boolean; ownerPlaced: boolean }): void;
  log(entry: string, placedIn: string, scope: TopicScope["kind"], routing: RoutingProposal, ownerChanged: boolean): void;
  refresh(): void;
  settled(): Promise<void>;
  close(): void;
}

type ModelState =
  | { readonly kind: "missing" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly scorer: Scorer }
  | { readonly kind: "failed" };

const fallbackReasons = { missing: "model not configured", loading: "model loading", failed: "model failed to load" } as const;

export const modelBusyReason = "model busy";

const recentTextLimit = 128;

type Priority = RoutingPurpose | "refresh";

const ranks: Readonly<Record<Priority, number>> = { send: 0, preview: 1, refresh: 2 };

interface Demand {
  readonly priority: Priority;
  readonly signal?: AbortSignal | undefined;
}

interface Computation {
  readonly key: string;
  readonly scorer: Scorer;
  readonly text: string;
  readonly result: PromiseWithResolvers<Vector>;
  rank: number;
  waiting: number;
  started: boolean;
}

const TopicRow = z.object({ id: z.string(), repository: z.string().nullable(), activity: z.number().int() });
const EntryRow = z.object({ id: z.string(), kind: z.string(), body: z.string() });
const ItemRow = EntryRow.extend({ streaming: z.number().int().optional() });
const Id = z.object({ id: z.string() });
const Conversation = z.object({ conversation_id: z.string() });
const Repository = z.object({ repository: z.string() });
const StoredVector = z.object({ vector: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength % 4 === 0) });
const Body = z.looseObject({
  text: z.string().optional(),
  attachments: z.array(z.looseObject({ name: z.string().optional() })).optional(),
  questions: z.unknown().optional(),
  answer: z.unknown().optional(),
});

interface Item {
  readonly id: string;
  readonly text: string;
}

interface TopicContext {
  readonly id: string;
  readonly repository: string | null;
  readonly idleMs: number;
  readonly items: readonly Item[];
}

interface Context {
  readonly message: RoutingMessage;
  readonly topics: readonly TopicContext[];
  readonly input: RouteInput;
}

function bodyOf(raw: string): z.infer<typeof Body> {
  try {
    const parsed = Body.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function ownerText(body: z.infer<typeof Body>): string {
  const text = body.text ?? "";
  return text.trim() === "" ? (body.attachments ?? []).map((item) => item.name ?? "").join(" ") : text;
}

function entryText(kind: string, body: z.infer<typeof Body>): string {
  if (kind === "owner") {
    return ownerText(body);
  }
  if (kind === "question") {
    return JSON.stringify(body.questions ?? []);
  }
  return body.text ?? "";
}

function textHash(text: string): Uint8Array {
  return createHash("sha256").update(text, "utf8").digest();
}

function vectorBytes(vector: Vector): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function storedVector(bytes: Uint8Array): Vector {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function namedRepository(text: string, known: readonly string[]): string | null {
  const lowered = text.toLowerCase();
  const found = new Map<string, string>();
  for (const repository of known) {
    const full = repository.toLowerCase();
    const name = full.slice(full.indexOf("/") + 1);
    const whole = (value: string) => new RegExp(`(?<![\\w./-])${escaped(value)}(?![\\w/-]|\\.\\w)`).test(lowered);
    if (whole(full) || whole(name)) {
      found.set(full, repository);
    }
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

function format(value: number | null): string {
  return value === null ? "-" : value.toFixed(3);
}

function describe(decision: ConfigurationDecision): string {
  return `${decision.configuration} rule ${decision.rule} topic ${decision.topic ?? "new"} best ${decision.best ?? "-"} ${format(decision.bestScore)} runner-up ${format(decision.runnerUpScore)}`;
}

export function createTopicRouter(database: HubDatabase, options: RoutingOptions = {}): TopicRouter {
  const { connection } = database;
  const primary = options.primary ?? "model";
  const report = options.report ?? (() => undefined);
  const listTopics = connection.prepare(`
    SELECT id, repository, max(activity_at, created_at) AS activity FROM conversations
    WHERE topic_state = 'active' AND merged_into IS NULL AND system = 0
      AND (CASE ? WHEN 'daily' THEN repository IS NULL AND needs_repository = 0
        WHEN 'code' THEN repository IS NOT NULL OR needs_repository = 1
        WHEN 'repository' THEN repository = ? COLLATE NOCASE ELSE 1 END)
      AND NOT EXISTS (SELECT 1 FROM topic_merges WHERE source = conversations.id OR destination = conversations.id)
    ORDER BY max(activity_at, created_at) DESC, rowid DESC
  `);
  const activeTopics = connection.prepare(`
    SELECT id FROM conversations WHERE topic_state = 'active' AND merged_into IS NULL AND system = 0
    ORDER BY max(activity_at, created_at) DESC, rowid DESC
  `);
  const firstOwner = connection.prepare("SELECT id, kind, body FROM conversation_entries WHERE conversation_id = ? AND kind = 'owner' ORDER BY seq LIMIT 1");
  const recentOwners = connection.prepare(`SELECT id, kind, body FROM conversation_entries WHERE conversation_id = ? AND kind = 'owner' ORDER BY seq DESC LIMIT ${recentOwnerItems}`);
  const recentReplies = connection.prepare(`
    SELECT id, kind, body, kind = 'text' AND EXISTS (SELECT 1 FROM turns WHERE turns.id = conversation_entries.turn_id AND turns.state = 'running') AS streaming
    FROM conversation_entries WHERE conversation_id = ? AND kind IN ('text', 'question') ORDER BY seq DESC LIMIT ${recentReplyItems}
  `);
  const lastExchange = connection.prepare("SELECT id, kind, body FROM conversation_entries WHERE conversation_id = ? AND kind IN ('owner', 'text', 'question') ORDER BY seq DESC LIMIT 1");
  const exchange = connection.prepare("SELECT id, kind, body FROM conversation_entries WHERE conversation_id = ? AND kind IN ('owner', 'text', 'question') ORDER BY seq");
  const ticketCodes = ticketReferences(connection);
  const ticketTopics = connection.prepare("SELECT conversation_id FROM tickets WHERE id = ? AND conversation_id IS NOT NULL");
  const issueTopics = connection.prepare(`
    SELECT t.conversation_id FROM ticket_issues i JOIN tickets t ON t.id = i.ticket_id WHERE i.number = ? AND t.conversation_id IS NOT NULL
    UNION SELECT t.conversation_id FROM ticket_pull_requests p JOIN tickets t ON t.id = p.ticket_id WHERE p.number = ? AND t.conversation_id IS NOT NULL
    UNION SELECT conversation_id FROM tickets WHERE pull_request = ? AND conversation_id IS NOT NULL
  `);
  const openTicketRepositories = connection.prepare(`
    SELECT DISTINCT repository FROM tickets
    WHERE repository IS NOT NULL AND joined_into IS NULL AND state IN (${openTicketStates.map(() => "?").join(", ")})
  `);
  const insertDecision = connection.prepare(`
    INSERT INTO routing_decisions (
      entry, decided_at, scope, candidates, configuration, fallback_reason, rule, topic, placed_in, best_topic, best_score, runner_up_score,
      shadow_configuration, shadow_rule, shadow_topic, shadow_best_topic, shadow_best_score, shadow_runner_up_score, owner_changed, owner_placed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectVector = connection.prepare("SELECT vector FROM routing_vectors WHERE entry = ? AND model = ? AND text_hash = ?");
  const dropOtherTexts = connection.prepare("DELETE FROM routing_vectors WHERE entry = ? AND model = ? AND text_hash <> ?");
  const insertVector = connection.prepare(`
    INSERT INTO routing_vectors (entry, model, text_hash, vector, computed_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM conversation_entries WHERE id = ?)
    ON CONFLICT (entry, model, text_hash) DO NOTHING
  `);

  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? systemSleep;
  const sendWait = options.sendWaitMilliseconds ?? defaultSendWaitMilliseconds;
  const vectors = new Map<string, { readonly text: string; readonly vector: Vector }>();
  const recent = new Map<string, Vector>();
  const computing = new Map<string, Computation>();
  const queued: Computation[] = [];
  let model: ModelState = options.model === undefined ? { kind: "missing" } : { kind: "loading" };
  let running = false;
  let pumping = false;
  let closed = false;
  let refreshing: Promise<void> | undefined;
  let dirty = false;
  let loading: Promise<void> = Promise.resolve();

  const itemsOf = (topic: string): Item[] => {
    const rows = [...firstOwner.all(topic), ...recentOwners.all(topic).reverse(), ...recentReplies.all(topic).reverse()].map((row) => ItemRow.parse(row));
    const seen = new Set<string>();
    const items: Item[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      const text = entryText(row.kind, bodyOf(row.body));
      const limit = row.kind === "owner" ? ownerTextLimit : replyTextLimit;
      const settled = row.streaming !== 1 || text.length >= limit;
      if (settled && text.trim() !== "") {
        items.push({ id: row.id, text: text.slice(0, limit) });
      }
    }
    return items;
  };

  const waiting = (topic: string): { readonly open: boolean; readonly openCard: boolean } => {
    const row = lastExchange.get(topic);
    if (row === undefined) {
      return { open: false, openCard: false };
    }
    const { kind, body } = EntryRow.parse(row);
    const parsed = bodyOf(body);
    if (kind === "question") {
      const unanswered = parsed.answer === null || parsed.answer === undefined;
      return { open: unanswered, openCard: unanswered };
    }
    return { open: kind === "text" && endsWithQuestion(parsed.text ?? ""), openCard: false };
  };

  const referencedTopics = (references: readonly Reference[], topics: readonly TopicContext[]): Set<string> => {
    const byKey = new Map<string, Reference>();
    for (const reference of references) {
      const known = byKey.get(reference.key);
      if (known === undefined || known.kind === "number") {
        byKey.set(reference.key, reference);
      }
    }
    const candidateIds = new Set(topics.map(({ id }) => id));
    const textual = new Map<string, Set<string>>();
    const textReferences = (topic: string): Set<string> => {
      const cached = textual.get(topic);
      if (cached !== undefined) {
        return cached;
      }
      const found = new Set<string>();
      for (const row of exchange.all(topic).map((value) => EntryRow.parse(value))) {
        for (const key of referencesIn(entryText(row.kind, bodyOf(row.body)), row.kind === "owner")) {
          found.add(key);
        }
      }
      textual.set(topic, found);
      return found;
    };
    const result = new Set<string>();
    for (const reference of byKey.values()) {
      const number = Number(reference.value);
      const ticket = reference.kind !== "ticket" ? undefined : Number.isNaN(number) ? ticketCodes.resolve(reference.value) : number;
      const linked = ticket !== undefined ? ticketTopics.all(ticket)
        : reference.kind === "issue" ? issueTopics.all(number, number, number) : [];
      const topicsOfReference = linked.map((row) => Conversation.parse(row).conversation_id);
      if (topicsOfReference.length > 0) {
        topicsOfReference.filter((id) => candidateIds.has(id)).forEach((id) => result.add(id));
        continue;
      }
      for (const topic of topics) {
        if (textReferences(topic.id).has(reference.key)) {
          result.add(topic.id);
        }
      }
    }
    return result;
  };

  const gather = (message: RoutingMessage): Context => {
    const rows = listTopics.all(message.scope.kind, message.scope.kind === "repository" ? message.scope.repository : null).map((row) => TopicRow.parse(row));
    const topics = rows.map((row): TopicContext => ({ id: row.id, repository: row.repository, idleMs: Math.max(0, message.at - row.activity), items: itemsOf(row.id) }));
    const references = namedReferences(message.text, true);
    const referenced = references.length === 0 ? new Set<string>() : referencedTopics(references, topics);
    const candidates = topics.map((topic): RouteCandidate => ({ topic: topic.id, idleMs: topic.idleMs, ...waiting(topic.id), referenced: referenced.has(topic.id) }));
    return {
      message,
      topics,
      input: { length: characterLength(message.text), attachments: message.attachments.length > 0, hasReferences: references.length > 0, candidates },
    };
  };

  const scoresOf = (context: Context, messageVector: Vector, vectorOf: (item: Item) => Vector, similarity: (left: Vector, right: Vector) => number): number[] =>
    context.topics.map((topic) => topic.items.reduce((best, item) => Math.max(best, similarity(messageVector, vectorOf(item))), -Infinity));

  const evaluate = (configuration: Configuration, context: Context, scores: readonly number[]): ConfigurationDecision => {
    const choice = decide(context.input, configuration.rules, scores);
    const ranking = rank(context.input.candidates, scores, configuration.rules.time);
    return {
      configuration: configuration.name,
      rule: RoutingProposal.shape.decided.shape.rule.parse(choice.rule),
      topic: choice.topic,
      best: ranking.best,
      bestScore: finite(ranking.bestScore),
      runnerUpScore: finite(ranking.runnerUpScore),
    };
  };

  const bigramDecision = (context: Context): ConfigurationDecision => {
    const messageVector = bigramVector(context.message.text.slice(0, ownerTextLimit));
    return evaluate(bigramConfiguration, context, scoresOf(context, messageVector, (item) => bigramVector(item.text), bigramSimilarity));
  };

  const remember = (key: string, vector: Vector) => {
    recent.delete(key);
    recent.set(key, vector);
    for (const oldest of recent.keys()) {
      if (recent.size <= recentTextLimit) {
        break;
      }
      recent.delete(oldest);
    }
  };

  const startNext = () => {
    if (running || queued.length === 0) {
      return;
    }
    let chosen = 0;
    for (let index = 1; index < queued.length; index += 1) {
      if (queued[index]!.rank < queued[chosen]!.rank) {
        chosen = index;
      }
    }
    const [computation] = queued.splice(chosen, 1);
    if (computation === undefined) {
      return;
    }
    computation.started = true;
    running = true;
    let represented: Promise<Vector>;
    try {
      represented = Promise.resolve(computation.scorer.represent(computation.text));
    } catch (error) {
      represented = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    represented
      .then(
        (vector) => {
          remember(computation.key, vector);
          computing.delete(computation.key);
          computation.result.resolve(vector);
        },
        (error: unknown) => {
          computing.delete(computation.key);
          computation.result.reject(error);
        },
      )
      .finally(() => {
        running = false;
        pump();
      });
  };

  const pump = () => {
    if (running || pumping || queued.length === 0) {
      return;
    }
    pumping = true;
    queueMicrotask(() => {
      pumping = false;
      startNext();
    });
  };

  const skip = (computation: Computation, reason: unknown) => {
    const index = queued.indexOf(computation);
    if (index >= 0) {
      queued.splice(index, 1);
    }
    computing.delete(computation.key);
    computation.result.reject(reason);
  };

  const join = (computation: Computation, signal: AbortSignal | undefined): Promise<Vector> => {
    computation.waiting += 1;
    if (signal === undefined) {
      return computation.result.promise;
    }
    return new Promise<Vector>((resolve, reject) => {
      const leave = () => {
        computation.waiting -= 1;
        if (computation.waiting === 0 && !computation.started) {
          skip(computation, signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", leave, { once: true });
      computation.result.promise.then(
        (vector) => {
          signal.removeEventListener("abort", leave);
          resolve(vector);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", leave);
          reject(error);
        },
      );
    });
  };

  const textVector = (scorer: Scorer, text: string, demand: Demand): Promise<Vector> => {
    if (demand.signal?.aborted === true) {
      return Promise.reject(demand.signal.reason);
    }
    const key = JSON.stringify([scorer.identity, text]);
    const known = recent.get(key);
    if (known !== undefined) {
      remember(key, known);
      return Promise.resolve(known);
    }
    const rank = ranks[demand.priority];
    let computation = computing.get(key);
    if (computation === undefined) {
      computation = { key, scorer, text, result: Promise.withResolvers<Vector>(), rank, waiting: 0, started: false };
      computation.result.promise.catch(() => undefined);
      computing.set(key, computation);
      queued.push(computation);
    } else if (!computation.started) {
      computation.rank = Math.min(computation.rank, rank);
    }
    const waiting = join(computation, demand.signal);
    pump();
    return waiting;
  };

  const modelVector = async (scorer: Scorer, item: Item, demand: Demand): Promise<Vector> => {
    const known = vectors.get(item.id);
    if (known !== undefined && known.text === item.text) {
      return known.vector;
    }
    const hash = textHash(item.text);
    const row = selectVector.get(item.id, scorer.identity, hash);
    if (row !== undefined) {
      const vector = storedVector(StoredVector.parse(row).vector);
      vectors.set(item.id, { text: item.text, vector });
      return vector;
    }
    const vector = await textVector(scorer, item.text, demand);
    if (closed) {
      return vector;
    }
    dropOtherTexts.run(item.id, scorer.identity, hash);
    insertVector.run(item.id, scorer.identity, hash, vectorBytes(vector), clock.now(), item.id);
    vectors.set(item.id, { text: item.text, vector });
    return vector;
  };

  const modelDecision = async (scorer: Scorer, context: Context, demand: Demand): Promise<ConfigurationDecision> => {
    if (context.topics.length === 0) {
      return evaluate(configurations.model, context, []);
    }
    const items = context.topics.flatMap((topic) => topic.items);
    const [messageVector, ...found] = await Promise.all([
      textVector(scorer, context.message.text.slice(0, ownerTextLimit), demand),
      ...items.map((item) => modelVector(scorer, item, demand)),
    ]);
    const itemVectors = new Map(items.map((item, index) => [item.id, found[index]!]));
    return evaluate(configurations.model, context, scoresOf(context, messageVector!, (item) => itemVectors.get(item.id)!, scorer.similarity));
  };

  const boundedDecision = async (decision: Promise<ConfigurationDecision>): Promise<ConfigurationDecision | undefined> => {
    const stop = new AbortController();
    try {
      return await Promise.race([decision, sleep(sendWait, stop.signal).then(() => undefined)]);
    } finally {
      stop.abort();
    }
  };

  const repositoryFor = (text: string, scope: TopicScope, topics?: readonly { readonly repository: string | null }[]): string | null => {
    if (scope.kind === "repository") {
      return scope.repository;
    }
    if (scope.kind === "daily") {
      return null;
    }
    const known = new Map<string, string>();
    const names = [
      ...(topics ?? listTopics.all(scope.kind, null).map((row) => TopicRow.parse(row)))
        .flatMap(({ repository }) => (repository === null ? [] : [repository])),
      ...openTicketRepositories.all(...openTicketStates).map((row) => Repository.parse(row).repository),
    ];
    for (const name of names) {
      if (!known.has(name.toLowerCase())) {
        known.set(name.toLowerCase(), name);
      }
    }
    return namedRepository(text, [...known.values()]);
  };

  const finish = (context: Context, decided: ConfigurationDecision, shadow: ConfigurationDecision | null, fallback: string | null): Routing => ({
    candidates: context.topics.length,
    topic: decided.topic,
    possibleMatch: decided.topic === null ? (decided.best ?? context.topics[0]?.id) : undefined,
    repository: decided.topic === null ? repositoryFor(context.message.text, context.message.scope, context.topics) : null,
    decided,
    shadow,
    fallback,
  });

  const allItems = (): Item[] => activeTopics.all().flatMap((row) => itemsOf(Id.parse(row).id));

  const runRefresh = async (scorer: Scorer) => {
    while (dirty && !closed) {
      dirty = false;
      const items = allItems();
      const keep = new Set(items.map(({ id }) => id));
      for (const item of items) {
        if (closed) {
          return;
        }
        try {
          await modelVector(scorer, item, { priority: "refresh" });
        } catch (error) {
          report(`Topic routing could not embed a topic text in the background: ${error instanceof Error ? error.name : "unknown error"}`);
        }
      }
      for (const id of vectors.keys()) {
        if (!keep.has(id)) {
          vectors.delete(id);
        }
      }
    }
  };

  const refresh = () => {
    dirty = true;
    if (refreshing !== undefined || closed || model.kind !== "ready") {
      return;
    }
    const scorer = model.scorer;
    refreshing = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => runRefresh(scorer))
      .finally(() => {
        refreshing = undefined;
      });
  };

  if (options.model !== undefined) {
    const load = options.model;
    loading = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => load())
      .then(
        (scorer) => {
          if (closed) {
            return;
          }
          model = { kind: "ready", scorer };
          report(`Topic routing model ${scorer.name} loaded in ${Math.round(scorer.loadMs)} ms`);
          refresh();
        },
        (error: unknown) => {
          model = { kind: "failed" };
          report(`Topic routing model failed to load; routing uses the ${bigramConfiguration.name} configuration: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
  }

  return {
    repositoryFor,
    route: async (message, { purpose = "preview", signal } = {}) => {
      signal?.throwIfAborted();
      const context = gather(message);
      const bigram = bigramDecision(context);
      let modelResult: ConfigurationDecision | undefined;
      let reason: string | null = null;
      const state = model;
      if (state.kind === "ready") {
        try {
          const decision = modelDecision(state.scorer, context, { priority: purpose, signal });
          if (purpose === "send") {
            decision.catch(() => undefined);
            modelResult = await boundedDecision(decision);
            reason = modelResult === undefined ? modelBusyReason : null;
          } else {
            modelResult = await decision;
          }
        } catch (error) {
          signal?.throwIfAborted();
          reason = `embedding failed: ${error instanceof Error ? error.name : "unknown error"}`;
        }
      } else {
        reason = fallbackReasons[state.kind];
      }
      if (primary === "model") {
        return modelResult === undefined ? finish(context, bigram, null, reason) : finish(context, modelResult, bigram, null);
      }
      return finish(context, bigram, modelResult ?? null, null);
    },
    routeNow: (message, reason) => {
      const context = gather(message);
      return finish(context, bigramDecision(context), null, primary === "bigram" ? null : reason);
    },
    record: (entry, placedIn, scope, routing, at, { ownerChanged, ownerPlaced }) => {
      const { decided, shadow } = routing;
      insertDecision.run(
        entry, at, scope, routing.candidates, decided.configuration, routing.fallback, decided.rule, decided.topic, placedIn,
        decided.best, decided.bestScore, decided.runnerUpScore,
        shadow?.configuration ?? null, shadow?.rule ?? null, shadow?.topic ?? null, shadow?.best ?? null, shadow?.bestScore ?? null, shadow?.runnerUpScore ?? null,
        Number(ownerChanged), Number(ownerPlaced),
      );
    },
    log: (entry, placedIn, scope, routing, ownerChanged) => {
      const parts = [
        `Topic routing decision ${entry}: ${describe(routing.decided)} placed in ${placedIn}`,
        `${routing.candidates} candidates in ${scope}`,
        ...(ownerChanged ? ["destination changed by owner"] : []),
        `shadow ${routing.shadow === null ? "none" : describe(routing.shadow)}`,
        ...(routing.fallback === null ? [] : [`fallback: ${routing.fallback}`]),
      ];
      report(parts.join("; "));
    },
    refresh,
    settled: async () => {
      await loading;
      while (refreshing !== undefined) {
        await refreshing;
      }
    },
    close: () => {
      closed = true;
    },
  };
}
