import { text } from "@super-agent2/catalog";
import { chineseOf, type ChoiceChange, type HoldCard as HoldCardData, type StuckAnswer, type Ticket } from "@super-agent2/protocol";
import { type CSSProperties, useEffect, useMemo } from "react";
import { startView } from "../live/chains.js";
import { offersSwitch, type PushPhase } from "../live/push.js";
import { ticketGroups, ticketPhase, ticketProblem, whereOf } from "../live/phase.js";
import type { TicketsState } from "../live/tickets.js";
import { type Verdict, type WaitingState, useOf, waitingCount } from "../live/waiting.js";
import { Icon } from "../parts/icons.js";
import { followLink } from "../parts/Shell.js";
import { HoldCard } from "./HoldCard.js";
import { StartBlocks } from "./StartCard.js";
import { StuckCard } from "./StuckCard.js";
import { ChainNumbers, engineName, momentOf, PhaseStatus, problemLines, problemTone, PullRequestNumbers } from "./TicketParts.js";

export interface CardActions {
  arm(key: string): void;
  disarm(key: string): void;
  answer(key: string, verdict: Verdict): void;
  start(keys: readonly string[]): void;
  choose(key: string, change: ChoiceChange): void;
  answerStuck(key: string, answer: StuckAnswer, words: string): void;
}

export interface WorkbenchViewProps {
  readonly waiting: WaitingState;
  readonly actions: CardActions;
  readonly focus: string | null;
  readonly focused: () => void;
  readonly push: PushPhase;
  readonly togglePush: () => void;
  readonly tickets: TicketsState;
  readonly ticketHref: (ticket: number) => string;
  readonly openTicket: (ticket: number) => void;
  readonly now: number;
}

function Card({ card, waiting, actions, focus }: { readonly card: HoldCardData; readonly waiting: WaitingState; readonly actions: CardActions; readonly focus: string | null }) {
  return (
    <HoldCard
      card={card}
      use={useOf(waiting, card.key)}
      focused={focus === card.key}
      arm={() => actions.arm(card.key)}
      disarm={() => actions.disarm(card.key)}
      answer={(verdict) => actions.answer(card.key, verdict)}
    />
  );
}

function PushSwitch({ phase, toggle }: { readonly phase: PushPhase; readonly toggle: () => void }) {
  if (phase === "install") {
    return <span className="push-note">{text("push.install")}</span>;
  }
  if (!offersSwitch(phase)) {
    return null;
  }
  return (
    <span className="switch-label">
      <button
        className="switch"
        type="button"
        role="switch"
        aria-checked={phase === "on" || phase === "working"}
        aria-label={text("push.label")}
        disabled={phase === "blocked" || phase === "working"}
        onClick={toggle}
      />
      {text("push.label")}
    </span>
  );
}

function TicketRow({ ticket, known, hrefOf, open, now }: { readonly ticket: Ticket; readonly known: ReadonlyMap<number, Ticket>; readonly hrefOf: (ticket: number) => string; readonly open: (ticket: number) => void; readonly now: number }) {
  const phase = ticketPhase(ticket);
  const problem = ticketProblem(ticket, known);
  const where = whereOf(ticket);
  return (
    <a className="lrow" id={`ticket-${ticket.id}`} href={hrefOf(ticket.id)} onClick={(event) => followLink(event, () => open(ticket.id))}>
      <PhaseStatus phase={phase} />
      <span className="lrow-main">
        <span className="lrow-title">{chineseOf(ticket.title)}</span>
        <span className="lrow-meta">
          <span className="chip">{text(`ticket.kind.${ticket.kind}`)}</span>
          {ticket.issues.length === 0 ? null : <ChainNumbers ticket={ticket} />}
          {where === null ? null : (
            <span className="chip chip--mono">
              <Icon name="machine" />
              {`${where.machine} · ${engineName(where.engine)}`}
            </span>
          )}
        </span>
        {problem === null ? null : <span className={`lrow-note lrow-note--${problemTone(problem)}`}>{problemLines(problem, now).join("：")}</span>}
      </span>
      <span className="lrow-side">
        {ticket.pullRequests.length === 0 ? null : <PullRequestNumbers ticket={ticket} />}
        <span className="num">{momentOf(ticket.updatedAt, now)}</span>
      </span>
    </a>
  );
}

function Tickets({ tickets, hrefOf, open, now }: { readonly tickets: TicketsState; readonly hrefOf: (ticket: number) => string; readonly open: (ticket: number) => void; readonly now: number }) {
  const groups = useMemo(() => ticketGroups(tickets.open), [tickets.open]);
  const known = useMemo(() => new Map(tickets.open.map((ticket) => [ticket.id, ticket])), [tickets.open]);
  const shown = groups.reduce((total, group) => total + group.tickets.length, 0);
  return (
    <section className="section" aria-label={text("tickets.list")}>
      <div className="section-head">
        <h2>{text("tickets.title")}</h2>
        {tickets.known ? <span className="count">{shown}</span> : null}
      </div>
      {tickets.known && shown === 0 ? (
        <div className="empty">
          <Icon name="check" />
          <strong>{text("tickets.empty")}</strong>
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.key} className="ticket-group" aria-label={group.repository ?? text("tickets.writing")}>
          <div className="chain-head">
            {group.repository === null ? (
              <h3>{text("tickets.writing")}</h3>
            ) : (
              <h3 className="mono">
                <Icon name="repo" />
                {group.repository}
              </h3>
            )}
            <span className="count">{group.tickets.length}</span>
          </div>
          <div className="list">
            {group.tickets.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} known={known} hrefOf={hrefOf} open={open} now={now} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function WorkbenchView({ waiting, actions, focus, focused, push, togglePush, tickets, ticketHref, openTicket, now }: WorkbenchViewProps) {
  const count = waitingCount(waiting);
  const holds = useMemo(() => waiting.cards.flatMap((card) => (card.kind === "hold" ? [card] : [])), [waiting.cards]);
  const stuck = useMemo(() => waiting.cards.flatMap((card) => (card.kind === "stuck" ? [card] : [])), [waiting.cards]);
  const starts = useMemo(() => startView(waiting.cards), [waiting.cards]);
  const present = focus !== null && waiting.cards.some((card) => card.key === focus);

  useEffect(() => {
    if (focus === null || !waiting.known) {
      return;
    }
    if (present) {
      document.getElementById(`card-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    const timer = window.setTimeout(focused, present ? 2400 : 0);
    return () => window.clearTimeout(timer);
  }, [focus, focused, present, waiting.known]);

  return (
    <div className="page page--narrow">
      <section className="section" aria-label={text("waiting.list")}>
        <div className="section-head">
          <h2>{text("waiting.title")}</h2>
          {waiting.known ? <span className={count > 0 ? "count count--hot" : "count"}>{count}</span> : null}
          <span className="od-fill" />
          <PushSwitch phase={push} toggle={togglePush} />
        </div>
        {push === "blocked" ? (
          <p className="push-note">
            <Icon name="alert" />
            {text("push.blocked")}
          </p>
        ) : null}
        {waiting.known && count === 0 ? (
          <div className="empty">
            <Icon name="check" />
            <strong>{text("waiting.empty")}</strong>
          </div>
        ) : null}
        <div className="od-stack" style={{ "--od-gap": "16px" } as CSSProperties}>
          {holds.map((card) => (
            <Card key={card.key} card={card} waiting={waiting} actions={actions} focus={focus} />
          ))}
          {stuck.map((card) => (
            <StuckCard
              key={card.key}
              card={card}
              use={useOf(waiting, card.key)}
              focused={focus === card.key}
              href={ticketHref(card.ticket.id)}
              open={() => openTicket(card.ticket.id)}
              arm={() => actions.arm(card.key)}
              disarm={() => actions.disarm(card.key)}
              answer={(answer, words) => actions.answerStuck(card.key, answer, words)}
            />
          ))}
        </div>
        <StartBlocks view={starts} waiting={waiting} focus={focus} start={actions.start} choose={actions.choose} />
      </section>
      <Tickets tickets={tickets} hrefOf={ticketHref} open={openTicket} now={now} />
    </div>
  );
}
