import { text } from "@super-agent2/catalog";
import { type Conversation, type ConversationEntry, type StreamEntry as StreamRecord, type TopicScope, topicInScope } from "@super-agent2/protocol";
import { type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SocketStatus } from "../hub/socket.js";
import { type ConversationState, isWorking } from "../live/conversation.js";
import { combinedStreamItems, streamItems } from "../live/stream.js";
import { topicScopeKey } from "../live/topic-scope.js";
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
  readonly showRepository: boolean;
}

type TopicHeading = StreamRecord["topic"];

function repositoryOf(topic: TopicHeading | undefined): string | null {
  return topic?.repository ?? (topic?.needsRepository === true ? text("conversation.repository.pending") : null);
}

export function TopicList({ list, current, hrefOf, open, now, showRepository }: ListProps) {
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
              {conversation.state === "working" ? <span className="dot dot--ok dot--live" role="img" aria-label={text("conversation.answering")} /> : null}
              {showRepository ? <span className="od-truncate">{repositoryOf(conversation)}</span> : null}
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

export function TopicComposer({ working, canStop, send, stop, draftKey, quote, clearQuote }: ComposerProps) {
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
  readonly conversation: string | null;
  readonly scope: TopicScope;
  readonly state: ConversationState | null;
  readonly stream: TopicStreamState | null;
  readonly list: readonly Conversation[];
  readonly status: SocketStatus;
  readonly linked: boolean;
  readonly model: string | null;
  readonly hrefOf: (conversation: string) => string;
  readonly open: (conversation: string) => void;
  readonly streamHref: string;
  readonly openStream: () => void;
  readonly navigation?: ReactNode;
  readonly compact?: boolean;
  readonly send: (message: string, attachments: readonly string[], quotedMessage?: string) => Promise<boolean>;
  readonly stop: () => void;
  readonly loadOlder: () => void;
  readonly now: number;
}

export function ConversationView(props: ConversationViewProps) {
  const { state, stream, now, conversation, scope, list, hrefOf, open } = props;
  const following = useRef(true);
  const picker = useRef<HTMLDialogElement>(null);
  const [quotes, setQuotes] = useState<Readonly<Record<string, QuotePreview | undefined>>>({});
  const working = state !== null && isWorking(state);
  const draftKey = conversation === null ? `scope:${topicScopeKey(scope)}` : `topic:${conversation}`;
  const showRepository = scope.kind === "code";
  const filtered = useMemo(() => list.filter((topic) => topicInScope(topic, scope)), [list, scope]);
  const clearQuote = useCallback((id: string) => {
    setQuotes((all) => all[draftKey]?.id === id ? { ...all, [draftKey]: undefined } : all);
  }, [draftKey]);
  const selectQuote = useCallback((entry: VisibleEntry) => {
    setQuotes((all) => ({ ...all, [draftKey]: { id: entry.id, text: previewOf(entry) } }));
  }, [draftKey]);

  const send = useCallback(
    async (message: string, attachments: readonly string[], quotedMessage?: string) => {
      following.current = true;
      return props.send(message, attachments, quotedMessage);
    },
    [props.send],
  );

  const pick = (conversation: string) => {
    picker.current?.close();
    open(conversation);
  };

  const title = titleOf(state?.conversation ?? list.find((topic) => topic.id === conversation));
  const online = props.status === "open";
  const lastModel = state?.turns.at(-1)?.model ?? props.model;

  return (
    <div className={props.compact === true ? "conv conv--solo conv--compact" : "conv"}>
      <div className="conv-main">
        <div className="conv-bar">
          {props.navigation}
          <div className="conv-toolbar">
            {conversation === null ? null : (
              <div className="conv-current">
                <a className="icon-btn" aria-label={text("conversation.backToStream")} href={props.streamHref}
                  onClick={(event) => followLink(event, props.openStream)}><Icon name="back" size={16} /></a>
                <h2 className="conv-title od-truncate">{title}</h2>
              </div>
            )}
            <button className="conv-pick" type="button" aria-haspopup="dialog" onClick={() => picker.current?.showModal()}>
              {text("conversation.list")}
              <Icon name="down" size={16} />
            </button>
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
        </div>
        <TopicStream key={draftKey} state={state} stream={stream} scope={scope} list={list} online={online} now={now}
          following={following} hrefOf={hrefOf} open={open} loadOlder={props.loadOlder} selectQuote={selectQuote} />
        <TopicComposer working={working} canStop={conversation !== null} send={send} stop={props.stop} draftKey={draftKey}
          quote={quotes[draftKey]} clearQuote={clearQuote} />
      </div>
      {props.compact === true ? null : (
        <aside className="rail" aria-label={text("conversation.list")}>
          <TopicList list={filtered} current={conversation} hrefOf={hrefOf} open={open} now={now} showRepository={showRepository} />
        </aside>
      )}
      <dialog className="dlg" ref={picker} aria-label={text("conversation.list")}>
        <div className="dlg-in">
          <div className="dlg-head">
            <h2>{text("conversation.list")}</h2>
            <button className="icon-btn" type="button" aria-label={text("conversation.close")} onClick={() => picker.current?.close()}>
              <Icon name="x" />
            </button>
          </div>
          <TopicList list={filtered} current={conversation} hrefOf={hrefOf} open={pick} now={now} showRepository={showRepository} />
        </div>
      </dialog>
    </div>
  );
}

type VisibleEntry = Exclude<ConversationEntry, { kind: "tool" }>;

function previewOf(entry: VisibleEntry): string {
  const fallback = entry.kind === "owner" ? entry.attachments[0]?.name : entry.kind === "delivery" ? entry.title.zh : undefined;
  return (entry.text?.trim() || fallback || text("conversation.quote")).slice(0, 240);
}

function toneOf(id: string): number {
  let hash = 0;
  for (const character of id) {
    hash = Math.imul(31, hash) + character.charCodeAt(0);
  }
  return (hash >>> 0) % 4;
}

interface TopicStreamProps {
  readonly state: ConversationState | null;
  readonly stream: TopicStreamState | null;
  readonly scope: TopicScope;
  readonly list: readonly Conversation[];
  readonly online: boolean;
  readonly now: number;
  readonly following: RefObject<boolean>;
  readonly hrefOf: (topic: string) => string;
  readonly open: (topic: string) => void;
  readonly loadOlder: () => void;
  readonly selectQuote: (entry: VisibleEntry) => void;
}

export function TopicStream({ state, stream, scope, list, online, now, following, hrefOf, open, loadOlder, selectQuote }: TopicStreamProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const older = useRef<{ readonly height: number; readonly top: number } | null>(null);
  const topics = useMemo(() => {
    const found = new Map(stream?.entries.map(({ topic }) => [topic.id, topic]));
    for (const topic of list) {
      found.set(topic.id, topic);
    }
    return found;
  }, [stream, list]);
  const entries = useMemo(() => stream === null ? state?.entries ?? [] : stream.entries.flatMap(({ entry, topic }) =>
    topicInScope(topics.get(topic.id) ?? topic, scope) ? [entry] : []), [state, stream, topics, scope]);
  const previews = useMemo(() => new Map(entries.flatMap((entry) => entry.kind === "tool" ? [] : [[entry.id, entry] as const])), [entries]);
  const items = useMemo(() => {
    if (stream === null) {
      return state === null ? [] : streamItems(state, now);
    }
    const turns = stream.turns.filter((turn) => {
      const topic = topics.get(turn.conversation);
      return topic !== undefined && topicInScope(topic, scope);
    });
    return combinedStreamItems(entries, turns, now);
  }, [state, stream, entries, topics, scope, now]);
  const thisYear = new Date(now).getFullYear();

  useLayoutEffect(() => {
    following.current = true;
  }, [following]);
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
  }, [items, stream?.loading, following]);

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
  }, [following]);

  const topicLabel = (id: string) => {
    const topic = topics.get(id);
    return (
      <a className={`topic-label topic-tone-${toneOf(id)}`} href={hrefOf(id)} onClick={(event) => followLink(event, () => open(id))}>
        <span className="od-truncate">{titleOf(topic)}</span>
        {scope.kind === "code" && repositoryOf(topic) !== null ? <span className="topic-repo od-truncate">{repositoryOf(topic)}</span> : null}
      </a>
    );
  };

  return (
    <div className={stream === null ? "stream" : "stream stream--combined"} ref={scroller} onScroll={(event) => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < nearBottom;
    }}>
      <div className="stream-inner" role="log" aria-label={text("conversation.stream")}>
        {stream?.before != null ? (
          <button className="btn btn-sm stream-older" type="button" disabled={stream.loading || !online} onClick={() => {
            const element = scroller.current;
            if (element !== null) {
              following.current = false;
              older.current = { height: element.scrollHeight, top: element.scrollTop };
            }
            loadOlder();
          }}>{text("conversation.older")}</button>
        ) : null}
        {items.map((item) => {
          const id = item.kind === "ended" && stream !== null ? item.turn.conversation : "topic" in item ? item.topic : undefined;
          const entry = item.kind === "entry" ? item.entry : undefined;
          const match = entry?.kind === "owner" ? entry.possibleMatch : undefined;
          const source = entry?.kind === "owner" && entry.quotedMessage !== undefined ? previews.get(entry.quotedMessage) : undefined;
          return <StreamEntry key={item.key} item={item} thisYear={thisYear} topic={id === undefined ? undefined : topicLabel(id)}
            quote={entry === undefined ? undefined : () => selectQuote(entry)}
            quoted={entry?.kind === "owner" && entry.quotedMessage !== undefined ? (
              <div className="sent-quote od-truncate">{source === undefined ? text("conversation.quote") : previewOf(source)}</div>
            ) : undefined}
            match={match === undefined ? undefined : (
              <a className="possible-match od-truncate" href={hrefOf(match)} onClick={(event) => followLink(event, () => open(match))}>
                {text("conversation.possibleMatch", { topic: titleOf(topics.get(match)) })}
              </a>
            )} />;
        })}
      </div>
    </div>
  );
}
