import type { ServerMessage, StreamEntry, Turn } from "@super-agent2/protocol";
import { appendTo, mergeTurn, unsettled } from "./conversation.js";

export interface TopicStreamState {
  readonly entries: readonly StreamEntry[];
  readonly turns: readonly Turn[];
  readonly before: number | null;
  readonly loading: boolean;
  readonly revision?: number | undefined;
}

export const initialTopicStream: TopicStreamState = { entries: [], turns: [], before: null, loading: false };

export function resumeStream(state: TopicStreamState): number | undefined {
  const finished = new Set(state.turns.filter((turn) => turn.state !== "running").map((turn) => turn.id));
  const firstUnsettled = state.entries.find(({ entry }) => unsettled(entry, finished));
  return firstUnsettled === undefined ? state.entries.at(-1)?.position : firstUnsettled.position - 1;
}

export function receiveStream(state: TopicStreamState, message: ServerMessage): TopicStreamState {
  switch (message.type) {
    case "stream.page": {
      const previous = message.reset ? initialTopicStream : state;
      const entries = new Map(previous.entries.map((item) => [item.position, item]));
      for (const item of message.entries) {
        entries.set(item.position, item);
      }
      return {
        entries: [...entries.values()].sort((a, b) => a.position - b.position),
        turns: message.turns.reduce(mergeTurn, message.resumed === true ? previous.turns.filter((turn) => turn.state !== "running") : previous.turns),
        before: message.resumed === true ? previous.before : message.before,
        revision: message.revision ?? previous.revision,
        loading: false,
      };
    }
    case "stream.entry": {
      const { position, topic, entry, latestOwner } = message;
      if (state.before !== null && position < state.before) {
        return state;
      }
      const index = state.entries.findIndex((item) => item.position >= position);
      const entries = [...state.entries];
      const item = { position, topic, entry, ...(latestOwner === undefined ? {} : { latestOwner }) };
      if (index === -1) {
        entries.push(item);
      } else {
        entries.splice(index, entries[index]?.position === position ? 1 : 0, item);
      }
      return { ...state, entries };
    }
    case "delta": {
      const index = state.entries.findLastIndex(({ entry }) => entry.id === message.entry);
      const current = state.entries[index];
      const entry = current === undefined ? undefined : appendTo(current.entry, message.field, message.text);
      if (current === undefined || entry === undefined) {
        return state;
      }
      const entries = [...state.entries];
      entries[index] = { ...current, entry };
      return { ...state, entries };
    }
    case "turn": {
      const turns = mergeTurn(state.turns, message.turn);
      return turns === state.turns ? state : { ...state, turns };
    }
    default:
      return state;
  }
}
