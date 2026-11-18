import type { AllowanceReport, Conversation, ConversationDetail, ConversationEntry, ConversationList, ServerMessage, SettingsSnapshot, StoredWorkEvent, TicketDetail, TicketHistory } from "@super-agent2/protocol";
import type { SocketStatus } from "../hub/socket.js";
import { type ConversationState, emptyConversation, receive, receiveDetail, receiveOwn } from "./conversation.js";
import { type HistoryState, initialHistory, moreFailed, moreStarted, pageFailed, receiveEnded, receiveMore, receivePage, startLoading, typeQuery } from "./history.js";
import { mergeConversations, upsertConversation } from "./list.js";
import { initialMemory, type MemoryState, receiveMemories } from "./memory.js";
import { type DetailState, openDetail, receiveDetail as receiveTicketDetail, receiveDetailWork, receiveMissing, receiveTicketChange } from "./detail.js";
import { initialTickets, receiveTicket, receiveTickets, type TicketsState } from "./tickets.js";
import { initialTopicStream, receiveStream, type TopicStreamState } from "./topic-stream.js";
import { initialWaiting, type WaitingAction, type WaitingState, waitingReducer } from "./waiting.js";

export interface PageState {
  readonly status: SocketStatus;
  readonly linked: boolean;
  readonly list: readonly Conversation[];
  readonly current: ConversationState | null;
  readonly streaming: boolean;
  readonly stream: TopicStreamState;
  readonly waiting: WaitingState;
  readonly tickets: TicketsState;
  readonly detail: DetailState | null;
  readonly history: HistoryState;
  readonly memory: MemoryState;
  readonly settings: SettingsSnapshot | null;
  readonly allowance: AllowanceReport | null;
}

export type PageAction =
  | { readonly type: "status"; readonly status: SocketStatus }
  | { readonly type: "server"; readonly message: ServerMessage }
  | { readonly type: "list"; readonly list: ConversationList }
  | { readonly type: "detail"; readonly detail: ConversationDetail }
  | { readonly type: "open"; readonly conversation: string | null }
  | { readonly type: "created"; readonly conversation: Conversation }
  | { readonly type: "own"; readonly entry: ConversationEntry }
  | { readonly type: "stream.open"; readonly watching: boolean }
  | { readonly type: "stream.more" }
  | { readonly type: "waiting"; readonly action: WaitingAction }
  | { readonly type: "ticket.open"; readonly ticket: number | null }
  | { readonly type: "ticket.detail"; readonly detail: TicketDetail }
  | { readonly type: "ticket.missing"; readonly ticket: number }
  | { readonly type: "ticket.work"; readonly events: readonly StoredWorkEvent[] }
  | { readonly type: "history.query"; readonly query: string }
  | { readonly type: "history.loading" }
  | { readonly type: "history.page"; readonly applied: string; readonly page: TicketHistory }
  | { readonly type: "history.failed"; readonly applied: string }
  | { readonly type: "history.more"; readonly applied: string; readonly before: string; readonly page: TicketHistory }
  | { readonly type: "history.more.started" }
  | { readonly type: "history.more.failed"; readonly applied: string }
  | { readonly type: "settings"; readonly settings: SettingsSnapshot };

export const initialPage: PageState = { status: "connecting", linked: false, list: [], current: null, streaming: false, stream: initialTopicStream, waiting: initialWaiting, tickets: initialTickets, detail: null, history: initialHistory, memory: initialMemory, settings: null, allowance: null };

function withDetail(state: PageState, detail: DetailState | null): PageState {
  return detail === state.detail ? state : { ...state, detail };
}

function withHistory(state: PageState, history: HistoryState): PageState {
  return history === state.history ? state : { ...state, history };
}

function withCurrent(state: PageState, current: ConversationState | null): PageState {
  return current === state.current ? state : { ...state, current };
}

export function pageReducer(state: PageState, action: PageAction): PageState {
  switch (action.type) {
    case "status":
      return action.status === state.status ? state : { ...state, status: action.status, stream: state.stream.loading ? { ...state.stream, loading: false } : state.stream };
    case "list":
      return { ...state, linked: action.list.brain.linked, list: mergeConversations(state.list, action.list.conversations) };
    case "detail": {
      const list = upsertConversation(state.list, action.detail.conversation);
      const next = list === state.list ? state : { ...state, list };
      return withCurrent(next, state.current === null ? null : receiveDetail(state.current, action.detail));
    }
    case "open":
      if (state.current?.id === action.conversation) {
        return state;
      }
      return { ...state, current: action.conversation === null ? null : emptyConversation(action.conversation) };
    case "created":
      return { ...state, list: upsertConversation(state.list, action.conversation) };
    case "own":
      return withCurrent(state, state.current === null ? null : receiveOwn(state.current, action.entry));
    case "stream.open":
      return state.streaming === action.watching ? state : { ...state, streaming: action.watching, stream: state.stream.loading ? { ...state.stream, loading: false } : state.stream };
    case "stream.more":
      return { ...state, stream: { ...state.stream, loading: true } };
    case "waiting": {
      const waiting = waitingReducer(state.waiting, action.action);
      return waiting === state.waiting ? state : { ...state, waiting };
    }
    case "ticket.open":
      if ((state.detail?.id ?? null) === action.ticket) {
        return state;
      }
      return withDetail(state, action.ticket === null ? null : openDetail(action.ticket));
    case "ticket.detail":
      return withDetail(state, state.detail === null ? null : receiveTicketDetail(state.detail, action.detail));
    case "ticket.missing":
      return withDetail(state, state.detail?.id === action.ticket ? receiveMissing(state.detail) : state.detail);
    case "ticket.work":
      return withDetail(state, state.detail === null ? null : receiveDetailWork(state.detail, action.events));
    case "history.query":
      return withHistory(state, typeQuery(state.history, action.query));
    case "history.loading":
      return withHistory(state, startLoading(state.history));
    case "history.page":
      return withHistory(state, receivePage(state.history, action.applied, action.page));
    case "history.failed":
      return withHistory(state, pageFailed(state.history, action.applied));
    case "history.more":
      return withHistory(state, receiveMore(state.history, action.applied, action.before, action.page));
    case "history.more.started":
      return withHistory(state, moreStarted(state.history));
    case "history.more.failed":
      return withHistory(state, moreFailed(state.history, action.applied));
    case "settings":
      return { ...state, settings: action.settings };
    case "server": {
      const { message } = action;
      if (message.type === "allowance") return { ...state, allowance: message.allowance };
      if (message.type === "settings") {
        return { ...state, settings: message.settings };
      }
      if (message.type === "work") {
        return withDetail(state, state.detail === null ? null : receiveDetailWork(state.detail, [message.event]));
      }
      if (message.type === "waiting") {
        const waiting = waitingReducer(state.waiting, { type: "snapshot", cards: message.cards });
        return waiting === state.waiting ? state : { ...state, waiting };
      }
      if (message.type === "tickets") {
        const detail = state.detail;
        const changed = detail === null ? undefined : message.tickets.find((ticket) => ticket.id === detail.id);
        return withDetail({ ...state, tickets: receiveTickets(message.tickets, message.reviews) }, detail === null || changed === undefined ? detail : receiveTicketChange(detail, changed));
      }
      if (message.type === "ticket") {
        const tickets = receiveTicket(state.tickets, message.ticket);
        const history = receiveEnded(state.history, message.ticket);
        const next = tickets === state.tickets && history === state.history ? state : { ...state, tickets, history };
        return withDetail(next, state.detail === null ? null : receiveTicketChange(state.detail, message.ticket));
      }
      if (message.type === "memories") {
        return { ...state, memory: receiveMemories(message) };
      }
      if (message.type === "brain") {
        return message.brain.linked === state.linked ? state : { ...state, linked: message.brain.linked };
      }
      const list = message.type === "conversation" ? upsertConversation(state.list, message.conversation) : state.list;
      const stream = state.streaming ? receiveStream(state.stream, message) : state.stream;
      const next = list === state.list && stream === state.stream ? state : { ...state, list, stream };
      return withCurrent(next, state.current === null ? null : receive(state.current, message));
    }
  }
}

export interface PageStore {
  getState(): PageState;
  dispatch(action: PageAction): void;
  subscribe(listener: () => void): () => void;
}

export function createPageStore(initial: PageState = initialPage): PageStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = pageReducer(state, action);
      if (next !== state) {
        state = next;
        for (const listener of listeners) {
          listener();
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
