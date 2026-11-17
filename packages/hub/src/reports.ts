import type { CommandRecord, Ticket, TicketMove, TicketWait } from "@super-agent2/protocol";

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

export function ticketLine(ticket: Ticket): string {
  const where = ticket.repository === null ? "no repository" : ticket.repository;
  const issues = ticket.issues.map((issue) => `#${issue.number}`).join(", ");
  return `Ticket ${ticket.id} [${ticket.state}] ${ticket.kind} in ${where}${issues === "" ? "" : ` (issues ${issues})`}: ${ticket.title.en}`;
}

export function ticketReport(ticket: Ticket, moves: readonly TicketMove[] = []): string {
  const lines = [
    ticketLine(ticket),
    `Chinese title: ${ticket.title.zh}`,
    `Summary: ${ticket.summary.en}`,
    `Chinese summary: ${ticket.summary.zh}`,
  ];
  if (ticket.issues.length > 0) {
    lines.push("Issues in working order:");
    for (const issue of ticket.issues) {
      lines.push(`  ${issue.repository}#${issue.number} ${issue.title.en} (${issue.url})`);
    }
  }
  lines.push(
    `Difficulty: ${chosen(ticket.difficulty)}; platform: ${chosen(ticket.platform)}`,
    `Machine: ${chosen(ticket.machine)}; engine: ${chosen(ticket.engine)}; model: ${chosen(ticket.model)}; effort: ${chosen(ticket.effort)}`,
    `Branch: ${chosen(ticket.branch)}; pull request: ${ticket.pullRequest === null ? "none" : `#${ticket.pullRequest}`}; guided round: ${ticket.round}`,
    `Waits for: ${ticket.waits.length === 0 ? "nothing" : ticket.waits.map(waitText).join(", ")}`,
  );
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
