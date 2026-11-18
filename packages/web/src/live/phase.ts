import { activeWorkStates, type FailedStep, type LoopFailureKind, type Ticket, unmetWaits, type VerificationWait, type WorkFailure } from "@super-agent2/protocol";

export const ticketPhases = [
  "pending",
  "waiting",
  "beginFailed",
  "starting",
  "queued",
  "providerWaiting",
  "preparing",
  "running",
  "unreachable",
  "failed",
  "halted",
  "verifying",
  "verifyFailed",
  "conflicted",
  "stuck",
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
  providerWaiting: { tone: "warn", live: false },
  preparing: { tone: "ok", live: true },
  running: { tone: "ok", live: true },
  unreachable: { tone: "warn", live: false },
  failed: { tone: "bad", live: false },
  halted: { tone: "mute", live: false },
  verifying: { tone: "info", live: false },
  verifyFailed: { tone: "bad", live: false },
  conflicted: { tone: "warn", live: false },
  stuck: { tone: "warn", live: false },
  merged: { tone: "ok", live: false },
  delivered: { tone: "info", live: false },
  stopped: { tone: "mute", live: false },
};

export function ticketPhase(ticket: Ticket): TicketPhase {
  switch (ticket.state) {
    case "verifying":
      return ticket.verification?.state === "failed" ? "verifyFailed" : ticket.verification?.state === "conflict" ? "conflicted" : "verifying";
    case "pending":
    case "waiting":
    case "stuck":
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
        case "unavailable":
          return "providerWaiting";
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
  | { readonly kind: "providerWaiting"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly machine: string; readonly since: number }
  | { readonly kind: "failed"; readonly failure: WorkFailure; readonly reason: string }
  | { readonly kind: "stopped"; readonly reason: string }
  | { readonly kind: "verifyWaiting"; readonly wait: VerificationWait; readonly commit: string; readonly reason: string | null }
  | { readonly kind: "verifyFailed"; readonly failures: readonly FailedStep[]; readonly reason: string | null }
  | { readonly kind: "conflicted"; readonly reason: string | null }
  | { readonly kind: "stuck"; readonly round: number; readonly failure: LoopFailureKind; readonly where: string | null; readonly detail: string };

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
    case "providerWaiting":
      return work === null ? null : { kind: "providerWaiting", reason: work.reason ?? "" };
    case "unreachable":
      return work === null || work.unreachableSince === null ? null : { kind: "unreachable", machine: work.machine, since: work.unreachableSince };
    case "failed":
      return work === null ? null : { kind: "failed", failure: work.failure ?? "program", reason: work.reason ?? "" };
    case "stopped":
      return ticket.stopReason === null ? null : { kind: "stopped", reason: ticket.stopReason.zh };
    case "verifyFailed":
      return { kind: "verifyFailed", failures: ticket.verification?.failures ?? [], reason: ticket.verification?.reason ?? null };
    case "conflicted":
      return { kind: "conflicted", reason: ticket.verification?.reason ?? null };
    case "stuck": {
      const stuck = ticket.stuck;
      return stuck === null ? null : { kind: "stuck", round: stuck.round, failure: stuck.failure.kind, where: stuck.where === null ? null : stuck.where.zh, detail: stuck.failure.detail };
    }
    case "verifying": {
      const verification = ticket.verification;
      if (verification === null || verification.waiting === null) {
        return null;
      }
      return { kind: "verifyWaiting", wait: verification.waiting, commit: (verification.head ?? "").slice(0, 7), reason: verification.reason };
    }
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
  const reachable = work !== null && ((activeWorkStates.includes(work.state) && work.unreachableSince === null) || work.state === "unavailable");
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
    const repository = ticket.repository;
    const key = repository === null ? "tasks" : `repository:${repository}`;
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

export function kindKey(ticket: Pick<Ticket, "kind" | "deploys">): "ticket.kind.deploy" | `ticket.kind.${Ticket["kind"]}` {
  return ticket.deploys ? "ticket.kind.deploy" : `ticket.kind.${ticket.kind}`;
}

export function whereOf(ticket: Ticket): { readonly machine: string; readonly engine: Ticket["engine"] } | null {
  const work = ticket.work;
  if (work !== null && ticket.state !== "waiting") {
    return { machine: work.machine, engine: work.engine };
  }
  return ticket.machine === null || ticket.engine === null ? null : { machine: ticket.machine, engine: ticket.engine };
}
