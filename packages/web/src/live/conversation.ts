import type { Conversation, ConversationDetail, ConversationEntry, ServerMessage, Turn } from "@super-agent2/protocol";

export interface ConversationState {
  readonly id: string;
  readonly conversation: Conversation | undefined;
  readonly turns: readonly Turn[];
  readonly entries: readonly ConversationEntry[];
}

export function emptyConversation(id: string): ConversationState {
  return { id, conversation: undefined, turns: [], entries: [] };
}

function newer(current: Conversation | undefined, incoming: Conversation, ties: boolean): Conversation | undefined {
  if (current === undefined || incoming.updatedAt > current.updatedAt || (ties && incoming.updatedAt === current.updatedAt)) {
    return incoming;
  }
  return current;
}

function mergeTurn(turns: readonly Turn[], incoming: Turn): readonly Turn[] {
  const index = turns.findIndex((turn) => turn.id === incoming.id);
  if (index === -1) {
    return [...turns, incoming].sort((a, b) => a.startedAt - b.startedAt);
  }
  const current = turns[index];
  if (current === undefined || (current.state !== "running" && incoming.state === "running")) {
    return turns;
  }
  const next = [...turns];
  next[index] = incoming;
  return next;
}

function indexOfEntry(entries: readonly ConversationEntry[], id: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.id === id) {
      return index;
    }
  }
  return -1;
}

function placeEntry(entries: readonly ConversationEntry[], incoming: ConversationEntry, replace: boolean): readonly ConversationEntry[] {
  const index = indexOfEntry(entries, incoming.id);
  if (index !== -1) {
    if (!replace) {
      return entries;
    }
    const next = [...entries];
    next[index] = incoming;
    return next;
  }
  let position = entries.length;
  while (position > 0 && (entries[position - 1]?.seq ?? 0) > incoming.seq) {
    position -= 1;
  }
  return [...entries.slice(0, position), incoming, ...entries.slice(position)];
}

function appendTo(entry: ConversationEntry, field: "text" | "output", text: string): ConversationEntry | undefined {
  if (field === "text" && entry.kind === "text") {
    return { ...entry, text: entry.text + text };
  }
  if (field === "output" && entry.kind === "tool") {
    return { ...entry, output: entry.output + text };
  }
  return undefined;
}

export function receive(state: ConversationState, message: ServerMessage): ConversationState {
  switch (message.type) {
    case "conversation": {
      if (message.conversation.id !== state.id) {
        return state;
      }
      const conversation = newer(state.conversation, message.conversation, true);
      return conversation === state.conversation ? state : { ...state, conversation };
    }
    case "turn": {
      if (message.turn.conversation !== state.id) {
        return state;
      }
      const turns = mergeTurn(state.turns, message.turn);
      return turns === state.turns ? state : { ...state, turns };
    }
    case "entry": {
      if (message.entry.conversation !== state.id) {
        return state;
      }
      return { ...state, entries: placeEntry(state.entries, message.entry, true) };
    }
    case "delta": {
      if (message.conversation !== state.id) {
        return state;
      }
      const index = indexOfEntry(state.entries, message.entry);
      const current = state.entries[index];
      const changed = current === undefined ? undefined : appendTo(current, message.field, message.text);
      if (changed === undefined) {
        return state;
      }
      const entries = [...state.entries];
      entries[index] = changed;
      return { ...state, entries };
    }
    default:
      return state;
  }
}

export function receiveDetail(state: ConversationState, detail: Pick<ConversationDetail, "conversation" | "turns">): ConversationState {
  if (detail.conversation.id !== state.id) {
    return state;
  }
  const conversation = newer(state.conversation, detail.conversation, false);
  let turns = state.turns;
  for (const turn of detail.turns) {
    if (turn.conversation === state.id) {
      turns = mergeTurn(turns, turn);
    }
  }
  return conversation === state.conversation && turns === state.turns ? state : { ...state, conversation, turns };
}

export function receiveOwn(state: ConversationState, entry: ConversationEntry): ConversationState {
  if (entry.conversation !== state.id) {
    return state;
  }
  const entries = placeEntry(state.entries, entry, false);
  return entries === state.entries ? state : { ...state, entries };
}

function unsettled(entry: ConversationEntry, finished: ReadonlySet<string>): boolean {
  switch (entry.kind) {
    case "owner":
      return !entry.taken;
    case "tool":
      return entry.state === "running" || !finished.has(entry.turn);
    case "text":
      return !finished.has(entry.turn);
    case "notice":
      return false;
  }
}

export function resumeAfter(state: ConversationState): number {
  const finished = new Set(state.turns.filter((turn) => turn.state !== "running").map((turn) => turn.id));
  let last = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (const entry of state.entries) {
    last = Math.max(last, entry.seq);
    if (unsettled(entry, finished)) {
      lowest = Math.min(lowest, entry.seq);
    }
  }
  return lowest === Number.POSITIVE_INFINITY ? last : lowest - 1;
}

export function runningTurn(state: ConversationState): Turn | undefined {
  return state.turns.findLast((turn) => turn.state === "running");
}

export function isWorking(state: ConversationState): boolean {
  return state.conversation === undefined ? runningTurn(state) !== undefined : state.conversation.state === "working";
}
