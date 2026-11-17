import type { Conversation, ConversationDetail, ConversationEntry, ConversationList, ServerMessage } from "@super-agent2/protocol";
import type { SocketStatus } from "../hub/socket.js";
import { type ConversationState, emptyConversation, receive, receiveDetail, receiveOwn } from "./conversation.js";
import { mergeConversations, upsertConversation } from "./list.js";

export interface PageState {
  readonly status: SocketStatus;
  readonly linked: boolean;
  readonly listed: boolean;
  readonly list: readonly Conversation[];
  readonly current: ConversationState | null;
}

export type PageAction =
  | { readonly type: "status"; readonly status: SocketStatus }
  | { readonly type: "server"; readonly message: ServerMessage }
  | { readonly type: "list"; readonly list: ConversationList }
  | { readonly type: "detail"; readonly detail: ConversationDetail }
  | { readonly type: "open"; readonly conversation: string | null }
  | { readonly type: "created"; readonly conversation: Conversation }
  | { readonly type: "own"; readonly entry: ConversationEntry };

export const initialPage: PageState = { status: "connecting", linked: false, listed: false, list: [], current: null };

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
    case "server": {
      const { message } = action;
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
