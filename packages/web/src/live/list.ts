import type { Conversation } from "@super-agent2/protocol";

function order(a: Conversation, b: Conversation): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function pick(current: Conversation | undefined, incoming: Conversation, ties: boolean): Conversation {
  if (current === undefined || incoming.updatedAt > current.updatedAt || (ties && incoming.updatedAt === current.updatedAt)) {
    return incoming;
  }
  return current;
}

export function upsertConversation(list: readonly Conversation[], incoming: Conversation): readonly Conversation[] {
  const current = list.find((conversation) => conversation.id === incoming.id);
  const chosen = pick(current, incoming, true);
  if (chosen === current) {
    return list;
  }
  return [...list.filter((conversation) => conversation.id !== incoming.id), chosen].sort(order);
}

export function mergeConversations(list: readonly Conversation[], fetched: readonly Conversation[]): readonly Conversation[] {
  const byId = new Map(list.map((conversation) => [conversation.id, conversation]));
  for (const incoming of fetched) {
    byId.set(incoming.id, pick(byId.get(incoming.id), incoming, false));
  }
  return [...byId.values()].sort(order);
}
