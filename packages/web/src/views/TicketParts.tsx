import { text } from "@super-agent2/catalog";
import type { Ticket } from "@super-agent2/protocol";
import { phaseLooks, type TicketPhase, type TicketProblem } from "../live/phase.js";
import { clockOf, dayLabel } from "./Entries.js";

export function momentOf(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return clockOf(at);
  }
  const day = dayLabel({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), relative: null }, today.getFullYear());
  return `${day} ${clockOf(at)}`;
}

export function PhaseStatus({ phase }: { readonly phase: TicketPhase }) {
  const { tone, live } = phaseLooks[phase];
  return (
    <span className={`status status--${tone}`}>
      <span className={live ? `dot dot--${tone} dot--live` : `dot dot--${tone}`} />
      <span>{text(`ticket.phase.${phase}`)}</span>
    </span>
  );
}

export function engineName(engine: Ticket["engine"]): string {
  return engine === null ? "" : text(`engine.${engine}`);
}

export function problemLines(problem: TicketProblem, now: number): readonly string[] {
  switch (problem.kind) {
    case "waits":
      return [problem.before.map((entry) => entry.title ?? text("ticket.number", { ticket: entry.id })).join("、")];
    case "beginFailed":
      return [problem.reason];
    case "queued":
      return [text("ticket.queuedOn", { machine: problem.machine })];
    case "unreachable":
      return [text("ticket.unreachableSince", { time: momentOf(problem.since, now), machine: problem.machine })];
    case "failed":
      return problem.reason === "" ? [text(`work.failure.${problem.failure}`)] : [text(`work.failure.${problem.failure}`), problem.reason];
    case "stopped":
      return [problem.reason];
  }
}

export function problemTone(problem: TicketProblem): "bad" | "warn" | "mute" {
  switch (problem.kind) {
    case "beginFailed":
    case "failed":
      return "bad";
    case "unreachable":
      return "warn";
    default:
      return "mute";
  }
}
