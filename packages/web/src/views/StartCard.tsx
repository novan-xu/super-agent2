import { text } from "@super-agent2/catalog";
import { chineseOf, type ChainBefore, type ChoiceChange, type StartCard as Card, ticketProject } from "@super-agent2/protocol";
import type { StartView } from "../live/chains.js";
import { canStartCard, changeOfEffort, changeOfEngine, changeOfMachine, changeOfModel, choiceOptions } from "../live/choice.js";
import { kindKey } from "../live/phase.js";
import { type CardUse, type WaitingState, useOf } from "../live/waiting.js";
import { Icon } from "../parts/icons.js";
import { failureText } from "./HoldCard.js";
import { RepairChip, TicketCodeLabel } from "./TicketParts.js";

export interface StartCardProps {
  readonly card: Card;
  readonly use: CardUse;
  readonly focused: boolean;
  readonly start: () => void;
  readonly choose: (change: ChoiceChange) => void;
}

function Choice({ card, busy, choose }: { readonly card: Card; readonly busy: boolean; readonly choose: (change: ChoiceChange) => void }) {
  const options = choiceOptions(card);
  const { choice } = card;
  const id = `choice-${card.ticket.id}`;
  const owned = (field: "machine" | "engine" | "model" | "effort") => (choice.by[field] === "owner" ? "field field--sm field--owner" : "field field--sm");
  return (
    <div className="wcard-where">
      <div className="form-row">
        <label htmlFor={`${id}-machine`}>{text("chains.machine")}</label>
        <select
          className={owned("machine")}
          id={`${id}-machine`}
          value={choice.machine ?? ""}
          disabled={busy || options.machines.length === 0}
          onChange={(event) => choose(changeOfMachine(card, event.target.value))}
        >
          {choice.machine === null ? <option value="" /> : null}
          {options.machines.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-engine`}>{text("chains.engine")}</label>
        <select
          className={owned("engine")}
          id={`${id}-engine`}
          value={choice.engine ?? ""}
          disabled={busy || options.engines.length === 0}
          onChange={(event) => {
            const engine = options.engines.find((entry) => entry === event.target.value);
            if (engine !== undefined) {
              choose(changeOfEngine(engine));
            }
          }}
        >
          {choice.engine === null ? <option value="" /> : null}
          {options.engines.map((engine) => (
            <option key={engine} value={engine}>
              {text(`engine.${engine}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-model`}>{text("chains.model")}</label>
        <select
          className={owned("model")}
          id={`${id}-model`}
          value={choice.model ?? ""}
          disabled={busy || options.models.length === 0}
          onChange={(event) => {
            if (event.target.value !== "") {
              choose(changeOfModel(card, event.target.value));
            }
          }}
        >
          {choice.model === null ? <option value="" /> : null}
          {options.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-effort`}>{text("chains.effort")}</label>
        <select
          className={owned("effort")}
          id={`${id}-effort`}
          value={choice.effort ?? ""}
          disabled={busy || options.efforts.length === 0}
          onChange={(event) => {
            if (event.target.value !== "") {
              choose(changeOfEffort(event.target.value));
            }
          }}
        >
          {choice.effort === null ? <option value="" /> : null}
          {options.efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function StartCard({ card, use, focused, start, choose }: StartCardProps) {
  const { ticket } = card;
  const repository = ticketProject(ticket);
  const sending = use.step === "sending";
  return (
    <article className={focused ? "wcard wcard--focus" : "wcard"} id={`card-${card.key}`} data-card={card.key} aria-label={`${chineseOf(ticket.title)} ${ticket.code.toUpperCase()}`}>
      <div className="wcard-kind">
        {repository === null ? null : (
          <span className="chip chip--mono">
            <Icon name="repo" />
            {repository}
          </span>
        )}
        <span className="chip">{text(kindKey(ticket))}</span>
        <RepairChip ticket={ticket} />
        {ticket.difficulty === null ? null : <span className="chip">{text(`ticket.difficulty.${ticket.difficulty}`)}</span>}
        {ticket.platform === null ? null : <span className="chip">{text(`ticket.platform.${ticket.platform}`)}</span>}
      </div>
      {ticket.issues.length > 0 ? null : (
        <>
          <p className="card-title"><TicketCodeLabel code={ticket.code} /> {chineseOf(ticket.title)}</p>
          <p className="chain-reason">{chineseOf(ticket.summary)}</p>
        </>
      )}
      {ticket.difficultyReason === null ? null : <p className="chain-reason">{chineseOf(ticket.difficultyReason)}</p>}
      <ol className="chain-issues" aria-label={text("chains.issues")}>
        {ticket.issues.map((issue) => (
          <li key={`${issue.repository}#${issue.number}`} className="chain-issue">
            <span className="check-title">{chineseOf(issue.title)}</span>
            <span className="check-meta mono">{`#${issue.number}`}</span>
          </li>
        ))}
      </ol>
      <Choice card={card} busy={sending} choose={choose} />
      {card.choice.missing.length === 0 ? null : (
        <ul className="chain-missing">
          {card.choice.missing.map((part) => (
            <li key={part}>{text(`chains.missing.${part}`)}</li>
          ))}
        </ul>
      )}
      {use.failure === null ? null : (
        <p className="field-err" role="alert">
          {failureText(use.failure)}
        </p>
      )}
      {canStartCard(card) ? (
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
  readonly choose: (key: string, change: ChoiceChange) => void;
}

export function StartBlocks({ view, waiting, focus, start, choose }: StartBlocksProps) {
  const total = view.all.length;
  const allIdle = view.all.every((key) => useOf(waiting, key).step === "idle");
  const startAll =
    total > 1 ? (
      <button className="btn btn-sm" type="button" disabled={!allIdle} onClick={() => start(view.all)}>
        <Icon name="check" />
        {text("chains.startAll")}
      </button>
    ) : null;
  const one = (card: Card) => (
    <StartCard
      key={card.key}
      card={card}
      use={useOf(waiting, card.key)}
      focused={focus === card.key}
      start={() => start([card.key])}
      choose={(change) => choose(card.key, change)}
    />
  );
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
