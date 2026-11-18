import { FileViewer } from "../parts/FileViewer.js";
import { text } from "@super-agent2/catalog";
import type { ConversationEntry, DeliveryEntry, NoticeEntry, OwnerEntry, TextEntry, Turn } from "@super-agent2/protocol";
import { memo, useCallback, useState, type ReactNode } from "react";
import { ticketFilePath } from "../hub/api.js";
import { sizeOf } from "../live/size.js";
import type { Day, StreamItem } from "../live/stream.js";
import { toolName, toolSummary } from "../live/tool.js";
import { Icon, Logo } from "../parts/icons.js";
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

const OwnerMessage = memo(function OwnerMessage({ entry, topic, action, match, quoted }: {
  readonly entry: OwnerEntry; readonly topic?: ReactNode; readonly action?: ReactNode; readonly match?: ReactNode; readonly quoted?: ReactNode;
}) {
  return (
    <div className="msg msg--me">
      <div className="msg-who">
        {topic}
        {entry.taken ? null : (
          <span className="dot dot--mute" role="img" aria-label={text("message.waiting")} title={text("message.waiting")} />
        )}
        <span className="num">{clockOf(entry.at)}</span>
        {action}
      </div>
      {quoted}
      {entry.text === "" ? null : <div className="msg-text msg-plain">{entry.text}</div>}
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
    <div className={lead ? "msg msg--brain" : "msg msg--brain msg--more"}>
      {lead || topic !== undefined || action !== undefined ? (
        <div className="msg-who">
          {lead ? <><Logo size={16} /><strong>{text("brain.name")}</strong><span className="num">{clockOf(entry.at)}</span></> : null}
          {topic}
          {action}
        </div>
      ) : null}
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
  readonly title: string;
  readonly at: number;
  readonly text: string | null;
  readonly report?: string | null;
  readonly files: readonly { readonly name: string; readonly size: number }[];
  readonly topic?: ReactNode;
  readonly action?: ReactNode;
}

export const DeliveryBody = memo(function DeliveryBody({ ticket, title, at, text: body, report = null, files, topic, action }: DeliveryBodyProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const close = useCallback(() => setSelected(null), []);
  const viewFiles = files.map(file => ({ ...file, mime: "", url: ticketFilePath(ticket, file.name) }));
  return (
    <div className="msg delivery">
      <div className="msg-who">
        <Icon name="doc" />
        <strong>{title}</strong>
        <span className="num">{clockOf(at)}</span>
        {topic}
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
  return <DeliveryBody ticket={entry.ticket} title={entry.title.zh} at={entry.at} text={entry.text} report={entry.report?.zh ?? null} files={entry.files} topic={topic} action={action} />;
}

function Notice({ entry, topic, action }: { readonly entry: NoticeEntry; readonly topic?: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="sysline sysline--note">
      <Icon name="swap" />
      <span>{entry.text}</span>
      {entry.text.startsWith(text("notice.newModelsPrefix")) ? <a href="/settings/models">{text("notice.newModelsLink")}</a> : null}
      {topic}
      {action}
    </div>
  );
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

export function StreamEntry({ item, thisYear, topic, quote, match, quoted, move }: {
  readonly item: StreamItem;
  readonly thisYear: number;
  readonly topic?: ReactNode;
  readonly quote?: (() => void) | undefined;
  readonly move?: (() => void) | undefined;
  readonly match?: ReactNode;
  readonly quoted?: ReactNode;
}) {
  switch (item.kind) {
    case "day":
      return <div className="day">{dayLabel(item.day, thisYear)}</div>;
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
        case "owner":
          return <OwnerMessage entry={entry} topic={topic} action={<>
            {action}
            {move === undefined ? null : <button className="icon-btn message-quote" type="button" aria-haspopup="dialog"
              aria-label={text("conversation.move")} title={text("conversation.move")} onClick={move}><Icon name="swap" size={16} /></button>}
          </>} match={match} quoted={quoted} />;
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
