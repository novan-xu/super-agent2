import { checkRepository, formatFinding } from "./repository.js";

export interface RunResult {
  exitCode: number;
  lines: string[];
}

export function run(root: string): RunResult {
  const report = checkRepository(root);
  if (report.findings.length === 0) {
    return { exitCode: 0, lines: [`No literal text in the markup of ${report.checked} checked page file(s).`] };
  }
  return {
    exitCode: 1,
    lines: [
      ...report.findings.map(formatFinding),
      `${report.findings.length} literal text finding(s) in ${report.checked} checked page file(s). The page's markup holds no literal text: every label comes from the catalog.`,
    ],
  };
}
