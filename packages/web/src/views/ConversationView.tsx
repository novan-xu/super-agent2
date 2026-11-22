import { VoiceCall } from "./VoiceCall.js";
import { text } from "@super-agent2/catalog";
import { type Conversation, type ConversationEntry, type ReviewedStreamDestination, type StreamEntry as StreamRecord, type StreamPreview, type StreamPreviewRequest, type TopicScope, topicInScope } from "@super-agent2/protocol";
import { type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SocketStatus } from "../hub/socket.js";
import { type ConversationState, isWorking } from "../live/conversation.js";
import { combinedStreamItems, streamItems } from "../live/stream.js";
import { topicScopeKey } from "../live/topic-scope.js";
import { type DraftDestination, loadComposerDraft, saveComposerDraft, sendAttempt } from "../live/drafts.js";
import type { TopicStreamState } from "../live/topic-stream.js";
import { AttachButton, PendingList, useAttachments } from "../parts/Attachments.js";
import { Icon } from "../parts/icons.js";
import { sendsOnEnter } from "../parts/keys.js";
import { followLink } from "../parts/Shell.js";
import { clockOf, dayLabel, StreamEntry } from "./Entries.js";

import { newTopicOption, TopicActionButton, TopicActionDialog, type TopicActions, type TopicEdit, titleOf } from "./TopicActions.js";

const nearBottom = 48;
const previewDelay = 250;

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
  readonly edit: (topic: TopicEdit) => void;
}

type TopicHeading = StreamRecord["topic"];

function repositoryOf(topic: TopicHeading | undefined): string | null {
  return topic?.system === true ? null : topic?.repository ?? (topic?.needsRepository === true ? text("conversation.repository.pending") : null);
}

export function TopicList({ list, current, hrefOf, open, now, showRepository, edit }: ListProps) {
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
              {conversation.topicState === "archived" ? <span>{text("conversation.archived")}</span> : null}
              <span className="num">{whenOf(conversation.updatedAt, now)}</span>
            </span>
          </a>
          <TopicActionButton topic={conversation} edit={edit} />
        </li>
      ))}
    </ul>
  );
}

interface ComposerProps {
  readonly working: boolean;
  readonly canStop: boolean;
  readonly voiceScope?: TopicScope | undefined;
  readonly send: ComposerSend;
  readonly stop: () => void;
  readonly draftKey: string;
  readonly quote: QuotePreview | undefined;
  readonly clearQuote: (id: string) => void;
  readonly routing?: {
    readonly scope: TopicScope;
    readonly topics: readonly Conversation[];
    readonly status: SocketStatus;
    readonly preview: PreviewStream;
  } | undefined;
}

type ComposerSend = (message: string, attachments: readonly string[], quotedMessage?: string, destination?: ReviewedStreamDestination, id?: string) => Promise<boolean | "stale">;
type PreviewStream = (request: StreamPreviewRequest, signal?: AbortSignal) => Promise<StreamPreview | undefined>;

interface QuotePreview {
  readonly id: string;
  readonly text: string;
}

export function TopicComposer({ working, canStop, voiceScope, send, stop, draftKey, quote, clearQuote, routing }: ComposerProps) {
  const [saved] = useState(() => loadComposerDraft(draftKey));
  const [draft, setDraft] = useState(saved.text);
  const [choice, setChoice] = useState(saved.destination);
  const [attempt, setAttempt] = useState(saved.attempt);
  const [preview, setPreview] = useState<StreamPreview>();
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const attaching = useAttachments(draftKey);
  const message = draft.trim();
  const empty = message === "" && attaching.items.length === 0;
  const routeDraft = routing !== undefined && quote === undefined;
  const destination: DraftDestination | undefined = !routeDraft ? undefined : choice ??
    (preview === undefined ? undefined : { ...preview, topic: preview.proposal.decided.topic });
  const targets = routing?.topics.filter((topic) => topic.topicState === "active" && !topic.system && !topic.mergePending) ?? [];
  const getPreview = routing?.preview;
  const scope = routing?.scope;
  const status = routing?.status;
  const attachmentNames = JSON.stringify(attaching.items.map(({ name }) => name));

  useEffect(() => {
    if (!routeDraft || scope === undefined || getPreview === undefined || choice != null || sending) return;
    const leaving = new AbortController();
    const request = () => {
      void getPreview({ scope, text: message, attachmentNames: JSON.parse(attachmentNames) as string[] }, leaving.signal).then((result) => {
        if (!leaving.signal.aborted && result !== undefined) {
          setPreview(result);
          if (choice === null) setChoice(undefined);
        }
      });
    };
    const timer = setTimeout(request, empty || choice === null ? 0 : previewDelay);
    return () => {
      leaving.abort();
      clearTimeout(timer);
    };
  }, [attachmentNames, choice, empty, getPreview, message, routeDraft, scope, sending, status]);

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

  useEffect(() => {
    saveComposerDraft(draftKey, { text: draft, destination: choice, attempt, ...(quote === undefined ? {} : { quote }) });
  }, [attempt, choice, draft, draftKey, quote]);

  const submit = useCallback(async () => {
    if (empty || sending) {
      return;
    }
    const selected = destination === undefined ? undefined : {
      ...(destination.topic === null ? { newTopic: true as const } : { topic: destination.topic }), proposal: destination.proposal,
    };
    setSending(true);
    const attachments = await attaching.settle();
    let sent: boolean | "stale" = false;
    if (attachments !== undefined) {
      const current = sendAttempt(attempt, JSON.stringify([message, attachments, quote?.id ?? null, choice == null ? null : choice.topic ?? newTopicOption]));
      setAttempt(current);
      saveComposerDraft(draftKey, { text: draft, destination: choice, attempt: current, ...(quote === undefined ? {} : { quote }) });
      sent = await send(message, attachments, quote?.id, selected, current.id);
    }
    setSending(false);
    if (sent === "stale") {
      setPreview(undefined);
      setChoice(null);
    } else if (sent) {
      setDraft("");
      setChoice(undefined);
      setPreview(undefined);
      setAttempt(undefined);
      attaching.clear();
      if (quote !== undefined) {
        clearQuote(quote.id);
      }
    }
    field.current?.focus();
  }, [attaching, attempt, choice, clearQuote, destination, draft, draftKey, empty, message, quote, send, sending]);

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
            setDraft(value);
            saveComposerDraft(draftKey, { text: value, destination: choice, attempt, ...(quote === undefined ? {} : { quote }) });
          }}
          onKeyDown={keyDown}
          onPaste={attaching.paste}
        />
        <div className="composer-foot">
          <AttachButton add={attaching.add} />
          {voiceScope === undefined ? null : <VoiceCall scope={voiceScope} />}
          {routeDraft ? (
            <select className="field composer-destination" aria-label={text("conversation.destination")}
              value={destination === undefined ? "" : destination.topic ?? newTopicOption}
              disabled={destination === undefined || sending} hidden={destination === undefined}
              onChange={(event) => {
                if (destination === undefined) return;
                const value = event.target.value;
                const target = targets.find(({ id }) => id === value);
                if (value === newTopicOption) setChoice({ topic: null, title: null, proposal: destination.proposal });
                else if (target !== undefined) setChoice({ topic: target.id, title: target.title, proposal: destination.proposal });
              }}>
              {destination === undefined ? <option value="" /> : null}
              <option value={newTopicOption}>{text("conversation.newTopic")}</option>
              {targets.map((topic) => <option key={topic.id} value={topic.id}>{titleOf(topic)}</option>)}
              {destination?.topic != null && !targets.some(({ id }) => id === destination.topic) ? (
                <option value={destination.topic} disabled>{titleOf(destination.title === null ? undefined : { title: destination.title })}</option>
              ) : null}
            </select>
          ) : null}
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
  readonly focusEntry?: string | undefined;
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
  readonly topicActions: TopicActions;
  readonly compact?: boolean;
  readonly send: ComposerSend;
  readonly previewStream?: PreviewStream;
  readonly stop: () => void;
  readonly loadOlder: () => void;
  readonly now: number;
}

export function ConversationView(props: ConversationViewProps) {
  const { state, stream, now, conversation, scope, list, hrefOf, open } = props;
  const following = useRef(true);
  const picker = useRef<HTMLDialogElement>(null);
  const [edit, setEdit] = useState<TopicEdit | null>(null);
  const draftKey = conversation === null ? `scope:${topicScopeKey(scope)}` : `topic:${conversation}`;
  const openEdit = (selection: TopicEdit) => {
    picker.current?.close();
    setEdit(selection);
  };
  const [quotes, setQuotes] = useState<Readonly<Record<string, QuotePreview | undefined>>>(() => ({
    [draftKey]: loadComposerDraft(draftKey).quote,
  }));
  useEffect(() => {
    setQuotes((all) => ({ ...all, [draftKey]: loadComposerDraft(draftKey).quote }));
  }, [draftKey]);
  const working = state !== null && isWorking(state);
  const showRepository = scope.kind === "code";
  const filtered = useMemo(() => list.filter((topic) => topic.mergedInto === undefined && topicInScope(topic, scope)).sort((a, b) =>
    Number(a.topicState === "archived") - Number(b.topicState === "archived")), [list, scope]);
  const clearQuote = useCallback((id: string) => {
    setQuotes((all) => {
      if (all[draftKey]?.id !== id) return all;
      saveComposerDraft(draftKey, { ...loadComposerDraft(draftKey), quote: undefined });
      return { ...all, [draftKey]: undefined };
    });
  }, [draftKey]);
  const selectQuote = useCallback((entry: VisibleEntry) => {
    const quote = { id: entry.id, text: previewOf(entry) };
    setQuotes((all) => ({ ...all, [draftKey]: quote }));
    saveComposerDraft(draftKey, { ...loadComposerDraft(draftKey), quote });
  }, [draftKey]);

  const send = useCallback(
    async (message: string, attachments: readonly string[], quotedMessage?: string, destination?: ReviewedStreamDestination, id?: string) => {
      following.current = true;
      return props.send(message, attachments, quotedMessage, destination, id);
    },
    [props.send],
  );

  const pick = (conversation: string) => {
    picker.current?.close();
    open(conversation);
  };

  const selected = state?.conversation ?? list.find((topic) => topic.id === conversation && topic.mergedInto === undefined);
  const title = titleOf(selected);
  const online = props.status === "open";

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
                {selected === undefined ? null : <TopicActionButton topic={selected} edit={openEdit} />}
                {selected?.mergePending ? <span className="topic-merging" role="status" title={text("conversation.merging")}>
                  <span className="dot dot--warn" aria-label={text("conversation.merging")} />
                </span> : null}
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
              props.model === null ? null : <span className="mono od-truncate">{props.model}</span>
            ) : (
              <span>{text("brain.offline")}</span>
            )}
            </span>
          </div>
        </div>
        <TopicStream streamKey={draftKey} state={state} stream={stream} scope={scope} list={list} online={online} now={now} focusEntry={props.focusEntry}
          following={following} hrefOf={hrefOf} open={open} loadOlder={props.loadOlder} selectQuote={selectQuote}
          move={props.topicActions.move} openEdit={openEdit} />
        <TopicComposer key={draftKey} working={working} canStop={conversation !== null} send={send} stop={props.stop} draftKey={draftKey}
          quote={quotes[draftKey]} clearQuote={clearQuote} voiceScope={scope}
          routing={conversation === null && props.previewStream !== undefined ? {
            scope, topics: filtered, status: props.status, preview: props.previewStream,
          } : undefined} />
      </div>
      {props.compact === true ? null : (
        <aside className="rail" aria-label={text("conversation.list")}>
          <TopicList list={filtered} current={conversation} hrefOf={hrefOf} open={open} now={now} showRepository={showRepository} edit={openEdit} />
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
          <TopicList list={filtered} current={conversation} hrefOf={hrefOf} open={pick} now={now} showRepository={showRepository} edit={openEdit} />
        </div>
      </dialog>
      {edit === null ? null : <TopicActionDialog edit={edit} list={list} actions={props.topicActions} done={() => setEdit(null)} />}
    </div>
  );
}

type VisibleEntry = Exclude<ConversationEntry, { kind: "tool" }>;

function previewOf(entry: VisibleEntry): string {
  const fallback = entry.kind === "owner" ? entry.attachments[0]?.name : entry.kind === "delivery" ? entry.title.zh : undefined;
  return ((entry.kind === "question" ? entry.questions.map((question) => question.prompt).join("；") : entry.text?.trim()) || fallback || text("conversation.quote")).slice(0, 240);
}

function toneOf(id: string): number {
  let hash = 0;
  for (const character of id) {
    hash = Math.imul(31, hash) + character.charCodeAt(0);
  }
  return (hash >>> 0) % 4;
}

interface TopicStreamProps {
  readonly streamKey: string;
  readonly focusEntry?: string | undefined;
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
  readonly move: TopicActions["move"];
  readonly openEdit: (topic: TopicEdit) => void;
}

export function TopicStream({ streamKey, focusEntry, state, stream, scope, list, online, now, following, hrefOf, open, loadOlder, selectQuote, move, openEdit }: TopicStreamProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const older = useRef<{ readonly height: number; readonly top: number } | null>(null);
  const focused = useRef<string | undefined>(undefined);
  const [submittedQuestions, setSubmittedQuestions] = useState<ReadonlySet<string>>(() => new Set());
  const current = state?.conversation;
  const topics = useMemo(() => {
    const found = new Map(stream?.entries.map(({ topic }) => [topic.id, topic]));
    for (const topic of list) {
      found.set(topic.id, topic);
    }
    if (current !== undefined) found.set(current.id, current);
    return found;
  }, [stream, list, current]);
  const entries = useMemo(() => stream === null ? state?.entries ?? [] : stream.entries.flatMap(({ entry, topic }) =>
    topicInScope(topics.get(topic.id) ?? topic, scope) ? [entry] : []), [state, stream, topics, scope]);
  const previews = useMemo(() => new Map(entries.flatMap((entry) => entry.kind === "tool" ? [] : [[entry.id, entry] as const])), [entries]);
  const latestOwner = useMemo(() => {
    const latest = new Map<string, number>();
    for (const entry of entries) {
      if (entry.kind === "owner" && entry.seq > (latest.get(entry.conversation) ?? 0)) latest.set(entry.conversation, entry.seq);
    }
    return latest;
  }, [entries]);
  const olderOwners = useMemo(() => new Set(stream?.entries.flatMap(({ entry, latestOwner }) => latestOwner === false ? [entry.id] : [])), [stream]);
  const items = useMemo(() => {
    if (stream === null) {
      return state === null ? [] : streamItems(state, now, submittedQuestions);
    }
    const turns = stream.turns.filter((turn) => {
      const topic = topics.get(turn.conversation);
      return topic !== undefined && topicInScope(topic, scope);
    });
    return combinedStreamItems(entries, turns, now, submittedQuestions);
  }, [state, stream, entries, topics, scope, now, submittedQuestions]);
  const thisYear = new Date(now).getFullYear();

  useLayoutEffect(() => {
    following.current = true;
    older.current = null;
    focused.current = undefined;
  }, [following, streamKey]);
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
  }, [items, stream?.loading, following, streamKey]);

  useLayoutEffect(() => {
    if (focusEntry === undefined || focused.current === focusEntry) return;
    const entry = document.getElementById(`entry-${focusEntry}`);
    if (entry === null || !scroller.current?.contains(entry)) return;
    following.current = false;
    focused.current = focusEntry;
    entry.scrollIntoView?.({ block: "center" });
  }, [focusEntry, items, following, streamKey]);

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
          const entry = item.kind === "entry" ? item.entry : undefined;
          const joined = entry?.kind === "owner" && entry.placement === "router-joined";
          const id = item.kind === "ended" && stream !== null ? item.turn.conversation
            : "topic" in item ? item.topic : joined ? entry.conversation : undefined;
          const canSplit = joined && entry.seq === latestOwner.get(entry.conversation) && !olderOwners.has(entry.id);
          const match = entry?.kind === "owner" ? entry.possibleMatch : undefined;
          const source = entry?.kind === "owner" && entry.quotedMessage !== undefined ? previews.get(entry.quotedMessage) : undefined;
          return <div key={item.key} id={entry === undefined ? undefined : `entry-${entry.id}`} className="stream-item"><StreamEntry item={item} thisYear={thisYear} topic={id === undefined ? undefined : topicLabel(id)}
            onQuestionSubmitted={(id) => setSubmittedQuestions((current) => new Set(current).add(id))}
            quote={entry === undefined || entry.kind === "question" ? undefined : () => selectQuote(entry)}
            move={entry?.kind !== "owner" ? undefined : () => openEdit({ source: entry.conversation, message: entry.id })}
            split={canSplit ? () => move(entry.conversation, entry.id, null) : undefined}
            quoted={entry?.kind === "owner" && entry.quotedMessage !== undefined ? (
              <div className="sent-quote od-truncate">{source === undefined ? text("conversation.quote") : previewOf(source)}</div>
            ) : undefined}
            match={match === undefined || entry === undefined ? undefined : (
              <button className="possible-match od-truncate" type="button" onClick={() => void move(entry.conversation, entry.id, match)}>
                {text("conversation.possibleMatch", { topic: titleOf(topics.get(match)) })}
              </button>
            )} /></div>;
        })}
      </div>
    </div>
  );
}
