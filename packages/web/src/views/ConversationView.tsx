import { text } from "@super-agent2/catalog";
import type { Conversation } from "@super-agent2/protocol";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SocketStatus } from "../hub/socket.js";
import { type ConversationState, isWorking } from "../live/conversation.js";
import { streamItems } from "../live/stream.js";
import { Icon } from "../parts/icons.js";
import { followLink } from "../parts/Shell.js";
import { clockOf, dayLabel, StreamEntry } from "./Entries.js";

const nearBottom = 48;

function titleOf(conversation: Conversation | undefined): string {
  return conversation === undefined || conversation.title === "" ? text("conversation.new") : conversation.title;
}

function whenOf(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return clockOf(at);
  }
  return dayLabel({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), relative: null }, today.getFullYear());
}

interface ListProps {
  readonly list: readonly Conversation[];
  readonly current: string | null;
  readonly hrefOf: (conversation: string) => string;
  readonly open: (conversation: string) => void;
  readonly now: number;
}

function ConversationList({ list, current, hrefOf, open, now }: ListProps) {
  return (
    <ul className="conv-list">
      {list.map((conversation) => (
        <li key={conversation.id}>
          <a
            className="rail-item"
            href={hrefOf(conversation.id)}
            aria-current={conversation.id === current ? "page" : undefined}
            onClick={(event) => followLink(event, () => open(conversation.id))}
          >
            <span className="ri-title od-truncate">{titleOf(conversation)}</span>
            <span className="ri-meta">
              {conversation.state === "working" ? <span className="dot dot--ok dot--live" /> : null}
              <span className="num">{whenOf(conversation.updatedAt, now)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

interface ComposerProps {
  readonly working: boolean;
  readonly canStop: boolean;
  readonly send: (message: string) => Promise<boolean>;
  readonly stop: () => void;
  readonly draftKey: string;
}

function Composer({ working, canStop, send, stop, draftKey }: ComposerProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = drafts[draftKey] ?? "";

  useLayoutEffect(() => {
    const element = field.current;
    if (element !== null) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight + 2, 200)}px`;
    }
  }, [draft]);

  const submit = useCallback(async () => {
    const message = draft.trim();
    if (message === "" || sending) {
      return;
    }
    setSending(true);
    const sent = await send(message);
    setSending(false);
    if (sent) {
      setDrafts((all) => ({ ...all, [draftKey]: "" }));
    }
    field.current?.focus();
  }, [draft, draftKey, send, sending]);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (window.matchMedia("(pointer: coarse)").matches && !(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    void submit();
  };

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={field}
          rows={1}
          value={draft}
          aria-label={text("composer.label")}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((all) => ({ ...all, [draftKey]: value }));
          }}
          onKeyDown={keyDown}
        />
        <div className="composer-foot">
          <span className="od-fill" />
          {working && canStop ? (
            <button className="btn btn-sm" type="button" onClick={stop}>
              <Icon name="stop" />
              {text("composer.stop")}
            </button>
          ) : null}
          <button className={sending ? "btn btn-primary btn-sm is-busy" : "btn btn-primary btn-sm"} type="submit" disabled={draft.trim() === "" || sending}>
            <Icon name="send" />
            {text("composer.send")}
          </button>
        </div>
      </form>
    </div>
  );
}

export interface ConversationViewProps {
  readonly state: ConversationState | null;
  readonly list: readonly Conversation[];
  readonly status: SocketStatus;
  readonly linked: boolean;
  readonly model: string | null;
  readonly hrefOf: (conversation: string) => string;
  readonly open: (conversation: string) => void;
  readonly send: (message: string) => Promise<boolean>;
  readonly stop: () => void;
  readonly now: number;
}

export function ConversationView(props: ConversationViewProps) {
  const { state, now } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const picker = useRef<HTMLDialogElement>(null);
  const items = useMemo(() => (state === null ? [] : streamItems(state, now)), [state, now]);
  const working = state !== null && isWorking(state);
  const conversationId = state?.id ?? null;
  const thisYear = new Date(now).getFullYear();

  useLayoutEffect(() => {
    following.current = true;
  }, [conversationId]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [items]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (following.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const send = useCallback(
    async (message: string) => {
      following.current = true;
      return props.send(message);
    },
    [props.send],
  );

  const pick = (conversation: string) => {
    picker.current?.close();
    props.open(conversation);
  };

  const title = state === null ? text("conversation.new") : titleOf(state.conversation);
  const online = props.status === "open";
  const lastModel = state?.turns.at(-1)?.model ?? props.model;

  return (
    <div className="conv">
      <div className="conv-main">
        <div className="conv-bar">
          <button className="conv-pick" type="button" aria-haspopup="dialog" onClick={() => picker.current?.showModal()}>
            <span className="od-truncate">{title}</span>
            <Icon name="down" size={16} />
          </button>
          <h2 className="conv-title od-truncate">{title}</h2>
          <span className="od-fill" />
          <span className="brain-chip">
            <span className={`dot ${!online ? "dot--warn" : props.linked ? "dot--ok" : "dot--bad"}`} />
            {online ? <span>{text("brain.name")}</span> : null}
            {!online ? (
              <span>{text("hub.reconnecting")}</span>
            ) : props.linked ? (
              lastModel === null ? null : <span className="mono">{lastModel}</span>
            ) : (
              <span>{text("brain.offline")}</span>
            )}
          </span>
        </div>
        <div
          className="stream"
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < nearBottom;
          }}
        >
          <div className="stream-inner" role="log" aria-label={text("conversation.stream")}>
            {items.map((item) => (
              <StreamEntry key={item.key} item={item} thisYear={thisYear} />
            ))}
          </div>
        </div>
        <Composer working={working} canStop={conversationId !== null} send={send} stop={props.stop} draftKey={conversationId ?? ""} />
      </div>
      <aside className="rail" aria-label={text("conversation.list")}>
        <ConversationList list={props.list} current={conversationId} hrefOf={props.hrefOf} open={props.open} now={now} />
      </aside>
      <dialog className="dlg" ref={picker} aria-label={text("conversation.list")}>
        <div className="dlg-in">
          <div className="dlg-head">
            <h2>{text("navigation.conversation")}</h2>
            <button className="icon-btn" type="button" aria-label={text("conversation.close")} onClick={() => picker.current?.close()}>
              <Icon name="x" />
            </button>
          </div>
          <ConversationList list={props.list} current={conversationId} hrefOf={props.hrefOf} open={pick} now={now} />
        </div>
      </dialog>
    </div>
  );
}
