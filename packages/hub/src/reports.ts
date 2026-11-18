import { type CommandRecord, deploymentFile, type MachineChoice, mergedIssueNumbers, openIssueNumbers, openPullRequest, type StartChoice, type Subscription, type Subscriptions, type Ticket, type TicketMove, type TicketWait } from "@super-agent2/protocol";
import { durationWords, overrunFactor } from "./pipeline-times.js";
import type { WaitedFor } from "./verification.js";

export const reportLimit = 40_000;

export function clip(text: string, limit: number = reportLimit): string {
  if (text.length <= limit) {
    return text;
  }
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - tail)}`;
}

export function waitedLine(waited: WaitedFor): string {
  const usual =
    waited.usual === null
      ? `there is no usual time for this repository yet (${waited.samples} green pipeline${waited.samples === 1 ? "" : "s"} recorded), so the first-time allowance applies`
      : `usual for this repository: ${durationWords(waited.usual)}, the median of its last ${waited.samples} green pipelines`;
  const when = waited.usual === null ? "the allowance" : `${overrunFactor} times the usual`;
  return `Waiting on the pipeline for ${durationWords(waited.waited)}; ${usual}. You are told at ${durationWords(waited.threshold)} (${when}) and again at each doubling. The time decides nothing: the ticket stays verifying.`;
}

export function tail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const kept = text.slice(text.length - limit);
  return `[the first ${text.length - limit} of ${text.length} characters are cut; this is the end, where the failure is]\n${kept}`;
}

export function commandSummary(command: CommandRecord): string {
  const parts = [`Command ${command.id} on target ${command.target} (account ${command.account}) is ${command.state}`];
  if (command.exitCode !== null) {
    parts.push(`with exit code ${command.exitCode}`);
  }
  if (command.signal !== null) {
    parts.push(`after signal ${command.signal}`);
  }
  return `${parts.join(" ")}.`;
}

export function commandReport(command: CommandRecord, output: string): string {
  const lines = [commandSummary(command), `Command: ${command.command}`];
  if (command.cwd !== null) {
    lines.push(`Folder: ${command.cwd}`);
  }
  if (command.reason !== null) {
    lines.push(`Reason: ${command.reason}`);
  }
  lines.push(output === "" ? "Output: (none)" : `Output:\n${clip(output)}`);
  return lines.join("\n");
}

function chosen(value: string | number | null): string {
  return value === null ? "not set" : String(value);
}

function waitText(wait: TicketWait): string {
  const what = `ticket ${wait.ticket}${wait.deployment ? " to be merged and deployed" : " to be merged"}`;
  return wait.waived ? `${what} (waived)` : what;
}

function numbers(list: readonly number[]): string {
  return list.map((number) => `#${number}`).join(", ");
}

export function ticketLine(ticket: Ticket): string {
  const where = ticket.repository === null ? "no repository" : ticket.repository;
  const merged = new Set(mergedIssueNumbers(ticket));
  const issues = ticket.issues.map((issue) => `#${issue.number}${merged.has(issue.number) ? " merged" : ""}`).join(", ");
  const pulls = ticket.pullRequests.map((pull) => `#${pull.number} ${pull.state}`).join(", ");
  return `Ticket ${ticket.id} [${ticket.state}] ${ticket.kind} in ${where}${issues === "" ? "" : ` (issues ${issues}${pulls === "" ? "" : `; pull requests ${pulls}`})`}: ${ticket.title.en}`;
}

export function chainProgress(ticket: Ticket): string[] {
  if (ticket.repository === null) {
    return [];
  }
  const merged = ticket.pullRequests.filter((pull) => pull.state === "merged");
  const open = openPullRequest(ticket.pullRequests);
  const remaining = openIssueNumbers(ticket);
  const last = merged.at(-1);
  const lines = [
    merged.length === 0
      ? "No pull request of this chain is merged."
      : `Pull requests merged, in order: ${merged.map((pull) => `#${pull.number} (closed ${pull.closes.length === 0 ? "no issue of the chain" : numbers(pull.closes)}${pull.mergeCommit === null ? "" : `, commit ${pull.mergeCommit}`})`).join("; ")}. The issues they closed stay closed.`,
    remaining.length === 0 ? "Every issue of the chain is closed." : `Still open: ${numbers(remaining)}${open === undefined ? "; no pull request is open for them" : `; open pull request: #${open.number} from ${open.branch}`}.`,
  ];
  if (last !== undefined && last.deployment !== null) {
    lines.push(
      last.deployment
        ? `Deployment: the repository has a deployment (${deploymentFile}), so what is merged needs deploying; the last merge commit is ${last.mergeCommit ?? "unknown"}, and it contains every earlier one.`
        : "Deployment: the repository has no deployment, so nothing needs deploying.",
    );
  }
  return lines;
}

export function ticketReport(ticket: Ticket, moves: readonly TicketMove[] = []): string {
  const lines = [
    ticketLine(ticket),
    `Chinese title: ${ticket.title.zh}`,
    `Summary: ${ticket.summary.en}`,
    `Chinese summary: ${ticket.summary.zh}`,
  ];
  if (ticket.issues.length > 0) {
    const merged = new Set(mergedIssueNumbers(ticket));
    lines.push("Issues in working order:");
    for (const issue of ticket.issues) {
      lines.push(`  ${issue.repository}#${issue.number} ${issue.title.en} (${issue.url})${merged.has(issue.number) ? ", closed by a merged pull request" : ""}`);
    }
  }
  if (ticket.pullRequests.length > 0) {
    lines.push("Pull requests, in the order handed in:");
    for (const pull of ticket.pullRequests) {
      lines.push(
        `  #${pull.number} ${pull.state} from ${pull.branch} (${pull.url})${pull.state === "merged" ? `, closed ${pull.closes.length === 0 ? "no issue of the chain" : numbers(pull.closes)}${pull.mergeCommit === null ? "" : `, commit ${pull.mergeCommit}`}` : pull.closes.length === 0 ? "" : `, to close ${numbers(pull.closes)}`}`,
      );
    }
  }
  lines.push(
    `Difficulty: ${chosen(ticket.difficulty)}; platform: ${chosen(ticket.platform)}`,
    `Difficulty reason: ${ticket.difficultyReason === null ? "not stated" : ticket.difficultyReason.en}; engine you chose: ${chosen(ticket.brainEngine)}`,
    `Machine: ${chosen(ticket.machine)}; engine: ${chosen(ticket.engine)}; model: ${chosen(ticket.model)}; effort: ${chosen(ticket.effort)}${
      ticket.chosenBy === null
        ? ""
        : ` (chosen by: machine ${ticket.chosenBy.machine}, engine ${ticket.chosenBy.engine}, model ${ticket.chosenBy.model}, effort ${ticket.chosenBy.effort})`
    }`,
    `Actually ran: ${ticket.ran === null ? "nothing yet" : `${ticket.ran.machine}, ${ticket.ran.engine}, ${ticket.ran.model}, ${ticket.ran.effort}`}`,
    `Branch: ${chosen(ticket.branch)}; pull request: ${ticket.pullRequest === null ? "none" : `#${ticket.pullRequest}`}; guided round: ${ticket.round}`,
    `Waits for: ${ticket.waits.length === 0 ? "nothing" : ticket.waits.map(waitText).join(", ")}`,
  );
  if (ticket.work !== null) {
    const work = ticket.work;
    const reach = work.unreachableSince === null ? "" : `; its machine has not been reachable since ${new Date(work.unreachableSince).toISOString()}`;
    const why = work.reason === null ? "" : `: ${work.failure === null ? "" : `${work.failure}, `}${work.reason}`;
    lines.push(`Worker: attempt ${work.attempt} on ${work.machine} with ${work.engine} ${work.model} ${work.effort} is ${work.state}${why}${reach}`);
  }
  if (ticket.report !== null) {
    lines.push(`Worker's report: ${ticket.report.en}`, `Chinese report: ${ticket.report.zh}`);
  }
  const verification = ticket.verification;
  if (verification !== null) {
    const parts = [
      `Verification: ${verification.state}${verification.waiting === null ? "" : ` (waiting: ${verification.waiting})`}`,
      `rule ${verification.rule ?? "not decided yet"}`,
      `change ${verification.level ?? "not read yet"}`,
      `head ${verification.head ?? "unknown"}`,
    ];
    if (verification.pipeline !== null) {
      parts.push(`pipeline ${verification.pipeline.url}`);
    }
    if (verification.workflows.length > 0) {
      parts.push(`workflows ${verification.workflows.map((workflow) => `${workflow.name} ${workflow.state}`).join(", ")}`);
    }
    if (verification.mergeCommit !== null) {
      parts.push(`merged as ${verification.mergeCommit}`);
    }
    if (verification.deployment !== null) {
      parts.push(verification.deployment ? "the repository has a deployment" : "the repository has no deployment");
    }
    if (verification.conflictReturns > 0) {
      parts.push(`went back to its worker for a conflict ${verification.conflictReturns} time${verification.conflictReturns === 1 ? "" : "s"}`);
    }
    lines.push(`${parts.join("; ")}${verification.reason === null ? "" : `. ${verification.reason}`}`);
  }
  if (ticket.deployedAt !== null) {
    lines.push(`Deployed: reported at ${new Date(ticket.deployedAt).toISOString()}`);
  }
  if (ticket.beginFailure !== null) {
    lines.push(`Its work could not begin: ${ticket.beginFailure}`);
  }
  if (ticket.stopReason !== null) {
    lines.push(`Stopped because: ${ticket.stopReason.en}`);
  }
  if (ticket.conversation !== null) {
    lines.push(`Filed in conversation ${ticket.conversation}`);
  }
  for (const move of moves) {
    const reason = move.reason === null ? "" : `: ${move.reason.en}`;
    lines.push(`  ${new Date(move.at).toISOString()} ${move.from ?? "filed"} -> ${move.to}${reason}`);
  }
  return lines.join("\n");
}

export function choiceText(choice: StartChoice): string {
  const what = `${chosen(choice.machine)}, ${chosen(choice.engine)}, ${chosen(choice.model)}, ${chosen(choice.effort)}`;
  if (choice.missing.length === 0) {
    return `It would run on ${what}.`;
  }
  return `It cannot start yet (missing: ${choice.missing.join(", ")}); so far: ${what}.`;
}

function subscriptionLine(name: string, subscription: Subscription): string {
  if (subscription.state === "unknown") {
    return `${name}: unknown (no current reading)`;
  }
  const left = subscription.remainingPercent === null ? "" : `, ${subscription.remainingPercent}% left`;
  const resets = subscription.resetsAt === null ? "" : `, resets ${new Date(subscription.resetsAt).toISOString()}`;
  const read = subscription.readAt === null ? "" : `, read ${new Date(subscription.readAt).toISOString()} on ${subscription.machine ?? "?"}`;
  return `${name}: ${subscription.state === "exhausted" ? "used up" : "available"}${left}${resets}${read}`;
}

export function allowanceReport(subscriptions: Subscriptions, machines: readonly MachineChoice[]): string {
  const lines = [
    subscriptionLine("GPT subscription (codex)", subscriptions.codex),
    subscriptionLine("Claude subscription (claude)", subscriptions.claude),
    "An unknown reading is not used up. dsh is the default only when both are used up.",
  ];
  if (machines.length === 0) {
    lines.push("No work machine is online.");
  }
  for (const machine of machines) {
    lines.push(`Machine ${machine.name} (${machine.platform}), ${machine.free} free slot(s): ${machine.engines.map((offer) => offer.engine).join(", ") || "no programs"}`);
  }
  return lines.join("\n");
}
