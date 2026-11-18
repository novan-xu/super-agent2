import { text } from "@super-agent2/catalog";
import { type ChoiceChange, chineseOf, type MachineChoice, mergedIssueNumbers, type Ticket } from "@super-agent2/protocol";
import { type KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type DetailState, isWorkLive, moveLabel, type TimelineEntry, timeline } from "../live/detail.js";
import { panelOffers, ticketPhase, ticketProblem, type TicketProblem } from "../live/phase.js";
import { draftOptions, draftWithEffort, draftWithEngine, draftWithMachine, draftWithModel, initialDraft, type ReassignDraft, reassignChange, reassignMachines } from "../live/reassign.js";
import type { LogItem } from "../live/work.js";
import { Icon } from "../parts/icons.js";
import { sendsOnEnter } from "../parts/keys.js";
import { followLink } from "../parts/Shell.js";
import { clockOf, DeliveryBody, TextBody, ToolFold } from "./Entries.js";
import { engineName, momentOf, PhaseStatus, problemLines, problemTone, pullRequestTones } from "./TicketParts.js";

const nearBottom = 48;

export type TicketOrigin = "workbench" | "history";

export interface TicketActions {
  stop(ticket: number): Promise<boolean>;
  reassign(ticket: number, change: ChoiceChange): Promise<boolean>;
  message(ticket: number, text: string): Promise<boolean>;
  machines(): Promise<MachineChoice[] | undefined>;
}

export interface TicketViewProps {
  readonly detail: DetailState | null;
  readonly known: ReadonlyMap<number, Ticket>;
  readonly actions: TicketActions;
  readonly origin: TicketOrigin;
  readonly backHref: string;
  readonly back: () => void;
  readonly now: number;
}

function githubRepository(repository: string): string {
  return `https://github.com/${repository}`;
}

const WorkItem = memo(function WorkItem({ item, live, last, ticket }: { readonly item: LogItem; readonly live: boolean; readonly last: boolean; readonly ticket: Ticket }) {
  switch (item.kind) {
    case "text":
      return <TextBody text={item.text} live={live && last} />;
    case "tool":
      return <ToolFold name={item.name} input={item.input} output={item.output} state={item.state} stopped={item.state === "running" && !live} />;
    case "message":
      return (
        <div className={item.from === "owner" ? "work-msg work-msg--me" : "work-msg"}>
          <span className="work-msg-who">
            <strong>{text(`timeline.from.${item.from}`)}</strong>
            <span className="num">{clockOf(item.at)}</span>
          </span>
          <span className="work-msg-text">{item.text}</span>
        </div>
      );
    case "finished":
      return (
        <div className="work-end work-end--ok">
          <a className="work-pr" href={item.url} target="_blank" rel="noreferrer">
            <Icon name="pr" />
            {text("timeline.pullRequest", { number: item.pullRequest })}
            <Icon name="ext" />
          </a>
          {item.report.zh === "" ? null : <p className="work-report">{chineseOf(item.report)}</p>}
        </div>
      );
    case "delivered":
      return (
        <div className="work-end">
          <DeliveryBody ticket={ticket.id} title={chineseOf(ticket.title)} at={item.at} text={item.text} files={item.files} />
          {item.report.zh === "" ? null : <p className="work-report">{chineseOf(item.report)}</p>}
        </div>
      );
    case "failed":
      return (
        <div className="reason">
          <strong>{text(`work.failure.${item.failure}`)}</strong>
          {item.reason === "" ? null : <span className="reason-raw">{item.reason}</span>}
        </div>
      );
    case "stopped":
      return (
        <div className="sysline sysline--warn">
          <Icon name="stop" />
          <span>{item.saved ? text("timeline.workSaved") : text("timeline.workStopped")}</span>
        </div>
      );
  }
});

function AttemptEntry({ entry, ticket, now }: { readonly entry: Extract<TimelineEntry, { readonly kind: "attempt" }>; readonly ticket: Ticket; readonly now: number }) {
  const live = isWorkLive(entry);
  const items = entry.log?.items ?? [];
  const status = entry.status;
  const lastItem = items.at(-1);
  const quiet = lastItem === undefined || lastItem.kind !== "text";
  const failed = status?.state === "failed";
  return (
    <li className={`tl tl--worker${live ? " tl--live" : ""}${failed ? " tl--bad" : ""}`}>
      <span className="tl-rail">
        <span className="tl-dot" />
      </span>
      <div className="tl-body">
        <div className="tl-head">
          <strong>{status === null ? text("timeline.attempt", { attempt: entry.number }) : engineName(status.engine)}</strong>
          {status === null ? null : <span className="mono">{`${status.model} · ${status.effort}`}</span>}
          {status === null ? null : (
            <span className="mono tl-machine">
              <Icon name="machine" />
              {status.machine}
            </span>
          )}
          {entry.number > 1 && status !== null ? <span className="chip">{text("timeline.attempt", { attempt: entry.number })}</span> : null}
          <span className="muted">{momentOf(entry.at, now)}</span>
        </div>
        {entry.round === null ? null : (
          <div className="work-msg">
            <span className="work-msg-who">
              <strong>{entry.round.round === null ? text("timeline.retry") : text("timeline.round", { round: entry.round.round })}</strong>
              <span className="muted">{text(`loop.failure.${entry.round.failure.kind}`)}</span>
            </span>
            <span className="work-msg-text">{chineseOf(entry.round.guidance)}</span>
          </div>
        )}
        <div className="work-log">
          {items.map((item, index) => (
            <WorkItem key={item.key} item={item} live={live} last={index === items.length - 1} ticket={ticket} />
          ))}
          {live && quiet ? (
            <span className="typing" role="img" aria-label={text("ticket.working")}>
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function MoveEntry({ entry, now }: { readonly entry: Extract<TimelineEntry, { readonly kind: "move" }>; readonly now: number }) {
  const label = moveLabel(entry.move);
  const tone = label === "merged" || label === "delivered" ? " tl--ok" : label === "stopped" || label === "stuck" ? " tl--bad" : "";
  return (
    <li className={`tl${tone}`}>
      <span className="tl-rail">
        <span className="tl-dot" />
      </span>
      <div className="tl-body">
        <div className="tl-head">
          <strong>{text(`timeline.${label}`)}</strong>
          <span className="muted">{momentOf(entry.at, now)}</span>
        </div>
        {entry.move.reason === null ? null : <div className="tl-text">{chineseOf(entry.move.reason)}</div>}
      </div>
    </li>
  );
}

function FiledEntry({ ticket, now }: { readonly ticket: Ticket; readonly now: number }) {
  return (
    <li className="tl">
      <span className="tl-rail">
        <span className="tl-dot" />
      </span>
      <div className="tl-body">
        <div className="tl-head">
          <strong>{text("timeline.filed")}</strong>
          <span className="muted">{momentOf(ticket.createdAt, now)}</span>
        </div>
        <div className="tl-text">{chineseOf(ticket.summary)}</div>
      </div>
    </li>
  );
}

function ProblemBox({ problem, now }: { readonly problem: TicketProblem; readonly now: number }) {
  const tone = problemTone(problem);
  const [first, ...rest] = problemLines(problem, now);
  if (problem.kind === "waits") {
    return (
      <div className="chain-before">
        {problem.before.map((entry) => (
          <span key={entry.id} className="chain-before-item">
            <span className={`dot dot--${entry.state === "working" || entry.state === "verifying" ? "ok" : "mute"}`} />
            <span>{entry.title ?? text("ticket.number", { ticket: entry.id })}</span>
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className={tone === "bad" ? "reason" : tone === "warn" ? "reason reason--warn" : "reason reason--mute"} role={tone === "mute" ? undefined : "alert"}>
      <strong>{first}</strong>
      {rest.map((line) => (
        <span key={line} className="reason-raw">
          {line}
        </span>
      ))}
    </div>
  );
}

function OwnerMark({ owner }: { readonly owner: boolean }) {
  return owner ? (
    <span className="owner-mark" role="img" aria-label={text("ticket.ownerChose")} title={text("ticket.ownerChose")}>
      <Icon name="user" />
    </span>
  ) : null;
}

function Reassign({ ticket, actions, done }: { readonly ticket: Ticket; readonly actions: TicketActions; readonly done: () => void }) {
  const [machines, setMachines] = useState<MachineChoice[] | null>(null);
  const [draft, setDraft] = useState<ReassignDraft>(() => initialDraft(ticket));
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let alive = true;
    void actions.machines().then((found) => {
      if (alive) {
        setMachines(found === undefined ? [] : reassignMachines(ticket, found));
      }
    });
    return () => {
      alive = false;
    };
  }, [actions, ticket]);
  const offered = machines ?? [];
  const options = draftOptions(draft, offered);
  const change = reassignChange(draft);
  const id = `reassign-${ticket.id}`;
  const busy = sending || machines === null;
  const submit = async () => {
    if (change === undefined || sending) {
      return;
    }
    setSending(true);
    const ok = await actions.reassign(ticket.id, change);
    setSending(false);
    if (ok) {
      done();
    }
  };
  return (
    <form
      className="reassign"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="wcard-where">
        <div className="form-row">
          <label htmlFor={`${id}-machine`}>{text("chains.machine")}</label>
          <select className="field field--sm" id={`${id}-machine`} value={draft.machine ?? ""} disabled={busy} onChange={(event) => setDraft(draftWithMachine(draft, event.target.value, offered))}>
            {draft.machine === null ? <option value="" /> : null}
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
            className="field field--sm"
            id={`${id}-engine`}
            value={draft.engine ?? ""}
            disabled={busy || options.engines.length === 0}
            onChange={(event) => {
              const engine = options.engines.find((entry) => entry === event.target.value);
              if (engine !== undefined) {
                setDraft(draftWithEngine(draft, engine));
              }
            }}
          >
            {draft.engine === null ? <option value="" /> : null}
            {options.engines.map((engine) => (
              <option key={engine} value={engine}>
                {text(`engine.${engine}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor={`${id}-model`}>{text("chains.model")}</label>
          <select className="field field--sm" id={`${id}-model`} value={draft.model ?? ""} disabled={busy} onChange={(event) => setDraft(draftWithModel(draft, event.target.value, offered))}>
            <option value="">{text("ticket.defaultModel")}</option>
            {options.models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor={`${id}-effort`}>{text("chains.effort")}</label>
          <select className="field field--sm" id={`${id}-effort`} value={draft.effort ?? ""} disabled={busy || draft.model === null} onChange={(event) => setDraft(draftWithEffort(draft, event.target.value))}>
            {draft.effort === null ? <option value="" /> : null}
            {options.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="panel-actions">
        <button className="btn btn-sm" type="button" onClick={done} disabled={sending}>
          {text("ticket.cancel")}
        </button>
        <button className={`btn btn-primary btn-sm${sending ? " is-busy" : ""}`} type="submit" disabled={busy || change === undefined} aria-busy={sending}>
          <Icon name="swap" />
          {text("ticket.reassign")}
        </button>
      </div>
    </form>
  );
}

type StopStep = "idle" | "armed" | "sending";

function Actions({ ticket, actions }: { readonly ticket: Ticket; readonly actions: TicketActions }) {
  const offers = panelOffers(ticket);
  const [stop, setStop] = useState<StopStep>("idle");
  const [reassigning, setReassigning] = useState(false);
  const closeReassign = useCallback(() => setReassigning(false), []);
  useEffect(() => {
    setStop("idle");
    setReassigning(false);
  }, [ticket.id]);
  if (!offers.stop && !offers.reassign) {
    return null;
  }
  if (reassigning) {
    return <Reassign ticket={ticket} actions={actions} done={closeReassign} />;
  }
  if (stop === "armed") {
    return (
      <div className="panel-actions" key="armed">
        <button
          key="confirm"
          className="btn btn-danger-solid btn-sm"
          type="button"
          onClick={() => {
            setStop("sending");
            void actions.stop(ticket.id).then(() => setStop("idle"));
          }}
        >
          <Icon name="stop" />
          {text("ticket.stop")}
        </button>
        <button key="cancel" className="btn btn-sm" type="button" autoFocus onClick={() => setStop("idle")}>
          {text("ticket.cancel")}
        </button>
      </div>
    );
  }
  return (
    <div className="panel-actions" key="idle">
      {offers.reassign ? (
        <button className="btn btn-sm" type="button" disabled={stop === "sending"} onClick={() => setReassigning(true)}>
          <Icon name="swap" />
          {text("ticket.reassign")}
        </button>
      ) : null}
      {offers.stop ? (
        <button className={`btn btn-danger btn-sm${stop === "sending" ? " is-busy" : ""}`} type="button" disabled={stop === "sending"} aria-busy={stop === "sending"} onClick={() => setStop("armed")}>
          <Icon name="stop" />
          {text("ticket.stop")}
        </button>
      ) : null}
    </div>
  );
}

function Panel({ ticket, known, actions, now }: { readonly ticket: Ticket; readonly known: ReadonlyMap<number, Ticket>; readonly actions: TicketActions; readonly now: number }) {
  const [open, setOpen] = useState(false);
  const phase = ticketPhase(ticket);
  const problem = ticketProblem(ticket, known);
  const by = ticket.chosenBy;
  const work = ticket.work;
  const machine = work?.machine ?? ticket.machine;
  const engine = work?.engine ?? ticket.engine;
  const verification = ticket.verification;
  const rest = `ticket-panel-${ticket.id}`;
  const merged = new Set(mergedIssueNumbers(ticket));
  return (
    <aside className={open ? "panel" : "panel is-collapsed"} aria-label={text("ticket.panel")}>
      <div className="panel-sec panel-sec--summary">
        <div className="od-row">
          <PhaseStatus phase={phase} />
          <span className="od-fill" />
          <button className="btn btn-ghost btn-sm panel-toggle" type="button" aria-expanded={open} aria-controls={rest} onClick={() => setOpen(!open)}>
            {open ? text("ticket.less") : text("ticket.more")}
          </button>
        </div>
        {problem === null ? null : <ProblemBox problem={problem} now={now} />}
        <dl className="kv">
          {machine === null || engine === null ? null : (
            <>
              <dt>{text("ticket.where")}</dt>
              <dd className="mono">{`${machine} · ${engineName(engine)}`}</dd>
            </>
          )}
          {ticket.pullRequest === null || ticket.repository === null ? null : (
            <>
              <dt>{text("ticket.pullRequest")}</dt>
              <dd>
                <a className="mono" href={`${githubRepository(ticket.repository)}/pull/${ticket.pullRequest}`} target="_blank" rel="noreferrer">
                  {`#${ticket.pullRequest}`}
                </a>
              </dd>
            </>
          )}
          {verification === null || verification.rule === null ? null : (
            <>
              <dt>{text("ticket.rule")}</dt>
              <dd>{text(`verification.rule.${verification.rule}`)}</dd>
            </>
          )}
          {verification === null || verification.pipeline === null ? null : (
            <>
              <dt>{text("ticket.pipeline")}</dt>
              <dd>
                <a className="mono" href={verification.pipeline.url} target="_blank" rel="noreferrer">
                  {`#${verification.pipeline.number}`}
                </a>
              </dd>
            </>
          )}
          {ticket.round > 0 ? (
            <>
              <dt>{text("ticket.round")}</dt>
              <dd>{text("ticket.roundValue", { round: ticket.round })}</dd>
            </>
          ) : null}
        </dl>
        <Actions ticket={ticket} actions={actions} />
      </div>
      <div className="panel-rest" id={rest}>
        {ticket.issues.length === 0 ? null : (
          <div className="panel-sec">
            <h3>{text("ticket.issues")}</h3>
            <ol className="chain-issues">
              {ticket.issues.map((issue) => (
                <li key={`${issue.repository}#${issue.number}`} className={merged.has(issue.number) ? "chain-issue is-merged" : "chain-issue"}>
                  <a className="check-title" href={issue.url} target="_blank" rel="noreferrer">
                    {chineseOf(issue.title)}
                  </a>
                  <span className="check-meta mono">{`#${issue.number}`}</span>
                  {merged.has(issue.number) ? <Icon name="check" /> : null}
                </li>
              ))}
            </ol>
          </div>
        )}
        {ticket.pullRequests.length === 0 ? null : (
          <div className="panel-sec">
            <h3>{text("ticket.pullRequest")}</h3>
            <ol className="chain-pulls">
              {ticket.pullRequests.map((pull) => (
                <li key={pull.number} className="chain-pull">
                  <span className="status">
                    <span className={`dot dot--${pullRequestTones[pull.state]}`} />
                    <span>{text(`ticket.pullState.${pull.state}`)}</span>
                  </span>
                  <a className="mono" href={pull.url} target="_blank" rel="noreferrer">
                    {`#${pull.number}`}
                  </a>
                  <span className="check-meta mono">{pull.closes.map((number) => `#${number}`).join(" ")}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {ticket.repository === null ? null : (
          <div className="panel-sec">
            <h3>{text("ticket.code")}</h3>
            <dl className="kv">
              <dt>{text("ticket.repository")}</dt>
              <dd>
                <a className="mono" href={githubRepository(ticket.repository)} target="_blank" rel="noreferrer">
                  {ticket.repository}
                </a>
              </dd>
              <dt>{text("ticket.branch")}</dt>
              <dd className="mono">
                {ticket.branch === null ? (
                  "—"
                ) : (
                  <a href={`${githubRepository(ticket.repository)}/tree/${ticket.branch}`} target="_blank" rel="noreferrer">
                    {ticket.branch}
                  </a>
                )}
              </dd>
            </dl>
          </div>
        )}
        <div className="panel-sec">
          <h3>{text("ticket.run")}</h3>
          <dl className="kv">
            <dt>{text("ticket.machine")}</dt>
            <dd className="mono">
              {ticket.machine ?? "—"}
              <OwnerMark owner={by?.machine === "owner"} />
            </dd>
            <dt>{text("ticket.engine")}</dt>
            <dd>
              {ticket.engine === null ? "—" : engineName(ticket.engine)}
              <OwnerMark owner={by?.engine === "owner"} />
            </dd>
            <dt>{text("ticket.model")}</dt>
            <dd className="mono">
              {ticket.model ?? "—"}
              <OwnerMark owner={by?.model === "owner"} />
            </dd>
            <dt>{text("ticket.effort")}</dt>
            <dd className="mono">
              {ticket.effort ?? "—"}
              <OwnerMark owner={by?.effort === "owner"} />
            </dd>
            {ticket.ran === null ? null : (
              <>
                <dt>{text("ticket.ran")}</dt>
                <dd className="mono">
                  {ticket.ran.machine === ticket.machine && ticket.ran.engine === ticket.engine
                    ? `${ticket.ran.model} · ${ticket.ran.effort}`
                    : `${ticket.ran.machine} · ${engineName(ticket.ran.engine)} · ${ticket.ran.model} · ${ticket.ran.effort}`}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>
    </aside>
  );
}

function Reply({ ticket, send }: { readonly ticket: number; readonly send: (text: string) => Promise<boolean> }) {
  const [drafts, setDrafts] = useState<Readonly<Record<number, string>>>({});
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = drafts[ticket] ?? "";

  useLayoutEffect(() => {
    const element = field.current;
    if (element !== null) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight + 2, 200)}px`;
    }
  }, [draft]);

  const submit = async () => {
    const message = draft.trim();
    if (message === "" || sending) {
      return;
    }
    setSending(true);
    const sent = await send(message);
    setSending(false);
    if (sent) {
      setDrafts((all) => ({ ...all, [ticket]: "" }));
    }
    field.current?.focus();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sendsOnEnter(event)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="steer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="reply">
        <textarea
          ref={field}
          className="field"
          rows={1}
          value={draft}
          aria-label={text("ticket.reply")}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((all) => ({ ...all, [ticket]: value }));
          }}
          onKeyDown={keyDown}
        />
        <button className={`btn btn-primary${sending ? " is-busy" : ""}`} type="submit" aria-label={text("composer.send")} disabled={draft.trim() === "" || sending}>
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}

export function TicketView({ detail, known, actions, origin, backHref, back, now }: TicketViewProps) {
  const entries = useMemo(() => (detail === null ? [] : timeline(detail)), [detail]);
  const following = useRef(false);
  const list = useRef<HTMLOListElement>(null);
  const ticket = detail?.ticket ?? null;
  const id = detail?.id ?? null;

  useLayoutEffect(() => {
    following.current = false;
    const main = document.getElementById("main");
    if (main === null) {
      return;
    }
    main.scrollTop = 0;
    const scrolled = () => {
      following.current = main.scrollHeight - main.clientHeight > nearBottom && main.scrollHeight - main.scrollTop - main.clientHeight < nearBottom;
    };
    main.addEventListener("scroll", scrolled, { passive: true });
    return () => main.removeEventListener("scroll", scrolled);
  }, [id]);

  useLayoutEffect(() => {
    const main = document.getElementById("main");
    if (main !== null && following.current) {
      main.scrollTop = main.scrollHeight;
    }
  }, [entries]);

  useEffect(() => {
    const element = list.current;
    const main = document.getElementById("main");
    if (element === null || main === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (following.current) {
        main.scrollTop = main.scrollHeight;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ticket !== null]);

  const send = useCallback(
    async (message: string) => {
      if (ticket === null) {
        return false;
      }
      following.current = true;
      return actions.message(ticket.id, message);
    },
    [actions, ticket],
  );

  const backLink = (
    <a className="back" href={backHref} onClick={(event) => followLink(event, back)}>
      <Icon name="back" />
      {origin === "history" ? text("navigation.history") : text("navigation.workbench")}
    </a>
  );

  if (detail === null || ticket === null) {
    return (
      <div className="page">
        <div className="dhead">{backLink}</div>
        {detail?.missing === true ? (
          <div className="empty">
            <strong>{text("ticket.missing")}</strong>
          </div>
        ) : null}
      </div>
    );
  }

  const offers = panelOffers(ticket);

  return (
    <div className="page">
      <div className="dhead">
        {backLink}
        <div className="meta-row">
          <PhaseStatus phase={ticketPhase(ticket)} />
          <span className="chip chip--mono">{text("ticket.number", { ticket: ticket.id })}</span>
          {ticket.repository === null ? null : (
            <span className="chip chip--mono">
              <Icon name="repo" />
              {ticket.repository}
            </span>
          )}
          <span className="chip">{text(`ticket.kind.${ticket.kind}`)}</span>
        </div>
        <h2>{chineseOf(ticket.title)}</h2>
      </div>
      <div className="detail">
        <div className="detail-main">
          <ol className="timeline" ref={list} aria-label={text("ticket.timeline")}>
            {entries.map((entry) => {
              switch (entry.kind) {
                case "filed":
                  return <FiledEntry key={entry.key} ticket={ticket} now={now} />;
                case "move":
                  return <MoveEntry key={entry.key} entry={entry} now={now} />;
                case "attempt":
                  return <AttemptEntry key={entry.key} entry={entry} ticket={ticket} now={now} />;
              }
            })}
          </ol>
          {offers.reply ? <Reply ticket={ticket.id} send={send} /> : null}
        </div>
        <Panel ticket={ticket} known={known} actions={actions} now={now} />
      </div>
    </div>
  );
}
