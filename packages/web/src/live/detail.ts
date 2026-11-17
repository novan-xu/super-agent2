import type { StoredWorkEvent, Ticket, TicketDetail, TicketMove, TicketRound, WorkStatus } from "@super-agent2/protocol";
import { type AttemptLog, emptyLog, receiveWork, type WorkLog } from "./work.js";

export interface DetailState {
  readonly id: number;
  readonly ticket: Ticket | null;
  readonly moves: readonly TicketMove[];
  readonly attempts: readonly WorkStatus[];
  readonly rounds: readonly TicketRound[];
  readonly missing: boolean;
  readonly log: WorkLog;
}

export function openDetail(id: number): DetailState {
  return { id, ticket: null, moves: [], attempts: [], rounds: [], missing: false, log: emptyLog(id) };
}

function newer(before: Ticket | null, ticket: Ticket): boolean {
  return before === null || before.updatedAt <= ticket.updatedAt;
}

export function receiveDetail(state: DetailState, detail: TicketDetail): DetailState {
  if (detail.ticket.id !== state.id) {
    return state;
  }
  const ticket = newer(state.ticket, detail.ticket) ? detail.ticket : state.ticket;
  return { ...state, ticket, moves: detail.moves, attempts: detail.attempts, rounds: detail.rounds, missing: false };
}

export function receiveMissing(state: DetailState): DetailState {
  return state.ticket === null ? { ...state, missing: true } : state;
}

export function receiveTicketChange(state: DetailState, ticket: Ticket): DetailState {
  if (ticket.id !== state.id || !newer(state.ticket, ticket)) {
    return state;
  }
  const work = ticket.work;
  const attempts =
    work === null
      ? state.attempts
      : [...state.attempts.filter((attempt) => attempt.attempt !== work.attempt), work].sort((a, b) => a.attempt - b.attempt);
  return { ...state, ticket, attempts, missing: false };
}

export function needsMoves(state: DetailState, ticket: Ticket): boolean {
  if (ticket.id !== state.id) {
    return false;
  }
  const before = state.ticket;
  if (before !== null && (before.round !== ticket.round || before.freeRetry !== ticket.freeRetry)) {
    return true;
  }
  const last = state.moves.at(-1);
  return last === undefined ? ticket.state !== "pending" : last.to !== ticket.state;
}

export function receiveDetailWork(state: DetailState, events: readonly StoredWorkEvent[]): DetailState {
  const log = receiveWork(state.log, events);
  return log === state.log ? state : { ...state, log };
}

export type TimelineEntry =
  | { readonly kind: "filed"; readonly key: string; readonly at: number }
  | { readonly kind: "move"; readonly key: string; readonly at: number; readonly move: TicketMove }
  | {
      readonly kind: "attempt";
      readonly key: string;
      readonly at: number;
      readonly number: number;
      readonly status: WorkStatus | null;
      readonly log: AttemptLog | null;
      readonly latest: boolean;
      readonly round: TicketRound | null;
    };

const order: Readonly<Record<TimelineEntry["kind"], number>> = { filed: 0, move: 1, attempt: 2 };

export function timeline(state: DetailState): TimelineEntry[] {
  const ticket = state.ticket;
  if (ticket === null) {
    return [];
  }
  const entries: TimelineEntry[] = [{ kind: "filed", key: "filed", at: ticket.createdAt }];
  for (const move of state.moves) {
    if (move.from !== null) {
      entries.push({ kind: "move", key: `move-${move.seq}`, at: move.at, move });
    }
  }
  const numbers = new Set<number>([...state.attempts.map((attempt) => attempt.attempt), ...state.log.attempts.map((attempt) => attempt.attempt)]);
  const latest = Math.max(0, ...numbers);
  for (const number of numbers) {
    const status = state.attempts.find((attempt) => attempt.attempt === number) ?? null;
    const log = state.log.attempts.find((attempt) => attempt.attempt === number) ?? null;
    const at = status?.createdAt ?? log?.first ?? ticket.updatedAt;
    const round = state.rounds.find((entry) => entry.attempt === number) ?? null;
    entries.push({ kind: "attempt", key: `attempt-${number}`, at, number, status, log, latest: number === latest, round });
  }
  return entries.sort((a, b) => {
    if (a.at !== b.at) {
      return a.at - b.at;
    }
    if (a.kind !== b.kind) {
      return order[a.kind] - order[b.kind];
    }
    if (a.kind === "move" && b.kind === "move") {
      return a.move.seq - b.move.seq;
    }
    if (a.kind === "attempt" && b.kind === "attempt") {
      return a.number - b.number;
    }
    return 0;
  });
}

export type MoveLabel = "started" | "queuedBehind" | "began" | "verifying" | "returned" | "merged" | "delivered" | "stopped" | "stuck" | "resumed" | "moved";

export function moveLabel(move: TicketMove): MoveLabel {
  if (move.from === "stuck" && move.to !== "stopped") {
    return "resumed";
  }
  if (move.to === "working") {
    return move.from === "pending" ? "started" : move.from === "waiting" ? "began" : "returned";
  }
  if (move.to === "waiting") {
    return "queuedBehind";
  }
  if (move.to === "verifying" || move.to === "merged" || move.to === "delivered" || move.to === "stopped" || move.to === "stuck") {
    return move.to;
  }
  return "moved";
}

export function isWorkLive(entry: Extract<TimelineEntry, { readonly kind: "attempt" }>): boolean {
  const state = entry.status?.state;
  return entry.latest && (state === "preparing" || state === "running") && entry.status?.unreachableSince === null && entry.log?.ended !== true;
}
