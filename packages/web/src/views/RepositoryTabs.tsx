import { text } from "@super-agent2/catalog";
import { type Conversation, type RepositoryAccount, type Ticket, ticketProject } from "@super-agent2/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WaitingState } from "../live/waiting.js";
import { Icon } from "../parts/icons.js";

interface RepositoryTabsProps {
  readonly repositories: readonly RepositoryAccount[];
  readonly tickets: readonly Ticket[];
  readonly topics: readonly Conversation[];
  readonly waiting: WaitingState;
  readonly selected: string | null | undefined;
  readonly select: (repository: string | null | undefined) => void;
  readonly pin: (repository: string, pinned: boolean) => Promise<boolean>;
  readonly order: (repositories: readonly string[]) => Promise<boolean>;
}

function belongs(scope: string | null | undefined, value: string | null): boolean {
  return scope === undefined || (scope?.toLowerCase() ?? null) === (value?.toLowerCase() ?? null);
}

export function RepositoryTabs({ repositories, tickets, topics, waiting, selected, select, pin, order }: RepositoryTabsProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const drag = useRef<{ pointer: number; name: string; start: number; index: number; width: number; active: boolean; timer?: number; element: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ names: string[]; name: string; offset: number } | null>(null);
  useEffect(() => {
    const preventScroll = (event: TouchEvent) => { if (drag.current?.active) event.preventDefault(); };
    document.addEventListener("touchmove", preventScroll, { passive: false });
    return () => { document.removeEventListener("touchmove", preventScroll); if (drag.current !== null) window.clearTimeout(drag.current.timer); };
  }, []);
  const all = useMemo(() => {
    const map = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    for (const card of waiting.cards) if (card.kind !== "hold") map.set(card.ticket.id, card.ticket);
    return [...map.values()];
  }, [tickets, waiting.cards]);
  const pinned = repositories.filter((row) => row.pinned).sort((a, b) =>
    (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0) || (a.alias ?? a.repository).localeCompare(b.alias ?? b.repository) || a.repository.localeCompare(b.repository));
  const names = pinned.map((row) => row.repository);
  const displayed = preview === null ? pinned : preview.names.map((name) => pinned.find((row) => row.repository === name)).filter((row): row is RepositoryAccount => row !== undefined);
  const move = (items: readonly string[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    return next;
  };
  const saveOrder = async (next: string[]) => {
    if (busy || next.every((name, index) => name === names[index])) return;
    setBusy(true);
    try { await order(next); } finally { setBusy(false); }
  };
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const element of strip.current?.querySelectorAll<HTMLElement>("[data-repository]") ?? []) {
      const name = element.dataset.repository!;
      const left = element.getBoundingClientRect().left;
      next.set(name, left);
      const previous = positions.current.get(name);
      if (preview !== null && name !== preview.name && previous !== undefined && previous !== left && typeof element.animate === "function") {
        element.animate([{ transform: `translateX(${previous - left}px)` }, { transform: "translateX(0)" }], { duration: 120, easing: "ease-out" });
      }
    }
    positions.current = next;
  });
  const available = repositories.filter((row) => !row.pinned && `${row.alias ?? ""} ${row.repository}`.toLowerCase().includes(filter.toLowerCase()));
  const change = async (name: string, next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await pin(name, next)) {
        if (next) { select(name); setOpen(false); setFilter(""); }
        else if (selected?.toLowerCase() === name.toLowerCase()) select(undefined);
      }
    } finally { setBusy(false); }
  };
  const tab = (value: string | null | undefined, label: string) => {
    const matching = all.filter((ticket) => belongs(value, ticketProject(ticket)));
    const waits = matching.some((ticket) => waiting.cards.some((card) => card.kind !== "hold" && card.ticket.id === ticket.id)) || (value == null && waiting.cards.some((card) => card.kind === "hold"));
    const running = matching.some((ticket) => ticket.state !== "pending") || topics.some((topic) => belongs(value, topic.repository) && topic.state === "working");
    const active = selected === value;
    return <div data-repository={typeof value === "string" ? value : undefined} key={value === undefined ? "all" : value === null ? "daily" : value} className={`wb-tab${active ? " is-active" : ""}${preview !== null && preview.name === value ? " is-dragging" : ""}`}
      style={preview !== null && preview.name === value ? { transform: `translateX(${preview.offset}px)` } : undefined}>
      <button type="button" className="wb-tab-select" title={typeof value === "string" ? value : label} aria-label={label} aria-pressed={active} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } select(value); }}
        onKeyDown={(event) => {
          if (typeof value !== "string" || !event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          const index = names.indexOf(value);
          const target = Math.max(0, Math.min(names.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
          void saveOrder(move(names, index, target));
        }}
        onPointerDown={(event) => {
          if (typeof value !== "string" || busy || event.button !== 0) return;
          const element = event.currentTarget;
          const state = { pointer: event.pointerId, name: value, start: event.clientX, index: names.indexOf(value), width: element.parentElement?.getBoundingClientRect().width || 160, active: false, element, timer: undefined as number | undefined };
          drag.current = state;
          if (event.pointerType === "touch") state.timer = window.setTimeout(() => { if (drag.current === state) { state.active = true; element.setPointerCapture(state.pointer); setPreview({ names, name: value, offset: 0 }); } }, 500);
          else element.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (state === null || state.pointer !== event.pointerId) return;
          const delta = event.clientX - state.start;
          if (!state.active && event.pointerType === "touch" && Math.abs(delta) > 6) { window.clearTimeout(state.timer); drag.current = null; return; }
          if (!state.active && event.pointerType !== "touch" && Math.abs(delta) > 6) state.active = true;
          if (!state.active) return;
          const target = Math.max(0, Math.min(names.length - 1, state.index + Math.round(delta / state.width)));
          setPreview({ names: move(names, state.index, target), name: state.name, offset: delta - (target - state.index) * state.width });
        }}
        onPointerUp={(event) => {
          const state = drag.current;
          if (state === null || state.pointer !== event.pointerId) return;
          window.clearTimeout(state.timer);
          drag.current = null;
          if (state.active) {
            suppressClick.current = true;
            const target = Math.max(0, Math.min(names.length - 1, state.index + Math.round((event.clientX - state.start) / state.width)));
            void saveOrder(move(names, state.index, target));
            window.setTimeout(() => { suppressClick.current = false; }, 0);
          }
          setPreview(null);
        }}
        onPointerCancel={() => { if (drag.current !== null) window.clearTimeout(drag.current.timer); drag.current = null; setPreview(null); }}
        onLostPointerCapture={() => { if (drag.current !== null) window.clearTimeout(drag.current.timer); drag.current = null; setPreview(null); }}>
        <span className={`dot dot--${waits ? "warn" : running ? "ok" : "mute"}`} role="img" aria-label={text(waits ? "workbench.mark.waits" : running ? "workbench.mark.runs" : "workbench.mark.idle")} />
        <span className="od-truncate">{label}</span>{matching.length > 0 ? <span className="count">{matching.length}</span> : null}
      </button>
      {typeof value === "string" ? <button type="button" className="wb-tab-close" aria-label={text("workbench.closeRepository", { repository: value })} disabled={busy} onClick={() => void change(value, false)}><Icon name="x" /></button> : null}
    </div>;
  };
  return <div className="wb-tabs" aria-label={text("conversation.repository")}>
    <div className="wb-tabs-scroll" ref={strip}>{tab(undefined, text("workbench.all"))}{tab(null, text("conversation.daily"))}{displayed.map((row) => tab(row.repository, row.alias ?? row.repository))}</div>
    <div className="wb-add-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <button type="button" className="wb-add" aria-label={text("workbench.openRepository")} aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}><Icon name="plus" /></button>
      {open ? <div className="wb-repo-menu" ref={menu} onKeyDown={(event) => {
        if (event.key === "Escape") { setOpen(false); return; }
        if (event.key === "Enter" && event.target instanceof HTMLInputElement && available[0] !== undefined) {
          event.preventDefault();
          void change(available[0].repository, true);
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>(".wb-repo-option") ?? [])];
        if (items.length === 0) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }}>
        <input autoFocus className="field" aria-label={text("workbench.filterRepositories")} value={filter} onChange={(event) => setFilter(event.target.value)} />
        <div className="wb-repo-options">{available.map((row) => <button type="button" className="wb-repo-option" key={row.repository} title={row.repository} disabled={busy} onClick={() => void change(row.repository, true)}>{row.alias ?? row.repository}</button>)}</div>
        {available.length === 0 ? <span className="muted">{text("workbench.noRepositories")}</span> : null}
      </div> : null}
    </div>
  </div>;
}
