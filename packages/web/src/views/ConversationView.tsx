import { text } from "@super-agent2/catalog";
import type { Conversation } from "@super-agent2/protocol";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SocketStatus } from "../hub/socket.js";
import { type ConversationState, isWorking } from "../live/conversation.js";
import { combinedStreamItems, streamItems } from "../live/stream.js";
import type { TopicStreamState } from "../live/topic-stream.js";
import { AttachButton, PendingList, useAttachments } from "../parts/Attachments.js";
import { Icon } from "../parts/icons.js";
import { sendsOnEnter } from "../parts/keys.js";
import { followLink } from "../parts/Shell.js";
import { clockOf, dayLabel, StreamEntry } from "./Entries.js";

const nearBottom = 48;

function titleOf(conversation: { readonly title: string } | undefined): string {
  return conversation?.title || text("conversation.untitled");
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
  readonly send: (message: string, attachments: readonly string[], quotedMessage?: string) => Promise<boolean>;
  readonly stop: () => void;
  readonly draftKey: string;
  readonly quote: QuotePreview | undefined;
  readonly clearQuote: (id: string) => void;
}

interface QuotePreview {
  readonly id: string;
  readonly text: string;
}

function Composer({ working, canStop, send, stop, draftKey, quote, clearQuote }: ComposerProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = drafts[draftKey] ?? "";
  const attaching = useAttachments(draftKey);
  const empty = draft.trim() === "" && attaching.items.length === 0;

  useLayoutEffect(() => {
    const element = field.current;
    if (element !== null) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight + 2, 200)}px`;
    }
  }, [draft]);

  useEffect(() => {
    if (quote !== undefined) {
      field.current?.focus();
    }
  }, [quote]);

  const submit = useCallback(async () => {
    const message = draft.trim();
    if (empty || sending) {
      return;
    }
    setSending(true);
    const attachments = await attaching.settle();
    const sent = attachments === undefined ? false : await send(message, attachments, quote?.id);
    setSending(false);
    if (sent) {
      setDrafts((all) => ({ ...all, [draftKey]: "" }));
      attaching.clear();
      if (quote !== undefined) {
        clearQuote(quote.id);
      }
    }
    field.current?.focus();
  }, [attaching, clearQuote, draft, draftKey, empty, quote, send, sending]);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!sendsOnEnter(event)) {
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
        onDragOver={attaching.over}
        onDrop={attaching.drop}
      >
        {quote === undefined ? null : (
          <div className="composer-quote">
            <Icon name="reply" size={16} />
            <span className="od-truncate">{quote.text}</span>
            <button className="icon-btn" type="button" aria-label={text("conversation.removeQuote")} onClick={() => clearQuote(quote.id)}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        <PendingList attaching={attaching} />
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
          onPaste={attaching.paste}
        />
        <div className="composer-foot">
          <AttachButton add={attaching.add} />
          <span className="od-fill" />
          {working && canStop ? (
            <button className="btn btn-sm" type="button" onClick={stop}>
              <Icon name="stop" />
              {text("composer.stop")}
            </button>
          ) : null}
          <button className={sending ? "btn btn-primary btn-sm is-busy" : "btn btn-primary btn-sm"} type="submit" disabled={empty || sending}>
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
  readonly stream: TopicStreamState | null;
  readonly list: readonly Conversation[];
  readonly status: SocketStatus;
  readonly linked: boolean;
  readonly model: string | null;
  readonly hrefOf: (conversation: string) => string;
  readonly open: (conversation: string) => void;
  readonly send: (message: string, attachments: readonly string[], quotedMessage?: string) => Promise<boolean>;
  readonly stop: () => void;
  readonly loadOlder: () => void;
  readonly now: number;
}

export function ConversationView(props: ConversationViewProps) {
  const { state, stream, now } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const older = useRef<{ readonly height: number; readonly top: number } | null>(null);
  const picker = useRef<HTMLDialogElement>(null);
  const [quotes, setQuotes] = useState<Readonly<Record<string, QuotePreview | undefined>>>({});
  const items = useMemo(
    () => stream === null ? (state === null ? [] : streamItems(state, now)) : combinedStreamItems(stream.entries.map(({ entry }) => entry), stream.turns, now),
    [state, stream, now],
  );
  const topics = useMemo(() => {
    const titles = new Map(stream?.entries.map(({ topic }) => [topic.id, topic.title]));
    for (const topic of props.list) {
      titles.set(topic.id, topic.title);
    }
    return titles;
  }, [stream, props.list]);
  const working = state !== null && isWorking(state);
  const conversationId = state?.id ?? null;
  const draftKey = conversationId ?? "";
  const thisYear = new Date(now).getFullYear();
  const clearQuote = useCallback((id: string) => {
    setQuotes((all) => all[draftKey]?.id === id ? { ...all, [draftKey]: undefined } : all);
  }, [draftKey]);

  useLayoutEffect(() => {
    following.current = true;
    older.current = null;
  }, [conversationId]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) {
      return;
    }
    if (older.current !== null && !stream?.loading) {
      element.scrollTop = older.current.top + element.scrollHeight - older.current.height;
      older.current = null;
    } else if (following.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [items, stream?.loading]);

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
    async (message: string, attachments: readonly string[], quotedMessage?: string) => {
      following.current = true;
      return props.send(message, attachments, quotedMessage);
    },
    [props.send],
  );

  const pick = (conversation: string) => {
    picker.current?.close();
    props.open(conversation);
  };

  const title = stream === null ? titleOf(state?.conversation) : text("conversation.all");
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
          className={stream === null ? "stream" : "stream stream--combined"}
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < nearBottom;
          }}
        >
          <div className="stream-inner" role="log" aria-label={text("conversation.stream")}>
            {stream?.before != null ? (
              <button className="btn btn-sm stream-older" type="button" disabled={stream.loading || !online} onClick={() => {
                const element = scroller.current;
                if (element !== null) {
                  following.current = false;
                  older.current = { height: element.scrollHeight, top: element.scrollTop };
                }
                props.loadOlder();
              }}>{text("conversation.older")}</button>
            ) : null}
            {items.map((item) => {
              const id = item.kind === "entry" ? item.entry.conversation : item.kind === "ended" ? item.turn.conversation : null;
              const topic = stream === null || id === null ? undefined : (
                <a className="topic-label od-truncate" href={props.hrefOf(id)} onClick={(event) => followLink(event, () => props.open(id))}>
                  {topics.get(id) || text("conversation.untitled")}
                </a>
              );
              const quote = item.kind === "entry" ? () => {
                const { entry } = item;
                const fallback = entry.kind === "owner" ? entry.attachments[0]?.name : entry.kind === "delivery" ? entry.title.zh : undefined;
                setQuotes((all) => ({ ...all, [draftKey]: { id: entry.id, text: (entry.text?.trim() || fallback || text("conversation.quote")).slice(0, 240) } }));
              } : undefined;
              return <StreamEntry key={item.key} item={item} thisYear={thisYear} topic={topic} quote={quote} />;
            })}
          </div>
        </div>
        <Composer working={working} canStop={conversationId !== null} send={send} stop={props.stop} draftKey={draftKey}
          quote={quotes[draftKey]} clearQuote={clearQuote} />
      </div>
      <aside className="rail" aria-label={text("conversation.list")}>
        <ConversationList list={props.list} current={conversationId} hrefOf={props.hrefOf} open={props.open} now={now} />
      </aside>
      <dialog className="dlg" ref={picker} aria-label={text("conversation.list")}>
        <div className="dlg-in">
          <div className="dlg-head">
            <h2>{text("conversation.list")}</h2>
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
