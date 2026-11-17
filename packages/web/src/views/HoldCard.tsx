import { text } from "@super-agent2/catalog";
import type { HoldCard as Card } from "@super-agent2/protocol";
import type { Failure } from "../hub/api.js";
import { type CardUse, type Verdict } from "../live/waiting.js";
import { rawSegments } from "../live/raw.js";
import { Icon } from "../parts/icons.js";
import { clockOf } from "./Entries.js";

export function failureText(failure: Failure): string {
  return failure === "network" ? text("failure.network") : text(`refusal.${failure}`);
}

export interface HoldCardProps {
  readonly card: Card;
  readonly use: CardUse;
  readonly focused: boolean;
  readonly arm: () => void;
  readonly disarm: () => void;
  readonly answer: (verdict: Verdict) => void;
}

export function HoldCard({ card, use, focused, arm, disarm, answer }: HoldCardProps) {
  const { command, hold } = card;
  const environment = Object.entries(command.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sending = use.step === "sending";
  const busy = (verdict: Verdict) => (sending && use.verdict === verdict ? " is-busy" : "");
  return (
    <article className={focused ? "wcard wcard--focus" : "wcard"} id={`card-${card.key}`} data-card={card.key} aria-labelledby={`card-${card.key}-form`}>
      <div className="wcard-kind">
        <span className="chip chip--warn" id={`card-${card.key}-form`}>
          {hold.description}
        </span>
        <span className="chip chip--mono" title={text("hold.target")} aria-label={text("hold.target")} role="img">
          <Icon name="terminal" />
          <span aria-hidden="true">{command.target}</span>
        </span>
        <span className="chip chip--mono" title={text("hold.account")} aria-label={text("hold.account")} role="img">
          <Icon name="user" />
          <span aria-hidden="true">{command.account}</span>
        </span>
        <span className="od-fill num">{clockOf(card.at)}</span>
      </div>
      <pre className="raw" tabIndex={0} aria-label={text("hold.command")}>
        {rawSegments(command.command).map((segment, index) =>
          segment.hidden ? (
            <mark key={index} className="raw-hidden" title={text("hold.hidden")}>
              {segment.text}
            </mark>
          ) : (
            segment.text
          ),
        )}
      </pre>
      {environment.length === 0 ? null : (
        <pre className="raw raw-environment" tabIndex={0} aria-label={text("hold.environment")} title={text("hold.environment")}>
          {rawSegments(environment.map(([name, value]) => `${name}=${value}`).join("\n")).map((segment, index) =>
            segment.hidden ? (
              <mark key={index} className="raw-hidden" title={text("hold.hidden")}>
                {segment.text}
              </mark>
            ) : (
              segment.text
            ),
          )}
        </pre>
      )}
      {command.cwd === null ? null : (
        <div className="raw-folder" title={text("hold.folder")}>
          <Icon name="folder" />
          <span className="mono" aria-label={text("hold.folder")}>
            {command.cwd}
          </span>
        </div>
      )}
      {use.failure === null ? null : (
        <p className="field-err" role="alert">
          {failureText(use.failure)}
        </p>
      )}
      {use.step === "armed" ? (
        <div className="card-actions">
          <button className="btn" type="button" autoFocus onClick={disarm}>
            {text("hold.cancel")}
          </button>
          <button className="btn btn-danger-solid" type="button" onClick={() => answer("release")}>
            <Icon name="check" />
            {text("hold.confirm")}
          </button>
        </div>
      ) : (
        <div className="card-actions">
          <button className={`btn btn-primary${busy("release")}`} type="button" disabled={sending} onClick={arm}>
            <Icon name="check" />
            {text("hold.confirm")}
          </button>
          <button className={`btn${busy("refuse")}`} type="button" disabled={sending} onClick={() => answer("refuse")}>
            {text("hold.refuse")}
          </button>
        </div>
      )}
    </article>
  );
}
