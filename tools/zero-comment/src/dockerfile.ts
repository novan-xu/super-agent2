import { DockerfileParser, type Instruction } from "dockerfile-ast";
import { comment, type Finding } from "./finding.js";
import { findShellComments } from "./shell.js";

const shellInstructions = new Set(["RUN", "CMD", "ENTRYPOINT"]);

interface HeredocLike {
  getContentRange(): { start: { line: number }; end: { line: number } } | null;
}

function isExecForm(argumentsText: string): boolean {
  try {
    const value: unknown = JSON.parse(argumentsText);
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  } catch {
    return false;
  }
}

function heredocsOf(instruction: Instruction): HeredocLike[] {
  const candidate = instruction as unknown as { getHeredocs?: () => HeredocLike[] };
  return typeof candidate.getHeredocs === "function" ? candidate.getHeredocs() : [];
}

function checkScript(lines: string[], lineNumbers: number[]): Finding[] {
  return findShellComments(lines.join("\n")).map((finding) => ({
    ...finding,
    line: lineNumbers[finding.line - 1] ?? lineNumbers[lineNumbers.length - 1] ?? 1,
  }));
}

function checkInstruction(instruction: Instruction, lines: string[], commentLines: Set<number>): Finding[] {
  const keyword = instruction.getKeyword().toUpperCase();
  const argumentsRange = instruction.getArgumentsRange();
  if (!shellInstructions.has(keyword) || argumentsRange === null) {
    return [];
  }
  const firstLine = argumentsRange.start.line;
  const lastLine = instruction.getRange().end.line;
  const firstText = (lines[firstLine] ?? "").slice(argumentsRange.start.character);
  const withoutFlags = firstText.replace(/^(\s*--\S+)+/, (flags) => " ".repeat(flags.length));
  if (isExecForm((instruction.getRawArgumentsContent() ?? "").trim())) {
    return [];
  }
  const heredocOnly = /^\s*(<<-?(["']?)[A-Za-z_][A-Za-z0-9_]*\2\s*)+$/.test(withoutFlags);
  if (heredocOnly) {
    return heredocsOf(instruction).flatMap((heredoc) => {
      const range = heredoc.getContentRange();
      if (range === null) {
        return [];
      }
      const numbers: number[] = [];
      for (let line = range.start.line; line <= range.end.line; line += 1) {
        numbers.push(line);
      }
      return checkScript(
        numbers.map((line) => lines[line] ?? ""),
        numbers.map((line) => line + 1),
      );
    });
  }
  const scriptLines: string[] = [];
  const scriptNumbers: number[] = [];
  for (let line = firstLine; line <= lastLine; line += 1) {
    if (line !== firstLine && commentLines.has(line)) {
      continue;
    }
    const text = line === firstLine ? " ".repeat(argumentsRange.start.character) + withoutFlags : lines[line] ?? "";
    if (line !== firstLine && text.trim() === "") {
      continue;
    }
    scriptLines.push(text);
    scriptNumbers.push(line + 1);
  }
  return checkScript(scriptLines, scriptNumbers);
}

export function findDockerfileComments(text: string): Finding[] {
  const dockerfile = DockerfileParser.parse(text);
  const lines = text.split(/\r\n|\r|\n/);
  const findings: Finding[] = [];
  const commentLines = new Set<number>();
  for (const node of [...dockerfile.getDirectives(), ...dockerfile.getComments()]) {
    const start = node.getRange().start;
    commentLines.add(start.line);
    findings.push(comment(start.line + 1, start.character + 1));
  }
  for (const instruction of dockerfile.getInstructions()) {
    findings.push(...checkInstruction(instruction, lines, commentLines));
  }
  return findings;
}
