import { text } from "@super-agent2/catalog";
import { type Conversation, type RepositoryAccount, type Ticket, ticketProject } from "@super-agent2/protocol";
import { useMemo, useRef, useState } from "react";
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
}

function belongs(scope: string | null | undefined, value: string | null): boolean {
  return scope === undefined || (scope?.toLowerCase() ?? null) === (value?.toLowerCase() ?? null);
}

export function RepositoryTabs({ repositories, tickets, topics, waiting, selected, select, pin }: RepositoryTabsProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const all = useMemo(() => {
    const map = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    for (const card of waiting.cards) if (card.kind !== "hold") map.set(card.ticket.id, card.ticket);
    return [...map.values()];
  }, [tickets, waiting.cards]);
  const pinned = repositories.filter((row) => row.pinned).sort((a, b) =>
    (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0) || (a.alias ?? a.repository).localeCompare(b.alias ?? b.repository) || a.repository.localeCompare(b.repository));
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
    return <div key={value === undefined ? "all" : value === null ? "daily" : value} className={`wb-tab${active ? " is-active" : ""}`}>
      <button type="button" className="wb-tab-select" title={typeof value === "string" ? value : undefined} aria-pressed={active} onClick={() => select(value)}>
        <span className={`dot dot--${waits ? "warn" : running ? "ok" : "mute"}`} role="img" aria-label={text(waits ? "workbench.mark.waits" : running ? "workbench.mark.runs" : "workbench.mark.idle")} />
        <span className="od-truncate">{label}</span>{matching.length > 0 ? <span className="count">{matching.length}</span> : null}
      </button>
      {typeof value === "string" ? <button type="button" className="wb-tab-close" aria-label={text("workbench.closeRepository", { repository: value })} disabled={busy} onClick={() => void change(value, false)}><Icon name="x" /></button> : null}
    </div>;
  };
  return <div className="wb-tabs" aria-label={text("conversation.repository")}>
    <div className="wb-tabs-scroll">{tab(undefined, text("workbench.all"))}{tab(null, text("conversation.daily"))}{pinned.map((row) => tab(row.repository, row.alias ?? row.repository))}</div>
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
