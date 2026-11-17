import { text } from "@super-agent2/catalog";
import { chineseOf, type ChainBefore, type StartCard as Card } from "@super-agent2/protocol";
import type { StartView } from "../live/chains.js";
import { type CardUse, type WaitingState, useOf } from "../live/waiting.js";
import { Icon } from "../parts/icons.js";
import { failureText } from "./HoldCard.js";

export interface StartCardProps {
  readonly card: Card;
  readonly use: CardUse;
  readonly focused: boolean;
  readonly start: () => void;
}

export function StartCard({ card, use, focused, start }: StartCardProps) {
  const { ticket } = card;
  const sending = use.step === "sending";
  return (
    <article className={focused ? "wcard wcard--focus" : "wcard"} id={`card-${card.key}`} data-card={card.key} aria-label={chineseOf(ticket.title)}>
      <div className="wcard-kind">
        {ticket.repository === null ? null : (
          <span className="chip chip--mono">
            <Icon name="repo" />
            {ticket.repository}
          </span>
        )}
        <span className="chip">{text(`ticket.kind.${ticket.kind}`)}</span>
      </div>
      <ol className="chain-issues" aria-label={text("chains.issues")}>
        {ticket.issues.map((issue) => (
          <li key={`${issue.repository}#${issue.number}`} className="chain-issue">
            <span className="check-title">{chineseOf(issue.title)}</span>
            <span className="check-meta mono">{`#${issue.number}`}</span>
          </li>
        ))}
      </ol>
      {use.failure === null ? null : (
        <p className="field-err" role="alert">
          {failureText(use.failure)}
        </p>
      )}
      {card.startable ? (
        <div className="card-actions">
          <button className={`btn btn-primary${sending ? " is-busy" : ""}`} type="button" disabled={sending} aria-busy={sending} onClick={start}>
            <Icon name="check" />
            {text("chains.start")}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function Before({ before }: { readonly before: readonly ChainBefore[] }) {
  return (
    <div className="chain-before">
      {before.map((entry) => (
        <span key={entry.id} className="chain-before-item">
          <span className={`dot dot--${entry.state === "working" || entry.state === "verifying" ? "ok" : "mute"}`} />
          <span>{chineseOf(entry.title)}</span>
        </span>
      ))}
    </div>
  );
}

export interface StartBlocksProps {
  readonly view: StartView;
  readonly waiting: WaitingState;
  readonly focus: string | null;
  readonly start: (keys: readonly string[]) => void;
}

export function StartBlocks({ view, waiting, focus, start }: StartBlocksProps) {
  const total = view.all.length;
  const allIdle = view.all.every((key) => useOf(waiting, key).step === "idle");
  const startAll =
    total > 1 ? (
      <button className="btn btn-sm" type="button" disabled={!allIdle} onClick={() => start(view.all)}>
        <Icon name="check" />
        {text("chains.startAll")}
      </button>
    ) : null;
  const one = (card: Card) => <StartCard key={card.key} card={card} use={useOf(waiting, card.key)} focused={focus === card.key} start={() => start([card.key])} />;
  return (
    <>
      {view.now.length > 0 ? (
        <div className="chain-block" aria-label={text("chains.now")}>
          <div className="chain-head">
            <h3>{text("chains.now")}</h3>
            <span className="od-fill" />
            {startAll}
          </div>
          <div className="od-stack chain-stack">{view.now.map(one)}</div>
        </div>
      ) : null}
      {view.later.length > 0 ? (
        <div className="chain-block" aria-label={text("chains.later")}>
          <div className="chain-head">
            <h3>{text("chains.later")}</h3>
            <span className="od-fill" />
            {view.now.length > 0 ? null : startAll}
          </div>
          {view.later.map((group) => (
            <div key={group.key} className="chain-group">
              <Before before={group.before} />
              <div className="od-stack chain-stack">{group.cards.map(one)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
