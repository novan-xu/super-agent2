import { text } from "@super-agent2/catalog";
import { cardAddress, type PushPayload, type WaitingCard } from "@super-agent2/protocol";
import { maximumPlaintext, type PushSender } from "./push.js";
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

const ellipsis = "…";

export function fitsPush(payload: PushPayload): boolean {
  return Buffer.byteLength(JSON.stringify(payload), "utf8") <= maximumPlaintext;
}

export function holdPayload(key: string, target: string, command: string): PushPayload {
  const shaped = (shown: string): PushPayload => ({
    title: text("waiting.title"),
    body: text("notice.waiting.hold", { target, command: shown }),
    url: cardAddress(key),
    tag: key,
  });
  const whole = shaped(command);
  if (fitsPush(whole)) {
    return whole;
  }
  const characters = [...command];
  const clipped = (count: number) => shaped(`${characters.slice(0, count).join("")}${ellipsis}`);
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsPush(clipped(middle))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const shortest = clipped(low);
  return fitsPush(shortest) ? shortest : { ...shortest, body: text("notice.waiting.holdPlain") };
}

export function payloadOf(card: WaitingCard): PushPayload {
  switch (card.kind) {
    case "hold":
      return holdPayload(card.key, card.command.target, card.command.command);
    case "start":
      return {
        title: text("waiting.title"),
        body: text("notice.waiting.start"),
        url: cardAddress(card.key),
        tag: "start",
      };
    case "stuck":
      return {
        title: text("waiting.title"),
        body: text("notice.waiting.stuck", { ticket: card.ticket.code, round: card.ticket.stuck?.round ?? card.ticket.round }),
        url: cardAddress(card.key),
        tag: card.key,
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
