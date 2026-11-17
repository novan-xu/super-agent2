import type { CommandRecord } from "@super-agent2/protocol";

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
