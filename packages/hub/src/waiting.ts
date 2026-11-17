import { cardKey, type HoldCard, type StartCard, type WaitingCard } from "@super-agent2/protocol";
import type { CommandService } from "./commands.js";
import type { ConfirmationLock } from "./lock.js";
import type { TicketService } from "./tickets.js";

export type WaitingListener = (cards: readonly WaitingCard[]) => void;

export interface Waiting {
  cards(): WaitingCard[];
  subscribe(listener: WaitingListener): () => void;
  refresh(): void;
  close(): void;
}

export interface WaitingOptions {
  readonly commands: CommandService;
  readonly lock: ConfirmationLock | undefined;
  readonly tickets?: TicketService;
  readonly starts?: () => StartCard[];
}

export function newestFirst(cards: readonly WaitingCard[]): WaitingCard[] {
  return [...cards].sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
}

export function holdCards(options: WaitingOptions): HoldCard[] {
  const cards: HoldCard[] = [];
  for (const hold of options.lock?.waiting() ?? []) {
    const command = options.commands.get(hold.command);
    if (command !== undefined && command.state === "held") {
      cards.push({ kind: "hold", key: cardKey("hold", command.id), at: hold.heldAt, command, hold });
    }
  }
  return cards;
}

export function allCards(options: WaitingOptions): WaitingCard[] {
  return newestFirst([...holdCards(options), ...(options.starts?.() ?? [])]);
}

export function createWaiting(options: WaitingOptions): Waiting {
  const listeners = new Set<WaitingListener>();
  let current = allCards(options);
  let closed = false;
  let scheduled = false;

  const refresh = () => {
    if (closed) {
      return;
    }
    const next = allCards(options);
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return;
    }
    current = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        continue;
      }
    }
  };

  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      refresh();
    });
  };

  const unsubscribeCommands = options.commands.subscribe((event) => {
    if (event.type !== "command" || scheduled) {
      return;
    }
    const key = cardKey("hold", event.command.id);
    if (event.command.state !== "held" && !current.some((card) => card.key === key)) {
      return;
    }
    schedule();
  });

  const unsubscribeTickets = options.starts === undefined ? () => undefined : (options.tickets?.subscribe(() => schedule()) ?? (() => undefined));

  const unsubscribe = () => {
    unsubscribeCommands();
    unsubscribeTickets();
  };

  return {
    cards: () => {
      refresh();
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    close: () => {
      closed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
