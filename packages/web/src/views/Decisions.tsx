import { text } from "@super-agent2/catalog";
import { chineseOf, type DecisionReview, type Ticket, type TicketDecision, unsettledDecisions } from "@super-agent2/protocol";
import { type KeyboardEvent, memo, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../parts/icons.js";
import { sendsOnEnter } from "../parts/keys.js";

export type ReviewDecision = (ticket: number, decision: number, review: DecisionReview) => Promise<boolean>;

interface RowProps {
  readonly ticket: number;
  readonly repository: string | null;
  readonly decision: TicketDecision;
  readonly review: ReviewDecision;
}

const DecisionRow = memo(function DecisionRow({ ticket, repository, decision, review }: RowProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<DecisionReview["verdict"] | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const opinion = draft.trim();

  useLayoutEffect(() => {
    const element = field.current;
    if (element !== null) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight + 2, 200)}px`;
    }
  }, [draft]);

  const settle = (given: DecisionReview) => {
    if (sending !== null) {
      return;
    }
    setSending(given.verdict);
    void review(ticket, decision.id, given).then((done) => {
      if (!done) {
        setSending(null);
      }
    });
  };

  const send = () => {
    if (opinion !== "") {
      settle({ verdict: "opinion", opinion });
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sendsOnEnter(event)) {
      event.preventDefault();
      send();
    }
  };

  const settled = decision.verdict !== null;
  return (
    <div className={settled ? "mrow drow drow--settled" : "mrow drow"} role="listitem" id={`decision-${decision.id}`}>
      <div className="mrow-main">
        <p className="mrow-text drow-chosen">{chineseOf(decision.chosen)}</p>
        <p className="drow-why">{chineseOf(decision.why)}</p>
        <p className="drow-other">
          <Icon name="swap" />
          <span>{chineseOf(decision.otherOptions)}</span>
        </p>
        {decision.pullRequest === null || repository === null ? null : (
          <div className="mrow-meta">
            <a className="mono" href={`https://github.com/${repository}/pull/${decision.pullRequest}`} target="_blank" rel="noreferrer">
              {`#${decision.pullRequest}`}
            </a>
          </div>
        )}
        {decision.verdict === "opinion" && decision.opinion !== null ? <p className="drow-opinion">{decision.opinion}</p> : null}
      </div>
      {decision.verdict === "ok" ? (
        <span className="drow-done" role="img" aria-label={text("decision.ok")} title={text("decision.ok")}>
          <Icon name="check" />
        </span>
      ) : null}
      {settled ? null : (
        <form
          className="drow-review"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <button
            className={`btn btn-sm${opinion === "" ? " btn-primary" : ""}${sending === "ok" ? " is-busy" : ""}`}
            type="button"
            disabled={sending !== null || opinion !== ""}
            aria-busy={sending === "ok"}
            onClick={() => settle({ verdict: "ok" })}
          >
            <Icon name="check" />
            {text("decision.ok")}
          </button>
          <textarea
            ref={field}
            className="field"
            rows={1}
            value={draft}
            placeholder={text("decision.opinion")}
            aria-label={text("decision.opinion")}
            disabled={sending !== null}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keyDown}
          />
          <button
            className={`btn btn-sm${opinion === "" ? "" : " btn-primary"}${sending === "opinion" ? " is-busy" : ""}`}
            type="submit"
            aria-label={text("decision.send")}
            title={text("decision.send")}
            disabled={sending !== null || opinion === ""}
            aria-busy={sending === "opinion"}
          >
            <Icon name="send" />
          </button>
        </form>
      )}
    </div>
  );
});

export function Decisions({ ticket, review }: { readonly ticket: Ticket; readonly review: ReviewDecision }) {
  if (ticket.decisions.length === 0) {
    return null;
  }
  const open = unsettledDecisions(ticket.decisions).length;
  const id = `decisions-${ticket.id}`;
  return (
    <section className="section decisions">
      <div className="section-head">
        <h2 id={id}>{text("decision.list")}</h2>
        {open === 0 ? null : <span className="count count--hot">{open}</span>}
      </div>
      <div className="mem-list" role="list" aria-labelledby={id}>
        {ticket.decisions.map((decision) => (
          <DecisionRow key={decision.id} ticket={ticket.id} repository={ticket.repository} decision={decision} review={review} />
        ))}
      </div>
    </section>
  );
}
