import { pagePath, type PushPayload, type PushSubscriptionRequest } from "@super-agent2/protocol";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { createNotifier, fitsPush, type Notifier } from "./notifier.js";
import { createPushSender, type VapidKeys } from "./push.js";
import { acceptableSubscription, createSubscriptionStore } from "./subscriptions.js";
import type { Waiting } from "./waiting.js";

export interface PushSettings extends VapidKeys {
  readonly subject?: string | undefined;
}

export type SubscribeOutcome = "saved" | "invalid" | "mismatch";

export interface PushService {
  readonly publicKey: string;
  subscribe(request: PushSubscriptionRequest, origin: string): SubscribeOutcome;
  unsubscribe(endpoint: string): boolean;
  inbox(source: string, message: string, topic: string): void;
  transfer(source: string, files: readonly string[], entry: number): void;
  health(message: string, topic: string, key: string): void;
  hasSubscribers(): boolean;
  todo(payload: PushPayload): Promise<void>;
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface PushServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly settings: PushSettings;
  readonly fetch: typeof fetch;
  readonly waiting: Waiting;
}

export function createPushService(options: PushServiceOptions): PushService {
  const store = createSubscriptionStore(options.database, options.clock);
  const stopping = new AbortController();
  const sender = createPushSender({
    keys: options.settings,
    subject: options.settings.subject,
    fetch: options.fetch,
    clock: options.clock,
    stopped: stopping.signal,
  });
  const notifier: Notifier = createNotifier({
    waiting: options.waiting,
    store,
    sender,
    vapidKey: options.settings.publicKey,
  });
  const pending = new Set<Promise<void>>();
  const send = (payload: PushPayload) => {
    const work = Promise.all(store.list(options.settings.publicKey).map(async (target) => {
      const result = await sender.send(target, payload).catch(() => "failed" as const);
      if (result === "gone") store.remove(target.endpoint);
    })).then(() => undefined).finally(() => pending.delete(work));
    pending.add(work);
    return work;
  };
  return {
    publicKey: options.settings.publicKey,
    subscribe: (request, origin) => {
      if (!acceptableSubscription(request)) {
        return "invalid";
      }
      if (request.applicationServerKey !== options.settings.publicKey) {
        return "mismatch";
      }
      store.save(request, origin);
      return "saved";
    },
    unsubscribe: (endpoint) => store.remove(endpoint),
    hasSubscribers: () => store.list(options.settings.publicKey).length > 0,
    todo: send,
    health: (message, topic, key) => {
      send({ title: "System", body: [...message].slice(0, 160).join(""), url: pagePath({ view: "conversations", conversation: topic, scope: { kind: "daily" } }), tag: `health:${key}` });
    },
    inbox: (source, message, topic) => {
      send({ title: source, body: [...message].slice(0, 160).join(""), url: pagePath({ view: "conversations", conversation: topic, scope: { kind: "daily" } }), tag: `inbox:${topic}` });
    },
    transfer: (source, files, entry) => {
      const names = files.map((name) => [...name]);
      const payload = (limit: number): PushPayload => ({
        title: source,
        body: names.map((name) => name.length <= limit ? name.join("") : `${name.slice(0, limit).join("")}…`).join(", "),
        url: pagePath({ view: "transfer" }),
        tag: `transfer:${entry}`,
      });
      let limit = Math.max(...names.map((name) => name.length));
      while (!fitsPush(payload(limit))) limit = Math.floor(limit / 2);
      send(payload(limit));
    },
    idle: async () => { await notifier.idle(); await Promise.all([...pending]); },
    close: async () => {
      stopping.abort();
      await notifier.close();
      await Promise.all([...pending]);
    },
  };
}
