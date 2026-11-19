import { checkRepository, formatFinding } from "./repository.js";

export interface RunResult {
  exitCode: number;
  lines: string[];
}

export function run(root: string): RunResult {
  const report = checkRepository(root);
  if (report.findings.length === 0 && report.conflicts.length === 0) {
    return { exitCode: 0, lines: [`No comments in ${report.checked} checked file(s).`] };
  }
  return {
    exitCode: 1,
    lines: [
      ...report.findings.map(formatFinding),
      ...(report.findings.length === 0 ? [] : [`${report.findings.length} comment finding(s) in ${report.checked} checked file(s).`]),
      ...report.conflicts.map(formatFinding),
      ...(report.conflicts.length === 0 ? [] : [`${report.conflicts.length} merge conflict marker(s) left in tracked files.`]),
    ],
  };
}
