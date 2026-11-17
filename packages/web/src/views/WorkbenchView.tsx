import { text } from "@super-agent2/catalog";
import { chineseOf, type Ticket, type WaitingCard } from "@super-agent2/protocol";
import { type CSSProperties, useEffect } from "react";
import { offersSwitch, type PushPhase } from "../live/push.js";
import { ticketTones, type TicketsState } from "../live/tickets.js";
import { type Verdict, type WaitingState, useOf, waitingCount } from "../live/waiting.js";
import { Icon } from "../parts/icons.js";
import { HoldCard } from "./HoldCard.js";

export interface CardActions {
  arm(key: string): void;
  disarm(key: string): void;
  answer(key: string, verdict: Verdict): void;
}

export interface WorkbenchViewProps {
  readonly waiting: WaitingState;
  readonly actions: CardActions;
  readonly focus: string | null;
  readonly focused: () => void;
  readonly push: PushPhase;
  readonly togglePush: () => void;
  readonly tickets: TicketsState;
}

function Card({ card, waiting, actions, focus }: { readonly card: WaitingCard; readonly waiting: WaitingState; readonly actions: CardActions; readonly focus: string | null }) {
  switch (card.kind) {
    case "hold":
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

function TicketRow({ ticket }: { readonly ticket: Ticket }) {
  const { tone, live } = ticketTones[ticket.state];
  return (
    <div className="lrow" id={`ticket-${ticket.id}`}>
      <span className={`status status--${tone}`}>
        <span className={live ? `dot dot--${tone} dot--live` : `dot dot--${tone}`} />
        <span>{text(`ticket.state.${ticket.state}`)}</span>
      </span>
      <span className="lrow-main">
        <span className="lrow-title">{chineseOf(ticket.title)}</span>
        <span className="lrow-meta">
          {ticket.repository === null ? null : <span className="mono">{ticket.repository}</span>}
          <span className="chip">{text(`ticket.kind.${ticket.kind}`)}</span>
        </span>
      </span>
    </div>
  );
}

function Tickets({ tickets }: { readonly tickets: TicketsState }) {
  return (
    <section className="section" aria-label={text("tickets.list")}>
      <div className="section-head">
        <h2>{text("tickets.title")}</h2>
        {tickets.known ? <span className="count">{tickets.open.length}</span> : null}
      </div>
      {tickets.known && tickets.open.length === 0 ? (
        <div className="empty">
          <Icon name="check" />
          <strong>{text("tickets.empty")}</strong>
        </div>
      ) : null}
      {tickets.open.length > 0 ? (
        <div className="list">
          {tickets.open.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function WorkbenchView({ waiting, actions, focus, focused, push, togglePush, tickets }: WorkbenchViewProps) {
  const count = waitingCount(waiting);
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
          {waiting.cards.map((card) => (
            <Card key={card.key} card={card} waiting={waiting} actions={actions} focus={focus} />
          ))}
        </div>
      </section>
      <Tickets tickets={tickets} />
    </div>
  );
}
