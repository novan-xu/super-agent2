import { text } from "@super-agent2/catalog";
import { mergedIssueNumbers, type Ticket, type TicketPullRequestState } from "@super-agent2/protocol";
import { phaseLooks, type TicketPhase, type TicketProblem } from "../live/phase.js";
import { Icon } from "../parts/icons.js";
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

export function TicketCodeLabel({ code }: { readonly code: string }) {
  return <span className="mono wb-ticket-code">{code}</span>;
}

export const pullRequestTones: Readonly<Record<TicketPullRequestState, "ok" | "info" | "mute">> = { merged: "ok", open: "info", closed: "mute" };

export function ChainNumbers({ ticket }: { readonly ticket: Ticket }) {
  const merged = new Set(mergedIssueNumbers(ticket));
  return (
    <span className="mono chain-numbers">
      {ticket.issues.map((issue) => (
        <span key={`${issue.repository}#${issue.number}`} className={merged.has(issue.number) ? "chain-number is-merged" : "chain-number"}>
          {merged.has(issue.number) ? <Icon name="check" /> : null}
          {`#${issue.number}`}
        </span>
      ))}
    </span>
  );
}

export function RepairChip({ ticket }: { readonly ticket: Pick<Ticket, "repairs"> }) {
  return ticket.repairs === null ? null : <span className="chip chip--accent">{text("ticket.repair")}</span>;
}

export function PullRequestNumbers({ ticket }: { readonly ticket: Ticket }) {
  return (
    <span className="mono chain-numbers">
      {ticket.pullRequests.map((pull) => (
        <span key={pull.number} className={`chain-number is-${pull.state}`}>
          <Icon name="pr" />
          {`#${pull.number}`}
        </span>
      ))}
    </span>
  );
}

export function engineName(engine: Ticket["engine"]): string {
  return engine === null ? "" : text(`engine.${engine}`);
}

export function problemLines(problem: TicketProblem, now: number): readonly string[] {
  switch (problem.kind) {
    case "waits":
      return [problem.before.map((entry) => entry.title ?? (entry.code ?? text("ticket.missing"))).join("、")];
    case "beginFailed":
      return [problem.reason];
    case "queued":
      return [text("ticket.queuedOn", { machine: problem.machine })];
    case "providerWaiting":
      return withReason(text("ticket.waitsForProvider"), problem.reason);
    case "unreachable":
      return [text("ticket.unreachableSince", { time: momentOf(problem.since, now), machine: problem.machine })];
    case "failed":
      return problem.reason === "" ? [text(`work.failure.${problem.failure}`)] : [text(`work.failure.${problem.failure}`), problem.reason];
    case "stopped":
      return [problem.reason];
    case "verifyWaiting": {
      const first =
        problem.wait === "pipeline" || problem.wait === "workflows" || problem.wait === "halted"
          ? text(`verification.wait.${problem.wait}`, { commit: problem.commit })
          : text(`verification.wait.${problem.wait}`);
      return withReason(first, problem.reason);
    }
    case "verifyFailed": {
      const named = problem.failures.filter((failure) => failure.workflow !== "");
      const first =
        named.length === 0
          ? text("ticket.phase.verifyFailed")
          : named
              .map((failure) => (failure.step === "" ? text("verification.failedWorkflow", { workflow: failure.workflow }) : text("verification.failedStep", { workflow: failure.workflow, step: failure.step })))
              .join("，");
      return withReason(first, problem.reason);
    }
    case "conflicted":
      return withReason(text("verification.conflict"), problem.reason);
    case "stuck":
      return withReason(problem.where ?? text(`loop.failure.${problem.failure}`), problem.where === null ? problem.detail : null);
  }
}

function withReason(first: string, reason: string | null): readonly string[] {
  return reason === null || reason === "" ? [first] : [first, reason];
}

export function problemTone(problem: TicketProblem): "bad" | "warn" | "mute" {
  switch (problem.kind) {
    case "beginFailed":
    case "failed":
    case "verifyFailed":
      return "bad";
    case "unreachable":
    case "providerWaiting":
    case "conflicted":
    case "stuck":
      return "warn";
    default:
      return "mute";
  }
}
