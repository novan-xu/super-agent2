import type { PushSubscriptionRequest } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { isAuthSecret, isPublicKey, type PushTarget } from "./push.js";

export interface SubscriptionStore {
  save(request: PushSubscriptionRequest, origin: string): void;
  remove(endpoint: string): boolean;
  list(vapidKey: string): PushTarget[];
}

const Row = z.object({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
  origin: z.string(),
});

const loopbackHosts: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function acceptableSubscription(request: PushSubscriptionRequest): boolean {
  if (!isPublicKey(request.keys.p256dh) || !isAuthSecret(request.keys.auth)) {
    return false;
  }
  try {
    const url = new URL(request.endpoint);
    return url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname));
  } catch {
    return false;
  }
}

export function createSubscriptionStore(database: HubDatabase, clock: Clock): SubscriptionStore {
  const { connection } = database;
  const upsert = connection.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, vapid_key, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, vapid_key = excluded.vapid_key, origin = excluded.origin`,
  );
  const remove = connection.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?");
  const select = connection.prepare("SELECT endpoint, p256dh, auth, origin FROM push_subscriptions WHERE vapid_key = ? ORDER BY created_at, endpoint");
  return {
    save: (request, origin) => {
      upsert.run(request.endpoint, request.keys.p256dh, request.keys.auth, request.applicationServerKey, origin, clock.now());
    },
    remove: (endpoint) => Number(remove.run(endpoint).changes) > 0,
    list: (vapidKey) => select.all(vapidKey).map((row) => Row.parse(row)),
  };
}
