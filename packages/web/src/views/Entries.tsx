import { text } from "@super-agent2/catalog";
import type { ConversationEntry, NoticeEntry, OwnerEntry, TextEntry, ToolEntry, Turn } from "@super-agent2/protocol";
import { memo } from "react";
import type { Day, StreamItem } from "../live/stream.js";
import { toolName, toolSummary } from "../live/tool.js";
import { Icon, Logo } from "../parts/icons.js";
import { Markdown } from "../parts/Markdown.js";

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
      <div className="msg-text msg-plain">{entry.text}</div>
    </div>
  );
});

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
      <div className={live ? "msg-text cursor" : "msg-text"}>
        <Markdown text={entry.text} />
      </div>
    </div>
  );
});

const toolDots = { running: "dot dot--ok dot--live", done: "dot dot--ok", failed: "dot dot--bad" } as const;

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
      <details className="tool">
        <summary className="tool-head">
          <span
            className={stopped ? "dot dot--mute" : toolDots[entry.state]}
            role="img"
            aria-label={stopped ? text("turn.state.interrupted") : text(`tool.state.${entry.state}`)}
          />
          <span className="tool-name">{toolName(entry.name)}</span>
          <code className="tool-sum od-truncate">{toolSummary(entry.input)}</code>
          <Icon name="chev" />
        </summary>
        <div className="tool-body">
          <pre className="tool-in">{entry.input}</pre>
          {entry.output === "" ? null : <pre className="tool-out">{entry.output}</pre>}
        </div>
      </details>
    </div>
  );
});

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
      }
    }
  }
}
