import { text } from "@super-agent2/catalog";
import { chineseOf, type StartCard as StartData, type Ticket, ticketProject } from "@super-agent2/protocol";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { canvasOf, type CanvasChain } from "../live/canvas.js";
import { graphOf, type GraphRow } from "../live/canvas-graph.js";
import { canStartCard } from "../live/choice.js";
import { clampPanelHeight, loadPanelHeight, minPanelHeight, panelHeightMaximum, savePanelHeight } from "../live/panel-height.js";
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
  readonly pinnedRepositories: readonly { readonly repository: string; readonly alias?: string | null }[];
  readonly waiting: WaitingState;
  readonly actions: CardActions;
  readonly repository: string | null | undefined;
  readonly selectRepository: (repository: string | null | undefined) => void;
  readonly selected: number | null;
  readonly selectTicket: (ticket: number | null) => void;
  readonly ticketHref: (ticket: number) => string;
  readonly panel: ReactNode;
  readonly pane: "canvas" | "panel";
  readonly setPane: (pane: "canvas" | "panel") => void;
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
  const { tickets, waiting, repository, actions, pane, setPane } = props;
  const [popup, setPopup] = useState<number | null>(null);
  const layout = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; position: number; size: number; portrait: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preferredWidth, setPreferredWidth] = useState(loadPanelWidth);
  const [maximum, setMaximum] = useState(defaultPanelWidth);
  const [portrait, setPortrait] = useState(false);
  const [preferredHeight, setPreferredHeight] = useState(loadPanelHeight);
  const [layoutHeight, setLayoutHeight] = useState(0);
  const heightMaximum = panelHeightMaximum(layoutHeight);
  const panelHeight = clampPanelHeight(preferredHeight ?? (layoutHeight - 8) / 2, heightMaximum);
  const panelWidth = clampPanelWidth(preferredWidth, maximum);
  useLayoutEffect(() => {
    const element = layout.current;
    if (element === null) return;
    const query = window.matchMedia("(orientation: portrait) and (min-width: 768px)");
    const measure = () => {
      setPortrait(query.matches);
      setLayoutHeight(element.clientHeight);
      if (!window.matchMedia("(max-width: 767px)").matches) setMaximum(panelMaximum(element.clientWidth));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    query.addEventListener?.("change", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); query.removeEventListener?.("change", measure); };
  }, []);
  const changeWidth = (width: number) => {
    const next = clampPanelWidth(width, maximum);
    setPreferredWidth(next);
    savePanelWidth(next);
  };
  const changeHeight = (height: number) => {
    const next = clampPanelHeight(height, heightMaximum);
    setPreferredHeight(next);
    savePanelHeight(next);
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
  const repositories = props.pinnedRepositories;
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
  const select = (id: number) => { props.selectTicket(id); setPane("panel"); };
  const openStart = (card: StartData, element: HTMLElement) => { source.current = element; setPopup(card.ticket.id); };
  return <div ref={layout} className={`wb-layout${portrait ? " wb-layout--portrait" : ""}${dragging ? " wb-layout--dragging" : ""}`} style={{ "--wb-panel-width": `${panelWidth}px`, "--wb-panel-height": `${panelHeight}px` } as CSSProperties}>
    <div className="wb-mobile-tabs"><button type="button" aria-pressed={pane === "canvas"} onClick={() => setPane("canvas")}>{text("navigation.workbench")}</button><button type="button" aria-pressed={pane === "panel"} onClick={() => setPane("panel")}>{text("navigation.conversation")}</button></div>
    <main className={`wb-canvas ${pane === "panel" ? "wb-mobile-hidden" : ""}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, a, input, textarea, select, .wcard")) props.selectTicket(null); }}>
      <div className="wb-toolbar">{startable.length === 0 ? null : <button type="button" className="btn btn-primary" disabled={startable.some((card) => useOf(waiting, card.key).step !== "idle")} onClick={() => actions.start(startable.map((card) => card.key))}><Icon name="check" />{text("chains.startAll")} {startable.length}</button>}<button type="button" className="btn" title={text("workbench.rearrangeTip")} disabled={props.rearranging} onClick={() => void props.rearrange().then((opened) => { if (opened) setPane("panel"); })}>{text("workbench.rearrange")}</button>
      {offersSwitch(props.push) ? <label className="switch-label wb-push"><button className="switch" type="button" role="switch" aria-label={text("push.label")} aria-checked={props.push === "on" || props.push === "working"} disabled={props.push === "blocked" || props.push === "working"} onClick={props.togglePush} />{text("push.label")}</label> : props.push === "install" ? <p className="push-note">{text("push.install")}</p> : null}</div>
      {props.push === "blocked" ? <p className="push-note">{text("push.blocked")}</p> : null}
      {holds.length > 0 && (repository === undefined || repository === null) ? <section className="wb-section"><h2>{text("waiting.title")}</h2><div className="wb-holds">{holds.map((card) => <HoldCard key={card.key} card={card} use={useOf(waiting, card.key)} focused={props.focus === card.key} answer={(verdict) => actions.answer(card.key, verdict)} />)}</div></section> : null}
      {(["waits", "running", "ready", "later"] as const).map((section) => canvas[section].length === 0 ? null : <section key={section} className="wb-section">
        <h2>{text(`workbench.section.${section}`)}</h2>
        <CanvasGrid chains={repository === null ? canvas[section].flatMap((chain) => chain.map((node) => [node])) : canvas[section]} starts={starts} stuck={stuck} waiting={waiting} actions={actions} selected={props.selected} select={select} openStart={openStart} ticketHref={props.ticketHref} />
      </section>)}
    </main>
    <div className="wb-splitter" role="separator" aria-label={text("workbench.resizePanel")} aria-orientation={portrait ? "horizontal" : "vertical"}
      aria-valuemin={portrait ? minPanelHeight : minPanelWidth} aria-valuemax={portrait ? heightMaximum : maximum} aria-valuenow={portrait ? panelHeight : panelWidth} tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, position: portrait ? event.clientY : event.clientX, size: portrait ? panelHeight : panelWidth, portrait };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer === event.pointerId && drag.current.portrait === portrait) {
          const size = drag.current.size + (portrait ? drag.current.position - event.clientY : event.clientX - drag.current.position);
          if (portrait) changeHeight(size); else changeWidth(size);
        }
      }}
      onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setDragging(false); } }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={() => { if (portrait) { setPreferredHeight(null); savePanelHeight(null); } else changeWidth(defaultPanelWidth); }}
      onKeyDown={(event) => {
        const increase = portrait ? "ArrowUp" : "ArrowRight";
        const decrease = portrait ? "ArrowDown" : "ArrowLeft";
        if (event.key !== increase && event.key !== decrease) return;
        event.preventDefault();
        const delta = event.key === increase ? 24 : -24;
        if (portrait) changeHeight(panelHeight + delta); else changeWidth(panelWidth + delta);
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

function CanvasGrid({ chains, starts, stuck, waiting, actions, selected, select, openStart, ticketHref }: {
  readonly chains: readonly CanvasChain[]; readonly starts: ReadonlyMap<number, StartData>; readonly stuck: ReadonlyMap<number, Extract<WaitingState["cards"][number], { kind: "stuck" }>>;
  readonly waiting: WaitingState; readonly actions: CardActions; readonly selected: number | null; readonly select: (id: number) => void;
  readonly openStart: (card: StartData, element: HTMLElement) => void; readonly ticketHref: (id: number) => string;
}) {
  const related = new Map(chains.flat().map((node) => [node.ticket.id, node.ticket]));
  return <div className="wb-grid">
    {chains.map(graphOf).map(({ lanes, rows }) => <div className={`wb-chain${rows.length > 1 ? " wb-chain--linked" : ""}`} key={rows[0]!.node.ticket.id} style={rows.length > 1 ? { "--wb-gutter-ideal": `${gutterWidth(lanes)}px` } as CSSProperties : undefined}>
    {rows.map((row) => {
      const { node } = row;
      const ticket = node.ticket, start = starts.get(ticket.id), stopped = stuck.get(ticket.id), phase = ticketPhase(ticket);
      const where = whereOf(ticket);
      const phaseIndex = ticket.state === "waiting" ? 0 : ticket.state === "verifying" ? (ticket.verification?.waiting === "finishing" || ticket.verification?.waiting === "mergeable" ? 3 : 2) : 1;
      const waits = ticket.waits.filter((wait) => !wait.waived && (node.after.includes(wait.ticket) || node.missing.includes(wait.ticket)));
      const codeOf = (id: number) => (related.get(id)?.code ?? waits.find((wait) => wait.ticket === id)?.reference?.split("-")[0] ?? "?").toUpperCase();
      return <div className="wb-slot" key={ticket.id} data-ticket={ticket.id}>
        {rows.length > 1 ? <GraphGutter row={row} lanes={lanes} tone={phaseLooks[phase].tone} /> : null}
        {stopped === undefined || node.reference ? <button type="button" className={`wb-card${start === undefined ? "" : " wb-card--pending"}${node.reference ? " wb-card--reference" : ""}`} aria-label={`${chineseOf(ticket.title)} ${ticket.code.toUpperCase()}`} aria-pressed={selected === ticket.id} onClick={(event) => start !== undefined && !node.reference ? openStart(start, event.currentTarget) : select(ticket.id)}>
          <span className="wb-card-title"><span className={`dot dot--${phaseLooks[phase].tone}`} /><TicketCodeLabel code={ticket.code} /><span>{chineseOf(ticket.title)}</span></span>
          {start === undefined ? <span className="wb-phases" aria-hidden="true">{[0, 1, 2, 3].map((step) => <i key={step} className={step <= phaseIndex ? "is-active" : ""} />)}</span> : null}
          <span className="wb-card-meta">{[text(kindKey(ticket)), start === undefined ? text(`workbench.phase.${phaseIndex}`) : null, phase === "waiting" ? text("workbench.queued") : text(`ticket.phase.${phase}`), where?.machine ?? ticket.machine, engineName(where?.engine ?? ticket.engine)].filter(Boolean).join(" · ")}{ticket.scheduleRun === undefined ? null : <span className="chip schedule-chip">{text("schedule.ticket")}</span>}</span>
        </button> : <div className="wb-card"><StuckCard card={stopped} use={useOf(waiting, stopped.key)} focused={false} href={ticketHref(ticket.id)} open={() => select(ticket.id)} answer={(answer, words) => actions.answerStuck(stopped.key, answer, words)} /></div>}
        {node.after.length === 0 ? null : <span className="sr-only">{text("workbench.follows", { tickets: node.after.map((id) => `${codeOf(id)} ${(related.get(id)?.title.zh ?? "")}`.trim()).join("、") })}</span>}
        {ticket.state !== "waiting" || waits.length === 0 ? null : <p className="wb-after">{waits.map((wait) => text(wait.deployment ? "workbench.waitDeployment" : related.get(wait.ticket)?.form === "task" ? "workbench.waitTicket" : "workbench.waitMerge", { ticket: codeOf(wait.ticket) })).join("、")}</p>}
        {ticket.startBlock?.pinned ? <p className="wb-after">{ticket.startBlock.zh}</p> : null}
        {node.missing.length === 0 ? null : <p className="wb-after">{text("workbench.follows", { tickets: node.missing.map(codeOf).join("、") })}</p>}
      </div>;
    })}</div>)}
  </div>;
}

const laneX = (lane: number) => 7 + 14 * lane;
const gutterWidth = (lanes: number) => 10 + 14 * lanes;

function GraphGutter({ row, lanes, tone }: { readonly row: GraphRow; readonly lanes: number; readonly tone: string }) {
  const width = gutterWidth(lanes);
  const dot = laneX(row.lane);
  const percent = (lane: number) => `${laneX(lane) / width * 100}%`;
  const straight: string[] = [];
  const turns: string[] = [];
  for (const edge of row.passing) straight.push(`M ${laneX(edge.lane)} 0 V 36`);
  for (const edge of row.incoming) {
    const x = laneX(edge.lane);
    if (x === dot) straight.push(`M ${x} 0 V 18`);
    else turns.push(`M ${x} 0 V 4 Q ${x} 18 ${dot} 18`);
  }
  for (const edge of row.outgoing) {
    const x = laneX(edge.lane);
    if (x === dot) straight.push(`M ${x} 18 V 36`);
    else turns.push(`M ${dot} 18 Q ${x} 18 ${x} 32 V 36`);
  }
  return <div className="wb-gutter" aria-hidden="true">
    <svg className="wb-lanes">
      <svg width="100%" height="36" viewBox={`0 0 ${width} 36`} preserveAspectRatio="none">
        <path d={straight.join(" ")} vectorEffect="non-scaling-stroke" />
        {turns.length === 0 ? null : <>
          <path className="wb-lane-clearance" d={turns.join(" ")} vectorEffect="non-scaling-stroke" />
          <path d={turns.join(" ")} vectorEffect="non-scaling-stroke" />
        </>}
      </svg>
      {[...row.passing, ...row.outgoing].map(({ from, to, lane }) => <line key={`${from}-${to}`} x1={percent(lane)} x2={percent(lane)} y1="36" y2="100%" />)}
    </svg>
    <span className={`wb-rail-dot dot dot--${tone}`} style={{ left: percent(row.lane) }} />
  </div>;
}
