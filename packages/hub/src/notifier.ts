import { text } from "@super-agent2/catalog";
import { cardAddress, type PushPayload, type WaitingCard } from "@super-agent2/protocol";
import type { PushSender } from "./push.js";
import type { SubscriptionStore } from "./subscriptions.js";
import type { Waiting } from "./waiting.js";

export interface Notifier {
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface NotifierOptions {
  readonly waiting: Waiting;
  readonly store: SubscriptionStore;
  readonly sender: PushSender;
  readonly vapidKey: string;
}

export function payloadOf(card: WaitingCard): PushPayload {
  switch (card.kind) {
    case "hold":
      return {
        title: text("waiting.title"),
        body: text("notice.waiting.hold"),
        url: cardAddress(card.key),
        tag: card.key,
      };
    case "start":
      return {
        title: text("waiting.title"),
        body: text("notice.waiting.start"),
        url: cardAddress(card.key),
        tag: "start",
      };
  }
}

export function noticeKey(card: WaitingCard): string | undefined {
  if (card.kind === "start") {
    return card.before.length === 0 ? `${card.key}:ready` : undefined;
  }
  return card.key;
}

export function arrivals(known: ReadonlySet<string>, cards: readonly WaitingCard[]): WaitingCard[] {
  const arrived = cards.filter((card) => {
    const key = noticeKey(card);
    return key !== undefined && !known.has(key);
  });
  const holds = arrived.filter((card) => card.kind !== "start");
  const start = arrived.find((card) => card.kind === "start");
  return start === undefined ? holds : [...holds, start];
}

function noticeKeys(cards: readonly WaitingCard[]): string[] {
  return cards.flatMap((card) => {
    const key = noticeKey(card);
    return key === undefined ? [] : [key];
  });
}

export function createNotifier(options: NotifierOptions): Notifier {
  const pending = new Set<Promise<void>>();
  const known = new Set(noticeKeys(options.waiting.cards()));
  let closed = false;

  const deliver = async (card: WaitingCard): Promise<void> => {
    const payload = payloadOf(card);
    const targets = options.store.list(options.vapidKey);
    await Promise.all(
      targets.map(async (target) => {
        const outcome = await options.sender.send(target, payload).catch(() => "failed" as const);
        if (outcome === "gone") {
          options.store.remove(target.endpoint);
        }
      }),
    );
  };

  const unsubscribe = options.waiting.subscribe((cards) => {
    const present = new Set(noticeKeys(cards));
    const arrived = closed ? [] : arrivals(known, cards);
    known.clear();
    for (const key of present) {
      known.add(key);
    }
    for (const card of arrived) {
      const work = deliver(card)
        .catch(() => undefined)
        .finally(() => pending.delete(work));
      pending.add(work);
    }
  });

  const idle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  };

  return {
    idle,
    close: async () => {
      closed = true;
      unsubscribe();
      await idle();
    },
  };
}
