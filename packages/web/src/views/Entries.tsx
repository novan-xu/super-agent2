import { text } from "@super-agent2/catalog";
import type { ConversationEntry, DeliveryEntry, NoticeEntry, OwnerEntry, TextEntry, ToolEntry, Turn } from "@super-agent2/protocol";
import { memo } from "react";
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

const OwnerMessage = memo(function OwnerMessage({ entry }: { readonly entry: OwnerEntry }) {
  return (
    <div className="msg msg--me">
      <div className="msg-who">
        {entry.taken ? null : (
          <span className="dot dot--mute" role="img" aria-label={text("message.waiting")} title={text("message.waiting")} />
        )}
        <span className="num">{clockOf(entry.at)}</span>
      </div>
      {entry.text === "" ? null : <div className="msg-text msg-plain">{entry.text}</div>}
      <SentAttachments attachments={entry.attachments} />
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
}: {
  readonly entry: TextEntry;
  readonly lead: boolean;
  readonly live: boolean;
}) {
  return (
    <div className={lead ? "msg msg--brain" : "msg msg--brain msg--more"}>
      {lead ? (
        <div className="msg-who">
          <Logo size={16} />
          <strong>{text("brain.name")}</strong>
          <span className="num">{clockOf(entry.at)}</span>
        </div>
      ) : null}
      <TextBody text={entry.text} live={live} />
    </div>
  );
});

const toolDots = { running: "dot dot--ok dot--live", done: "dot dot--ok", failed: "dot dot--bad" } as const;

export interface ToolFoldProps {
  readonly name: string;
  readonly input: string;
  readonly output: string;
  readonly state: ToolEntry["state"];
  readonly stopped: boolean;
}

export const ToolFold = memo(function ToolFold({ name, input, output, state, stopped }: ToolFoldProps) {
  return (
    <details className="tool">
      <summary className="tool-head">
        <span
          className={stopped ? "dot dot--mute" : toolDots[state]}
          role="img"
          aria-label={stopped ? text("turn.state.interrupted") : text(`tool.state.${state}`)}
        />
        <span className="tool-name">{toolName(name)}</span>
        <code className="tool-sum od-truncate">{toolSummary(input)}</code>
        <Icon name="chev" />
      </summary>
      <div className="tool-body">
        <pre className="tool-in">{input}</pre>
        {output === "" ? null : <pre className="tool-out">{output}</pre>}
      </div>
    </details>
  );
});

const ToolCall = memo(function ToolCall({ entry, lead, live }: { readonly entry: ToolEntry; readonly lead: boolean; readonly live: boolean }) {
  const stopped = entry.state === "running" && !live;
  return (
    <div className={lead ? "msg msg--brain" : "msg msg--brain msg--more"}>
      {lead ? (
        <div className="msg-who">
          <Logo size={16} />
          <strong>{text("brain.name")}</strong>
          <span className="num">{clockOf(entry.at)}</span>
        </div>
      ) : null}
      <ToolFold name={entry.name} input={entry.input} output={entry.output} state={entry.state} stopped={stopped} />
    </div>
  );
});

export interface DeliveryBodyProps {
  readonly ticket: number;
  readonly title: string;
  readonly at: number;
  readonly text: string | null;
  readonly report?: string | null;
  readonly files: readonly { readonly name: string; readonly size: number }[];
}

export const DeliveryBody = memo(function DeliveryBody({ ticket, title, at, text: body, report = null, files }: DeliveryBodyProps) {
  return (
    <div className="msg delivery">
      <div className="msg-who">
        <Icon name="doc" />
        <strong>{title}</strong>
        <span className="num">{clockOf(at)}</span>
      </div>
      {body === null ? report === null ? null : <div className="msg-text msg-plain">{report}</div> : <div className="msg-text msg-plain delivery-text">{body}</div>}
      {files.length === 0 ? null : (
        <div className="msg-files">
          {files.map((file) => (
            <a key={file.name} className="chip" href={ticketFilePath(ticket, file.name)} download={file.name}>
              <Icon name="clip" />
              {file.name}
              <span className="num">{sizeOf(file.size)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
});

function Delivery({ entry }: { readonly entry: DeliveryEntry }) {
  return <DeliveryBody ticket={entry.ticket} title={entry.title.zh} at={entry.at} text={entry.text} report={entry.report?.zh ?? null} files={entry.files} />;
}

function Notice({ entry }: { readonly entry: NoticeEntry }) {
  return (
    <div className="sysline sysline--note">
      <Icon name="swap" />
      <span>{entry.text}</span>
    </div>
  );
}

function Ended({ turn }: { readonly turn: Turn }) {
  return (
    <div className={turn.state === "failed" ? "sysline sysline--bad" : "sysline sysline--warn"}>
      <Icon name="alert" />
      <span>{text(`turn.state.${turn.state}`)}</span>
      {turn.reason === null ? null : <span className="sysline-reason">{turn.reason}</span>}
    </div>
  );
}

export function StreamEntry({ item, thisYear }: { readonly item: StreamItem; readonly thisYear: number }) {
  switch (item.kind) {
    case "day":
      return <div className="day">{dayLabel(item.day, thisYear)}</div>;
    case "typing":
      return (
        <span className="typing" role="img" aria-label={text("brain.thinking")}>
          <i />
          <i />
          <i />
        </span>
      );
    case "ended":
      return <Ended turn={item.turn} />;
    case "entry": {
      const { entry } = item;
      switch (entry.kind) {
        case "owner":
          return <OwnerMessage entry={entry} />;
        case "text":
          return <BrainText entry={entry} lead={item.lead} live={item.live} />;
        case "tool":
          return <ToolCall entry={entry} lead={item.lead} live={item.live} />;
        case "notice":
          return <Notice entry={entry} />;
        case "delivery":
          return <Delivery entry={entry} />;
      }
    }
  }
}
