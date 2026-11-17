import { activeWorkStates, type Ticket, unmetWaits, type WorkFailure } from "@super-agent2/protocol";

export const ticketPhases = [
  "pending",
  "waiting",
  "beginFailed",
  "starting",
  "queued",
  "preparing",
  "running",
  "unreachable",
  "failed",
  "halted",
  "verifying",
  "merged",
  "delivered",
  "stopped",
] as const;
export type TicketPhase = (typeof ticketPhases)[number];

export type Tone = "mute" | "ok" | "info" | "warn" | "bad";

export const phaseLooks: Readonly<Record<TicketPhase, { readonly tone: Tone; readonly live: boolean }>> = {
  pending: { tone: "mute", live: false },
  waiting: { tone: "mute", live: false },
  beginFailed: { tone: "bad", live: false },
  starting: { tone: "mute", live: false },
  queued: { tone: "mute", live: false },
  preparing: { tone: "ok", live: true },
  running: { tone: "ok", live: true },
  unreachable: { tone: "warn", live: false },
  failed: { tone: "bad", live: false },
  halted: { tone: "mute", live: false },
  verifying: { tone: "info", live: false },
  merged: { tone: "ok", live: false },
  delivered: { tone: "info", live: false },
  stopped: { tone: "mute", live: false },
};

export function ticketPhase(ticket: Ticket): TicketPhase {
  switch (ticket.state) {
    case "pending":
    case "waiting":
    case "verifying":
    case "merged":
    case "delivered":
    case "stopped":
      return ticket.state;
    case "working": {
      const work = ticket.work;
      if (ticket.beginFailure !== null && work === null) {
        return "beginFailed";
      }
      if (work === null) {
        return "starting";
      }
      switch (work.state) {
        case "queued":
          return "queued";
        case "preparing":
        case "running":
          if (work.unreachableSince !== null) {
            return "unreachable";
          }
          return work.state;
        case "failed":
          return "failed";
        default:
          return "halted";
      }
    }
  }
}

export type TicketProblem =
  | { readonly kind: "waits"; readonly before: readonly { readonly id: number; readonly title: string | null; readonly state: Ticket["state"] | null }[] }
  | { readonly kind: "beginFailed"; readonly reason: string }
  | { readonly kind: "queued"; readonly machine: string }
  | { readonly kind: "unreachable"; readonly machine: string; readonly since: number }
  | { readonly kind: "failed"; readonly failure: WorkFailure; readonly reason: string }
  | { readonly kind: "stopped"; readonly reason: string };

export function ticketProblem(ticket: Ticket, known: ReadonlyMap<number, Ticket>): TicketProblem | null {
  const phase = ticketPhase(ticket);
  const work = ticket.work;
  switch (phase) {
    case "waiting": {
      const before = unmetWaits(ticket, known).map((wait) => {
        const found = known.get(wait.ticket);
        return { id: wait.ticket, title: found === undefined ? null : found.title.zh, state: found?.state ?? null };
      });
      return { kind: "waits", before };
    }
    case "beginFailed":
      return { kind: "beginFailed", reason: ticket.beginFailure ?? "" };
    case "queued":
      return work === null ? null : { kind: "queued", machine: work.machine };
    case "unreachable":
      return work === null || work.unreachableSince === null ? null : { kind: "unreachable", machine: work.machine, since: work.unreachableSince };
    case "failed":
      return work === null ? null : { kind: "failed", failure: work.failure ?? "program", reason: work.reason ?? "" };
    case "stopped":
      return ticket.stopReason === null ? null : { kind: "stopped", reason: ticket.stopReason.zh };
    default:
      return null;
  }
}

export interface PanelOffers {
  readonly stop: boolean;
  readonly reassign: boolean;
  readonly reply: boolean;
}

export function panelOffers(ticket: Ticket): PanelOffers {
  const open = ticket.state === "waiting" || ticket.state === "working" || ticket.state === "verifying";
  const work = ticket.work;
  const reachable = work !== null && activeWorkStates.includes(work.state) && work.unreachableSince === null;
  return { stop: open, reassign: open, reply: (ticket.state === "working" || ticket.state === "verifying") && reachable };
}

export interface TicketGroup {
  readonly key: string;
  readonly repository: string | null;
  readonly tickets: readonly Ticket[];
}

export function ticketGroups(open: readonly Ticket[]): TicketGroup[] {
  const groups = new Map<string, { repository: string | null; tickets: Ticket[] }>();
  for (const ticket of open) {
    if (ticket.state === "pending") {
      continue;
    }
    const repository = ticket.kind === "writing" ? null : ticket.repository;
    const key = repository === null ? "writing" : `repository:${repository}`;
    const group = groups.get(key) ?? { repository, tickets: [] };
    group.tickets.push(ticket);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, repository: group.repository, tickets: group.tickets }))
    .sort((a, b) => {
      if (a.repository === null || b.repository === null) {
        return a.repository === null ? (b.repository === null ? 0 : 1) : -1;
      }
      return a.repository.toLowerCase() < b.repository.toLowerCase() ? -1 : a.repository.toLowerCase() > b.repository.toLowerCase() ? 1 : 0;
    });
}

export function whereOf(ticket: Ticket): { readonly machine: string; readonly engine: Ticket["engine"] } | null {
  const work = ticket.work;
  if (work !== null && ticket.state !== "waiting") {
    return { machine: work.machine, engine: work.engine };
  }
  return ticket.machine === null || ticket.engine === null ? null : { machine: ticket.machine, engine: ticket.engine };
}
