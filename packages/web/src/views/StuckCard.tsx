import { text } from "@super-agent2/catalog";
import { chineseOf, type StuckAnswer, type StuckCard as Card } from "@super-agent2/protocol";
import { useState } from "react";
import type { CardUse } from "../live/waiting.js";
import { Icon } from "../parts/icons.js";
import { followLink } from "../parts/Shell.js";
import { clockOf } from "./Entries.js";
import { failureText } from "./HoldCard.js";
import { TicketCodeLabel } from "./TicketParts.js";

export interface StuckCardProps {
  readonly card: Card;
  readonly use: CardUse;
  readonly focused: boolean;
  readonly href: string;
  readonly open: () => void;
  readonly answer: (answer: StuckAnswer, words: string) => void;
}

export function StuckCard({ card, use, focused, href, open, answer }: StuckCardProps) {
  const { ticket, guidance } = card;
  const stuck = ticket.stuck;
  const [words, setWords] = useState("");
  if (stuck === null) {
    return null;
  }
  const sending = use.step === "sending";
  const busy = (verdict: StuckAnswer) => (sending && use.verdict === verdict ? " is-busy" : "");
  return (
    <article className={focused ? "wcard wcard--focus" : "wcard"} id={`card-${card.key}`} data-card={card.key} aria-label={`${chineseOf(ticket.title)} ${ticket.code}`}>
      <div className="wcard-kind">
        <span className="chip chip--warn">{text(`loop.failure.${stuck.failure.kind}`)}</span>
        <span className="chip">{text("ticket.roundValue", { round: stuck.round })}</span>
        {ticket.repository === null ? null : (
          <span className="chip chip--mono">
            <Icon name="repo" />
            {ticket.repository}
          </span>
        )}
        <span className="od-fill num">{clockOf(card.at)}</span>
      </div>
      <a className="card-title" href={href} onClick={(event) => followLink(event, open)}>
        <TicketCodeLabel code={ticket.code} /> {chineseOf(ticket.title)}
      </a>
      {stuck.where !== null ? (
        <p className="chain-reason">{chineseOf(stuck.where)}</p>
      ) : (
        <>
          {guidance === null ? null : <p className="chain-reason">{chineseOf(guidance)}</p>}
          {stuck.failure.detail === "" ? null : <span className="reason-raw">{stuck.failure.detail}</span>}
        </>
      )}
      <textarea
        className="field"
        rows={2}
        value={words}
        placeholder={text("stuck.words")}
        aria-label={text("stuck.words")}
        disabled={sending}
        onChange={(event) => setWords(event.target.value)}
      />
      {use.failure === null ? null : (
        <p className="field-err" role="alert">
          {failureText(use.failure)}
        </p>
      )}
      <div className="card-actions">
        <button className={`btn btn-primary${busy("resume")}`} type="button" disabled={sending} aria-busy={sending && use.verdict === "resume"} onClick={() => answer("resume", words)}>
          <Icon name="check" />
          {text("stuck.resume")}
        </button>
        <button className={`btn btn-danger${busy("give-up")}`} type="button" disabled={sending} aria-busy={sending && use.verdict === "give-up"} onClick={() => answer("give-up", words)}>
          {text("stuck.giveUp")}
        </button>
      </div>
    </article>
  );
}
