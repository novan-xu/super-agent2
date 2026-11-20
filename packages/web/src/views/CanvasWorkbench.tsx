import { text } from "@super-agent2/catalog";
import { chineseOf, type Conversation, type StartCard as StartData, type Ticket, ticketProject } from "@super-agent2/protocol";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { canvasOf, layoutChains, type CanvasChain } from "../live/canvas.js";
import { canStartCard } from "../live/choice.js";
import { clampPanelWidth, defaultPanelWidth, loadPanelWidth, minPanelWidth, panelMaximum, savePanelWidth } from "../live/panel-width.js";
import { offersSwitch, type PushPhase } from "../live/push.js";
import { kindKey, phaseLooks, ticketPhase, whereOf } from "../live/phase.js";
import { type WaitingState, useOf } from "../live/waiting.js";
import { Icon } from "../parts/icons.js";
import { HoldCard } from "./HoldCard.js";
import { StartCard } from "./StartCard.js";
import { StuckCard } from "./StuckCard.js";
import { engineName, TicketCodeLabel } from "./TicketParts.js";
import type { CardActions } from "./WorkbenchView.js";

export interface CanvasWorkbenchProps {
  readonly tickets: readonly Ticket[];
  readonly topics: readonly Conversation[];
  readonly pinnedRepositories: readonly { readonly repository: string; readonly alias?: string | null }[];
  readonly waiting: WaitingState;
  readonly actions: CardActions;
  readonly repository: string | null | undefined;
  readonly selectRepository: (repository: string | null | undefined) => void;
  readonly selected: number | null;
  readonly selectTicket: (ticket: number | null) => void;
  readonly ticketHref: (ticket: number) => string;
  readonly panel: ReactNode;
  readonly focus: string | null;
  readonly focused: () => void;
  readonly push: PushPhase;
  readonly togglePush: () => void;
  readonly rearrange: () => Promise<boolean>;
  readonly rearranging: boolean;
}

function belongs(repository: string | null | undefined, value: string | null): boolean {
  return repository === undefined || (repository?.toLowerCase() ?? null) === (value?.toLowerCase() ?? null);
}

export function CanvasWorkbench(props: CanvasWorkbenchProps) {
  const { tickets, topics, waiting, repository, actions } = props;
  const [popup, setPopup] = useState<number | null>(null);
  const [pane, setPane] = useState<"canvas" | "panel">("canvas");
  const layout = useRef<HTMLDivElement>(null);
  const railElement = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preferredWidth, setPreferredWidth] = useState(loadPanelWidth);
  const [maximum, setMaximum] = useState(defaultPanelWidth);
  const panelWidth = clampPanelWidth(preferredWidth, maximum);
  useLayoutEffect(() => {
    const element = layout.current;
    const rail = railElement.current;
    if (element === null || rail === null) return;
    const measure = () => {
      if (window.matchMedia("(max-width: 767px)").matches) return;
      setMaximum(panelMaximum(element.clientWidth, rail.getBoundingClientRect().width));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    observer?.observe(rail);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const changeWidth = (width: number) => {
    const next = clampPanelWidth(width, maximum);
    setPreferredWidth(next);
    savePanelWidth(next);
  };
  const dialog = useRef<HTMLDialogElement>(null);
  const source = useRef<HTMLElement | null>(null);
  const starts = useMemo(() => new Map(waiting.cards.flatMap((card) => card.kind === "start" ? [[card.ticket.id, card] as const] : [])), [waiting.cards]);
  const stuck = useMemo(() => new Map(waiting.cards.flatMap((card) => card.kind === "stuck" ? [[card.ticket.id, card] as const] : [])), [waiting.cards]);
  const all = useMemo(() => {
    const map = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    for (const card of waiting.cards) if (card.kind !== "hold") map.set(card.ticket.id, card.ticket);
    return [...map.values()];
  }, [tickets, waiting.cards]);
  const repositories = useMemo(() => [...props.pinnedRepositories].sort((a, b) => (a.alias ?? a.repository).localeCompare(b.alias ?? b.repository) || a.repository.localeCompare(b.repository)), [props.pinnedRepositories]);
  const canvas = useMemo(() => canvasOf(all, repository, new Set(stuck.keys()), new Map([...starts].map(([id, card]) => [id, card.before.map((before) => before.id)]))), [all, repository, stuck, starts]);
  useEffect(() => {
    if (props.focus === null || !waiting.known) return;
    const scopeFor = (name: string | null | undefined) =>
      name == null ? name : repositories.find((pinned) => pinned.repository.toLowerCase() === name.toLowerCase())?.repository;
    const card = waiting.cards.find((entry) => entry.key === props.focus);
    if (card?.kind === "hold") {
      props.selectRepository(undefined);
      window.setTimeout(() => document.getElementById(`card-${card.key}`)?.scrollIntoView({ block: "center" }), 0);
    } else if (card !== undefined) {
      props.selectRepository(scopeFor(ticketProject(card.ticket)));
      if (card.kind === "start") setPopup(card.ticket.id);
      else { props.selectTicket(card.ticket.id); setPane("panel"); }
    } else if (/^start:[1-9][0-9]*$/.test(props.focus)) {
      const id = Number(props.focus.slice(6));
      const ticket = tickets.find((entry) => entry.id === id);
      props.selectRepository(scopeFor(ticket === undefined ? undefined : ticketProject(ticket)));
      props.selectTicket(id);
      setPane("panel");
    }
    const timer = window.setTimeout(props.focused, 1000);
    return () => window.clearTimeout(timer);
  }, [props.focus, props.focused, props.selectRepository, props.selectTicket, repositories, tickets, waiting]);
  const startable = waiting.cards.filter((card): card is StartData => card.kind === "start" && belongs(repository, card.ticket.repository) && canStartCard(card));
  const holds = waiting.cards.filter((card) => card.kind === "hold");
  const activeStart = popup === null ? undefined : starts.get(popup);
  const close = () => { dialog.current?.close(); setPopup(null); source.current?.focus(); };
  useEffect(() => {
    if (popup !== null && !dialog.current?.open) dialog.current?.showModal();
    if (popup !== null && activeStart === undefined) close();
  }, [popup, activeStart]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && popup === null && props.selected !== null) props.selectTicket(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [popup, props.selected, props.selectTicket]);
  const chooseRepository = (value: string | null | undefined) => { props.selectRepository(value); props.selectTicket(null); setPane("canvas"); };
  const select = (id: number) => { props.selectTicket(id); setPane("panel"); };
  const openStart = (card: StartData, element: HTMLElement) => { source.current = element; setPopup(card.ticket.id); };
  const rail = (value: string | null | undefined, label: string) => {
    const matching = all.filter((ticket) => belongs(value, ticketProject(ticket)));
    const waitingHere = matching.some((ticket) => stuck.has(ticket.id) || starts.has(ticket.id)) || ((value === undefined || value === null) && holds.length > 0);
    const running = matching.some((ticket) => ticket.state !== "pending") || topics.some((topic) => belongs(value, topic.repository) && topic.state === "working");
    return <button key={value ?? (value === null ? "daily" : "all")} type="button" className="wb-repo" title={typeof value === "string" ? value : undefined} aria-pressed={repository === value} onClick={() => chooseRepository(value)}>
      <span className={`dot dot--${waitingHere ? "warn" : running ? "ok" : "mute"}`} role="img" aria-label={text(waitingHere ? "workbench.mark.waits" : running ? "workbench.mark.runs" : "workbench.mark.idle")} /><span className="od-truncate">{label}</span><span className="count">{matching.length}</span>
    </button>;
  };
  return <div ref={layout} className={`wb-layout${dragging ? " wb-layout--dragging" : ""}`} style={{ "--wb-panel-width": `${panelWidth}px` } as CSSProperties}>
    <aside ref={railElement} className="wb-repos" aria-label={text("conversation.repository")}>
      {rail(undefined, text("workbench.all"))}{repositories.map((row) => rail(row.repository, row.alias ?? row.repository))}{rail(null, text("conversation.daily"))}
    </aside>
    <div className="wb-mobile-tabs"><button type="button" aria-pressed={pane === "canvas"} onClick={() => setPane("canvas")}>{text("navigation.workbench")}</button><button type="button" aria-pressed={pane === "panel"} onClick={() => setPane("panel")}>{text("navigation.conversation")}</button></div>
    <main className={`wb-canvas ${pane === "panel" ? "wb-mobile-hidden" : ""}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, a, input, textarea, select, .wcard")) props.selectTicket(null); }}>
      <div className="wb-toolbar">{startable.length === 0 ? null : <button type="button" className="btn btn-primary" disabled={startable.some((card) => useOf(waiting, card.key).step !== "idle")} onClick={() => actions.start(startable.map((card) => card.key))}><Icon name="check" />{text("chains.startAll")} {startable.length}</button>}<button type="button" className="btn" title={text("workbench.rearrangeTip")} disabled={props.rearranging} onClick={() => void props.rearrange().then((opened) => { if (opened) setPane("panel"); })}>{text("workbench.rearrange")}</button>
      {offersSwitch(props.push) ? <label className="switch-label wb-push"><button className="switch" type="button" role="switch" aria-label={text("push.label")} aria-checked={props.push === "on" || props.push === "working"} disabled={props.push === "blocked" || props.push === "working"} onClick={props.togglePush} />{text("push.label")}</label> : props.push === "install" ? <p className="push-note">{text("push.install")}</p> : null}</div>
      {props.push === "blocked" ? <p className="push-note">{text("push.blocked")}</p> : null}
      {holds.length > 0 && (repository === undefined || repository === null) ? <section className="wb-section"><h2>{text("waiting.title")}</h2><div className="wb-holds">{holds.map((card) => <HoldCard key={card.key} card={card} use={useOf(waiting, card.key)} focused={props.focus === card.key} answer={(verdict) => actions.answer(card.key, verdict)} />)}</div></section> : null}
      {(["waits", "running", "ready", "later"] as const).map((section) => canvas[section].length === 0 ? null : <section key={section} className="wb-section">
        <h2>{text(`workbench.section.${section}`)}</h2>
        <CanvasGrid chains={repository === null ? canvas[section].flatMap((chain) => chain.map((node) => [node])) : canvas[section]} daily={repository === null} starts={starts} stuck={stuck} waiting={waiting} actions={actions} selected={props.selected} select={select} openStart={openStart} ticketHref={props.ticketHref} />
      </section>)}
    </main>
    <div className="wb-splitter" role="separator" aria-label={text("workbench.resizePanel")} aria-orientation="vertical"
      aria-valuemin={minPanelWidth} aria-valuemax={maximum} aria-valuenow={panelWidth} tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, width: panelWidth };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer === event.pointerId) changeWidth(drag.current.width + drag.current.x - event.clientX);
      }}
      onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setDragging(false); } }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={() => changeWidth(defaultPanelWidth)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        changeWidth(panelWidth + (event.key === "ArrowLeft" ? 24 : -24));
      }}
    />
    <aside className={`wb-panel ${pane === "canvas" ? "wb-mobile-hidden" : ""}`}>{props.panel}</aside>
    <dialog ref={dialog} className="dlg wb-dialog" aria-label={text("chains.start")} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="dlg-in"><button className="icon-btn wb-close" type="button" aria-label={text("conversation.close")} onClick={close}><Icon name="x" /></button>
        {activeStart === undefined ? null : <><h2>{chineseOf(activeStart.ticket.title)}</h2><p>{chineseOf(activeStart.ticket.summary)}</p><StartCard card={activeStart} use={useOf(waiting, activeStart.key)} focused={false} start={() => actions.start([activeStart.key])} choose={(change) => actions.choose(activeStart.key, change)} /></>}
      </div>
    </dialog>
  </div>;
}

function CanvasGrid({ chains, daily, starts, stuck, waiting, actions, selected, select, openStart, ticketHref }: {
  readonly chains: readonly CanvasChain[]; readonly daily: boolean; readonly starts: ReadonlyMap<number, StartData>; readonly stuck: ReadonlyMap<number, Extract<WaitingState["cards"][number], { kind: "stuck" }>>;
  readonly waiting: WaitingState; readonly actions: CardActions; readonly selected: number | null; readonly select: (id: number) => void;
  readonly openStart: (card: StartData, element: HTMLElement) => void; readonly ticketHref: (id: number) => string;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [paths, setPaths] = useState<string[]>([]);
  const columns = daily ? 1 : Math.max(1, Math.floor((width + 20) / 240));
  const related = new Map(chains.flat().map((node) => [node.ticket.id, node.ticket]));
  const cells = useMemo(() => layoutChains(chains, columns), [chains, columns]);
  useLayoutEffect(() => {
    const element = grid.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setWidth(window.matchMedia("(max-width: 767px)").matches ? 0 : element.clientWidth);
      const bounds = element.getBoundingClientRect();
      const path: string[] = [];
      for (const cell of cells) for (const id of daily ? [] : cell.node.after) {
        const from = element.querySelector<HTMLElement>(`[data-ticket="${id}"] .wb-card`);
        const to = element.querySelector<HTMLElement>(`[data-ticket="${cell.node.ticket.id}"] .wb-card`);
        if (from === null || to === null) continue;
        const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
        const same = Math.abs(a.top - b.top) < 5;
        if (same && Math.abs(a.left - b.left) <= Math.max(a.width, b.width) + 24) {
          const forward = b.left > a.left;
          const x1 = (forward ? a.right : a.left) - bounds.left, x2 = (forward ? b.left : b.right) - bounds.left;
          path.push(`M ${x1} ${a.top + a.height / 2 - bounds.top} L ${x2} ${b.top + b.height / 2 - bounds.top}`);
        } else if (same) {
          const x1 = a.left + a.width / 2 - bounds.left, x2 = b.left + b.width / 2 - bounds.left;
          const y1 = a.bottom - bounds.top, y2 = b.bottom - bounds.top, mid = Math.max(y1, y2) + 14;
          path.push(`M ${x1} ${y1} L ${x1} ${mid} L ${x2} ${mid} L ${x2} ${y2}`);
        } else {
          const x1 = a.left + a.width / 2 - bounds.left, x2 = b.left + b.width / 2 - bounds.left;
          const y1 = a.bottom - bounds.top, y2 = b.top - bounds.top, mid = (y1 + y2) / 2;
          path.push(`M ${x1} ${y1} L ${x1} ${mid} L ${x2} ${mid} L ${x2} ${y2}`);
        }
      }
      setPaths(path);
    });
    observer.observe(element);
    element.querySelectorAll(".wb-card").forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [cells, daily]);
  return <div ref={grid} className="wb-grid" style={{ "--wb-columns": columns } as CSSProperties}>
    {cells.map(({ node, column, line }) => {
      const ticket = node.ticket, start = starts.get(ticket.id), stopped = stuck.get(ticket.id), phase = ticketPhase(ticket);
      const where = whereOf(ticket);
      const phaseIndex = ticket.state === "waiting" ? 0 : ticket.state === "verifying" ? (ticket.verification?.waiting === "finishing" || ticket.verification?.waiting === "mergeable" ? 3 : 2) : 1;
      const waits = ticket.waits.filter((wait) => !wait.waived && (node.after.includes(wait.ticket) || node.missing.includes(wait.ticket)));
      const codeOf = (id: number) => related.get(id)?.code ?? waits.find((wait) => wait.ticket === id)?.reference?.split("-")[0] ?? "?";
      return <div className="wb-slot" key={ticket.id} data-ticket={ticket.id} style={{ gridColumn: column + 1, gridRow: line + 1 }}>
        {stopped === undefined || node.reference ? <button type="button" className={`wb-card${start === undefined ? "" : " wb-card--pending"}${node.reference ? " wb-card--reference" : ""}`} aria-label={`${chineseOf(ticket.title)} ${ticket.code}`} aria-pressed={selected === ticket.id} onClick={(event) => start !== undefined && !node.reference ? openStart(start, event.currentTarget) : select(ticket.id)}>
          <span className="wb-card-title"><span className={`dot dot--${phaseLooks[phase].tone}`} /><TicketCodeLabel code={ticket.code} /><span>{chineseOf(ticket.title)}</span></span>
          {start === undefined ? <span className="wb-phases" aria-hidden="true">{[0, 1, 2, 3].map((step) => <i key={step} className={step <= phaseIndex ? "is-active" : ""} />)}</span> : null}
          <span className="wb-card-meta">{[text(kindKey(ticket)), start === undefined ? text(`workbench.phase.${phaseIndex}`) : null, ticket.state === "waiting" ? text("workbench.queued") : text(`ticket.phase.${phase}`), where?.machine ?? ticket.machine, engineName(where?.engine ?? ticket.engine)].filter(Boolean).join(" · ")}{ticket.scheduleRun === undefined ? null : <span className="chip schedule-chip">{text("schedule.ticket")}</span>}</span>
        </button> : <div className="wb-card"><StuckCard card={stopped} use={useOf(waiting, stopped.key)} focused={false} href={ticketHref(ticket.id)} open={() => select(ticket.id)} answer={(answer, words) => actions.answerStuck(stopped.key, answer, words)} /></div>}
        {node.after.length === 0 ? null : <span className="sr-only">{text("workbench.follows", { tickets: node.after.map((id) => `${codeOf(id)} ${(related.get(id)?.title.zh ?? "")}`.trim()).join("、") })}</span>}
        {ticket.state !== "waiting" || waits.length === 0 ? null : <p className="wb-after">{waits.map((wait) => text(wait.deployment ? "workbench.waitDeployment" : related.get(wait.ticket)?.form === "task" ? "workbench.waitTicket" : "workbench.waitMerge", { ticket: codeOf(wait.ticket) })).join("、")}</p>}
        {node.missing.length === 0 ? null : <p className="wb-after">{text("workbench.follows", { tickets: node.missing.map(codeOf).join("、") })}</p>}
      </div>;
    })}
    <svg className="wb-links" aria-hidden="true"><defs><marker id="wb-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M 0 0 L 6 3 L 0 6 z" /></marker></defs>{paths.map((path, index) => <path key={index} d={path} markerEnd="url(#wb-arrow)" />)}</svg>
  </div>;
}
