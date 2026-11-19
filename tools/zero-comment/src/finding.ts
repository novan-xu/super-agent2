export interface Finding {
  line: number;
  column: number;
  message: string;
}

export const commentMessage = "comment";

export function comment(line: number, column: number): Finding {
  return { line, column, message: commentMessage };
}

export function unparsable(line: number, column: number, reason: string): Finding {
  return { line, column, message: `cannot be parsed: ${reason}` };
}

export class Positions {
  private readonly lineStarts: number[];

  constructor(text: string) {
    this.lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) {
        this.lineStarts.push(index + 1);
      }
    }
  }

  at(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.lineStarts[middle] ?? 0) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: offset - (this.lineStarts[low] ?? 0) + 1 };
  }
}

export function embedded(findings: Finding[], line: number, column: number): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    line: finding.line + line - 1,
    column: finding.line === 1 ? finding.column + column - 1 : finding.column,
  }));
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
}
