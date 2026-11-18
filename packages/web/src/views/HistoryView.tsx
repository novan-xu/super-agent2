import { text } from "@super-agent2/catalog";
import { chineseOf, type Ticket } from "@super-agent2/protocol";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { type HistoryState, historyLine, matchNote } from "../live/history.js";
import { Icon } from "../parts/icons.js";
import { followLink } from "../parts/Shell.js";
import { ChainNumbers, momentOf, PhaseStatus, PullRequestNumbers } from "./TicketParts.js";

export interface HistoryViewProps {
  readonly history: HistoryState;
  readonly ticketHref: (ticket: number) => string;
  readonly openTicket: (ticket: number) => void;
  readonly search: (query: string) => void;
  readonly more: () => void;
  readonly retry: () => void;
  readonly scroll: number;
  readonly scrolled: (top: number) => void;
  readonly now: number;
}

interface RowProps {
  readonly ticket: Ticket;
  readonly query: string;
  readonly href: string;
  readonly open: (ticket: number) => void;
  readonly now: number;
}

const HistoryRow = memo(function HistoryRow({ ticket, query, href, open, now }: RowProps) {
  const line = historyLine(ticket);
  const note = matchNote(ticket, query);
  return (
    <a className="lrow" id={`ticket-${ticket.id}`} href={href} onClick={(event) => followLink(event, () => open(ticket.id))}>
      <PhaseStatus phase={line.how} />
      <span className="lrow-main">
        <span className="lrow-title">{chineseOf(ticket.title)}</span>
        <span className="lrow-meta">
          <span className="chip">{text(`ticket.kind.${ticket.kind}`)}</span>
          {ticket.repository === null ? null : (
            <span className="chip chip--mono">
              <Icon name="repo" />
              {ticket.repository}
            </span>
          )}
          {ticket.issues.length === 0 ? null : <ChainNumbers ticket={ticket} />}
        </span>
        {line.reason === null ? null : <span className="lrow-note">{line.reason}</span>}
        {note === null ? null : <span className="lrow-note lrow-note--match">{note}</span>}
      </span>
      <span className="lrow-side">
        <span className="num">{momentOf(ticket.endedAt ?? ticket.updatedAt, now)}</span>
        {ticket.pullRequests.length === 0 ? null : <PullRequestNumbers ticket={ticket} />}
      </span>
    </a>
  );
});

function useScroll(scroll: number, scrolled: (top: number) => void, applied: string): void {
  const before = useRef(applied);
  const initial = useRef(scroll);
  const report = useRef(scrolled);
  report.current = scrolled;
  useLayoutEffect(() => {
    const main = document.getElementById("main");
    if (main === null) {
      return;
    }
    main.scrollTop = initial.current;
    const moved = () => report.current(main.scrollTop);
    main.addEventListener("scroll", moved, { passive: true });
    return () => main.removeEventListener("scroll", moved);
  }, []);
  useLayoutEffect(() => {
    if (before.current === applied) {
      return;
    }
    before.current = applied;
    const main = document.getElementById("main");
    if (main !== null) {
      main.scrollTop = 0;
    }
  }, [applied]);
}

export function HistoryView({ history, ticketHref, openTicket, search, more, retry, scroll, scrolled, now }: HistoryViewProps) {
  const [draft, setDraft] = useState(history.query);
  const composing = useRef(false);
  useScroll(scroll, scrolled, history.applied);
  const ready = history.status === "ready" && !history.stale;
  const empty = ready && history.tickets.length === 0;
  const commit = (query: string) => {
    setDraft(query);
    search(query);
  };
  return (
    <div className="page">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input
            className="field"
            type="search"
            value={draft}
            aria-label={text("history.search")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              if (!composing.current) {
                search(event.target.value);
              }
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              search(event.currentTarget.value);
            }}
          />
        </div>
      </div>
      {history.status === "failed" ? (
        <div className="empty">
          <Icon name="alert" />
          <strong>{text("history.failed")}</strong>
          <button className="btn" type="button" onClick={retry}>
            {text("history.retry")}
          </button>
        </div>
      ) : null}
      {empty && history.applied === "" ? (
        <div className="empty">
          <Icon name="check" />
          <strong>{text("history.empty")}</strong>
        </div>
      ) : null}
      {empty && history.applied !== "" ? (
        <div className="empty">
          <Icon name="search" />
          <strong>{text("history.noMatch", { query: history.applied })}</strong>
          <button className="btn" type="button" onClick={() => commit("")}>
            {text("history.clear")}
          </button>
        </div>
      ) : null}
      {history.tickets.length === 0 || history.status === "failed" ? null : (
        <div className="list" aria-label={text("history.list")} aria-busy={!ready}>
          {history.tickets.map((ticket) => (
            <HistoryRow key={ticket.id} ticket={ticket} query={history.applied} href={ticketHref(ticket.id)} open={openTicket} now={now} />
          ))}
        </div>
      )}
      {ready && history.next !== null ? (
        <div className="more">
          <button className={history.more === "loading" ? "btn is-busy" : "btn"} type="button" disabled={history.more === "loading"} aria-busy={history.more === "loading"} onClick={more}>
            {text("history.more")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
