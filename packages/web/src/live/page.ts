import type { Conversation, ConversationDetail, ConversationEntry, ConversationList, ServerMessage, StoredWorkEvent, TicketDetail } from "@super-agent2/protocol";
import type { SocketStatus } from "../hub/socket.js";
import { type ConversationState, emptyConversation, receive, receiveDetail, receiveOwn } from "./conversation.js";
import { mergeConversations, upsertConversation } from "./list.js";
import { type DetailState, openDetail, receiveDetail as receiveTicketDetail, receiveDetailWork, receiveMissing, receiveTicketChange } from "./detail.js";
import { initialTickets, receiveTicket, receiveTickets, type TicketsState } from "./tickets.js";
import { initialWaiting, type WaitingAction, type WaitingState, waitingReducer } from "./waiting.js";

export interface PageState {
  readonly status: SocketStatus;
  readonly linked: boolean;
  readonly listed: boolean;
  readonly list: readonly Conversation[];
  readonly current: ConversationState | null;
  readonly waiting: WaitingState;
  readonly tickets: TicketsState;
  readonly detail: DetailState | null;
}

export type PageAction =
  | { readonly type: "status"; readonly status: SocketStatus }
  | { readonly type: "server"; readonly message: ServerMessage }
  | { readonly type: "list"; readonly list: ConversationList }
  | { readonly type: "detail"; readonly detail: ConversationDetail }
  | { readonly type: "open"; readonly conversation: string | null }
  | { readonly type: "created"; readonly conversation: Conversation }
  | { readonly type: "own"; readonly entry: ConversationEntry }
  | { readonly type: "waiting"; readonly action: WaitingAction }
  | { readonly type: "ticket.open"; readonly ticket: number | null }
  | { readonly type: "ticket.detail"; readonly detail: TicketDetail }
  | { readonly type: "ticket.missing"; readonly ticket: number }
  | { readonly type: "ticket.work"; readonly events: readonly StoredWorkEvent[] };

export const initialPage: PageState = { status: "connecting", linked: false, listed: false, list: [], current: null, waiting: initialWaiting, tickets: initialTickets, detail: null };

function withDetail(state: PageState, detail: DetailState | null): PageState {
  return detail === state.detail ? state : { ...state, detail };
}

function withCurrent(state: PageState, current: ConversationState | null): PageState {
  return current === state.current ? state : { ...state, current };
}

export function pageReducer(state: PageState, action: PageAction): PageState {
  switch (action.type) {
    case "status":
      return action.status === state.status ? state : { ...state, status: action.status };
    case "list":
      return { ...state, listed: true, linked: action.list.brain.linked, list: mergeConversations(state.list, action.list.conversations) };
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
    case "server": {
      const { message } = action;
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
        return withDetail({ ...state, tickets: receiveTickets(message.tickets) }, detail === null || changed === undefined ? detail : receiveTicketChange(detail, changed));
      }
      if (message.type === "ticket") {
        const tickets = receiveTicket(state.tickets, message.ticket);
        const next = tickets === state.tickets ? state : { ...state, tickets };
        return withDetail(next, state.detail === null ? null : receiveTicketChange(state.detail, message.ticket));
      }
      if (message.type === "brain") {
        return message.brain.linked === state.linked ? state : { ...state, linked: message.brain.linked };
      }
      const list = message.type === "conversation" ? upsertConversation(state.list, message.conversation) : state.list;
      const next = list === state.list ? state : { ...state, list };
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
