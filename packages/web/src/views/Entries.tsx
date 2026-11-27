import { QuestionCard } from "./QuestionCard.js";
import { UiScreenshots } from "./UiScreenshots.js";
import { FileViewer } from "../parts/FileViewer.js";
import { text } from "@super-agent2/catalog";
import { type ConversationEntry, type DeliveryEntry, type NoticeEntry, type OwnerEntry, type TextEntry, type Turn } from "@super-agent2/protocol";
import { cardAddress, pagePath, ticketAddress } from "../parts/app-path.js";
import { memo, useCallback, useState, type ReactNode } from "react";
import { ticketFilePath } from "../hub/api.js";
import { sizeOf } from "../live/size.js";
import type { Day, StreamItem } from "../live/stream.js";
import { toolName, toolSummary } from "../live/tool.js";
import { Icon } from "../parts/icons.js";
import { Markdown } from "../parts/Markdown.js";
import { SentAttachments } from "../parts/Attachments.js";

const pad = (value: number) => String(value).padStart(2, "0");

export function clockOf(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dayLabel(day: Day, thisYear: number): string {
  if (day.relative === "today") {
    return text("day.today");
  }
  if (day.relative === "yesterday") {
    return text("day.yesterday");
  }
  return day.year === thisYear ? text("day.date", { month: day.month, day: day.day }) : text("day.dateWithYear", day);
}

const OwnerMessage = memo(function OwnerMessage({ entry, topic, action, match, quoted, split }: {
  readonly entry: OwnerEntry; readonly topic?: ReactNode; readonly action?: ReactNode; readonly match?: ReactNode; readonly quoted?: ReactNode;
  readonly split?: (() => Promise<boolean>) | undefined;
}) {
  const [splitting, setSplitting] = useState(false);
  return (
    <div className="msg msg--me chat-message">
      <div className="chat-meta">
        {topic}
        <span className="topic-split-slot">
          {split === undefined ? null : <button className="topic-split" type="button" disabled={splitting} onClick={async () => {
            setSplitting(true);
            if (!await split()) setSplitting(false);
          }}>{text("conversation.newTopic")}</button>}
        </span>
        {entry.taken ? null : (
          <span className="dot dot--mute" role="img" aria-label={text("message.waiting")} title={text("message.waiting")} />
        )}
        {entry.voiceTranscript === undefined ? null : <span className="voice-origin"><Icon name="phone" size={14} />{text("voice.call")}</span>}
        {action}
      </div>
      {quoted}
      {entry.text === "" ? null : <div className="msg-text msg-plain">{entry.text}</div>}
      {entry.voiceTranscript === undefined ? null : <details className="voice-entry-transcript">
        <summary>{text("voice.transcript")}</summary>
        <div className="msg-plain">{entry.voiceTranscript}</div>
      </details>}
      <SentAttachments attachments={entry.attachments} />
      {match}
    </div>
  );
});

export function TextBody({ text: body, live }: { readonly text: string; readonly live: boolean }) {
  return (
    <div className={live ? "msg-text cursor" : "msg-text"}>
      <Markdown text={body} />
    </div>
  );
}

const BrainText = memo(function BrainText({
  entry,
  lead,
  live,
  topic,
  action,
}: {
  readonly entry: TextEntry;
  readonly lead: boolean;
  readonly live: boolean;
  readonly topic?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className={lead ? "msg msg--brain chat-message" : "msg msg--brain chat-message msg--more"}>
      {topic}
      <div className="chat-actions">{action}</div>
      <TextBody text={entry.text} live={live} />
    </div>
  );
});

export function LiveStatus({ tool, idle, topic }: { readonly tool: { readonly name: string; readonly input: string } | null; readonly idle: string; readonly topic?: ReactNode }) {
  const summary = tool === null ? "" : toolSummary(tool.input);
  const status = tool === null
    ? idle
    : summary === ""
      ? text("brain.calling", { tool: toolName(tool.name) })
      : text("brain.callingWithSummary", { tool: toolName(tool.name), summary });
  return <div className="brain-status" aria-live="polite">{topic}<span className="od-truncate">{status}</span></div>;
}

export interface DeliveryBodyProps {
  readonly ticket: number;
  readonly light?: true | undefined;
  readonly title: string;
  readonly at: number;
  readonly text: string | null;
  readonly report?: string | null;
  readonly files: readonly { readonly name: string; readonly size: number }[];
  readonly topic?: ReactNode;
  readonly action?: ReactNode;
}

export const DeliveryBody = memo(function DeliveryBody({ ticket, light, title, at, text: body, report = null, files, topic, action }: DeliveryBodyProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const close = useCallback(() => setSelected(null), []);
  const viewFiles = files.map(file => ({ ...file, mime: "", url: ticketFilePath(ticket, file.name) }));
  return (
    <div className={light === true ? "msg msg--brain" : "msg delivery"}>
      <div className="msg-who">
        {light === true ? null : <Icon name="doc" />}
        <strong>{title}</strong>
        <span className="num">{clockOf(at)}</span>
        {topic}
        {light === true ? <a className="icon-btn message-quote" href={ticketAddress(ticket)} aria-label={text("notice.lightTaskLog")} title={text("notice.lightTaskLog")}><Icon name="doc" size={16} /></a> : null}
        {action}
      </div>
      {body === null ? report === null ? null : <div className="msg-text msg-plain">{report}</div> : <div className="msg-text msg-plain delivery-text">{body}</div>}
      {files.length === 0 ? null : (
        <div className="msg-files">
          {files.map((file, index) => (
            <a onClick={event => { event.preventDefault(); history.pushState({ ...history.state, fileViewer: true }, ""); setSelected(index); }} key={file.name} className="chip" href={ticketFilePath(ticket, file.name)} download={file.name}>
              <Icon name="clip" />
              {file.name}
              <span className="num">{sizeOf(file.size)}</span>
            </a>
          ))}
        </div>
      )}
      {selected === null ? null : <FileViewer files={viewFiles} index={selected} close={close} />}
    </div>
  );
});

function Delivery({ entry, topic, action }: { readonly entry: DeliveryEntry; readonly topic?: ReactNode; readonly action?: ReactNode }) {
  return <DeliveryBody ticket={entry.ticket} light={entry.light} title={entry.title.zh} at={entry.at} text={entry.text} report={entry.report?.zh ?? null} files={entry.files} topic={topic} action={action} />;
}

function Notice({ entry, topic, action }: { readonly entry: NoticeEntry; readonly topic?: ReactNode; readonly action?: ReactNode }) {
  if (entry.source !== undefined) {
    return <div className="source-message">
      <div className="source-line">{text("message.fromSource")} <Icon name="inbox" size={14} /> {entry.source} {clockOf(entry.at)} <Icon name="down" size={14} /></div>
      <div className="msg msg--brain chat-message">{topic}<div className="chat-actions">{action}</div><div className="msg-text msg-plain">{entry.text}</div></div>
    </div>;
  }
  if (entry.worker === true) {
    return <div className="msg msg--brain">
      <div className="msg-who"><span className="num">{clockOf(entry.at)}</span>{topic}{action}</div>
      <div className="msg-text msg-plain">{entry.text}</div>
    </div>;
  }
  return (<>
    <div className={`sysline sysline--note${entry.ticket !== undefined && entry.start !== true ? " sysline--progress" : ""}`}>
      <Icon name="swap" />
      {entry.destination === undefined ? <span>{entry.text}</span> : <a href={pagePath({ view: "conversations", conversation: entry.destination, scope: { kind: "daily" } })}>{entry.text}</a>}
      {entry.ticket === undefined || entry.start !== true ? null : <a href={ticketAddress(entry.ticket)}>{text("notice.taskOpen")}</a>}
      {entry.ticket === undefined || entry.start !== true ? null : <a href={cardAddress(`start:${entry.ticket}`)}>{text("notice.taskStart")}</a>}
      {entry.text.startsWith(text("notice.newModelsPrefix")) ? <a href={pagePath({ view: "settings", section: "models" })}>{text("notice.newModelsLink")}</a> : null}
      {topic}
      {action}
    </div>
    {entry.screenshots === undefined ? null : <UiScreenshots reports={entry.screenshots} />}
  </>);
}

function Ended({ turn, topic }: { readonly turn: Turn; readonly topic?: ReactNode }) {
  return (
    <div className={turn.state === "failed" ? "sysline sysline--bad" : "sysline sysline--warn"}>
      <Icon name="alert" />
      <span>{text(`turn.state.${turn.state}`)}</span>
      {turn.reason === null ? null : <span className="sysline-reason">{turn.reason}</span>}
      {topic}
    </div>
  );
}

export function StreamEntry({ item, thisYear, topic, quote, match, quoted, move, split, onQuestionSubmitted }: {
  readonly item: StreamItem;
  readonly thisYear: number;
  readonly topic?: ReactNode;
  readonly quote?: (() => void) | undefined;
  readonly move?: (() => void) | undefined;
  readonly split?: (() => Promise<boolean>) | undefined;
  readonly match?: ReactNode;
  readonly quoted?: ReactNode;
  readonly onQuestionSubmitted?: (id: string) => void;
}) {
  switch (item.kind) {
    case "day":
      return <div className="day">{dayLabel(item.day, thisYear)} {clockOf(item.at)}</div>;
    case "status":
      return <LiveStatus tool={item.tool} idle={text("brain.thinking")} topic={topic} />;
    case "ended":
      return <Ended turn={item.turn} topic={topic} />;
    case "entry": {
      const { entry } = item;
      const action = quote === undefined ? undefined : (
        <button className="icon-btn message-quote" type="button" aria-label={text("conversation.quote")} title={text("conversation.quote")} onClick={quote}>
          <Icon name="reply" size={16} />
        </button>
      );
      switch (entry.kind) {
        case "question":
          return <QuestionCard entry={entry} topic={topic} onSubmitted={onQuestionSubmitted} />;
        case "owner":
          return <OwnerMessage entry={entry} topic={topic} action={<>
            {action}
            {move === undefined ? null : <button className="icon-btn message-quote" type="button" aria-haspopup="dialog"
              aria-label={text("conversation.move")} title={text("conversation.move")} onClick={move}><Icon name="swap" size={16} /></button>}
          </>} match={match} quoted={quoted} split={split} />;
        case "text":
          return <BrainText entry={entry} lead={item.lead} live={item.live} topic={topic} action={action} />;
        case "notice":
          return <Notice entry={entry} topic={topic} action={action} />;
        case "delivery":
          return <Delivery entry={entry} topic={topic} action={action} />;
      }
    }
  }
}
