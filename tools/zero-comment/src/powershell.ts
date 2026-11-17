import { comment, Positions, type Finding } from "./finding.js";

const singleQuotes = new Set(["'", "‘", "’", "‚", "‛"]);
const doubleQuotes = new Set(['"', "“", "”", "„"]);
const tokenBoundaries = new Set([";", "(", ")", "{", "}", "[", "]", "|", "&", ",", "="]);

function isNewline(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

class Scanner {
  private index = 0;
  readonly comments: number[] = [];

  constructor(private readonly text: string) {}

  run(): void {
    this.code(false);
  }

  private at(offset = 0): string | undefined {
    return this.text[this.index + offset];
  }

  private startsToken(): boolean {
    const previous = this.text[this.index - 1];
    return previous === undefined || /\s/.test(previous) || tokenBoundaries.has(previous);
  }

  private code(insideSubexpression: boolean): void {
    let depth = 0;
    while (this.index < this.text.length) {
      const char = this.at() ?? "";
      const next = this.at(1);
      if (char === "<" && next === "#") {
        this.blockComment();
      } else if (char === "#" && this.startsToken()) {
        this.lineComment();
      } else if (char === "`") {
        this.index += 2;
      } else if (char === "@" && (next === "'" || next === '"') && this.opensHereString()) {
        this.hereString(next);
      } else if (singleQuotes.has(char)) {
        this.singleQuoted();
      } else if (doubleQuotes.has(char)) {
        this.doubleQuoted();
      } else if (char === "$" && next === "{") {
        this.bracedVariable();
      } else if (char === "(") {
        depth += 1;
        this.index += 1;
      } else if (char === ")") {
        this.index += 1;
        if (insideSubexpression) {
          if (depth === 0) {
            return;
          }
          depth -= 1;
        }
      } else {
        this.index += 1;
      }
    }
  }

  private blockComment(): void {
    this.comments.push(this.index);
    const end = this.text.indexOf("#>", this.index + 2);
    this.index = end === -1 ? this.text.length : end + 2;
  }

  private lineComment(): void {
    this.comments.push(this.index);
    while (this.index < this.text.length && !isNewline(this.at())) {
      this.index += 1;
    }
  }

  private singleQuoted(): void {
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.at() ?? "";
      if (singleQuotes.has(char)) {
        if (singleQuotes.has(this.at(1) ?? "")) {
          this.index += 2;
          continue;
        }
        this.index += 1;
        return;
      }
      this.index += 1;
    }
  }

  private doubleQuoted(): void {
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.at() ?? "";
      if (char === "`") {
        this.index += 2;
      } else if (doubleQuotes.has(char)) {
        if (doubleQuotes.has(this.at(1) ?? "")) {
          this.index += 2;
          continue;
        }
        this.index += 1;
        return;
      } else if (char === "$" && this.at(1) === "(") {
        this.index += 2;
        this.code(true);
      } else {
        this.index += 1;
      }
    }
  }

  private bracedVariable(): void {
    this.index += 2;
    while (this.index < this.text.length && this.at() !== "}") {
      this.index += this.at() === "`" ? 2 : 1;
    }
    this.index += 1;
  }

  private opensHereString(): boolean {
    let offset = 2;
    while (this.at(offset) === " " || this.at(offset) === "\t") {
      offset += 1;
    }
    return isNewline(this.at(offset));
  }

  private hereString(quote: "'" | '"'): void {
    this.index += 2;
    while (!isNewline(this.at())) {
      this.index += 1;
    }
    while (this.index < this.text.length) {
      const char = this.at() ?? "";
      if (isNewline(char)) {
        this.index += char === "\r" && this.at(1) === "\n" ? 2 : 1;
        if (this.at() === quote && this.at(1) === "@") {
          this.index += 2;
          return;
        }
      } else if (quote === '"' && char === "`") {
        this.index += 2;
      } else if (quote === '"' && char === "$" && this.at(1) === "(") {
        this.index += 2;
        this.code(true);
      } else {
        this.index += 1;
      }
    }
  }
}

export function findPowerShellComments(text: string): Finding[] {
  const scanner = new Scanner(text);
  scanner.run();
  const positions = new Positions(text);
  return scanner.comments.map((offset) => {
    const { line, column } = positions.at(offset);
    return comment(line, column);
  });
}
