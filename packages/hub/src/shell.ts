export type Dialect = "posix" | "powershell";

export const dialects: readonly Dialect[] = ["posix", "powershell"];

export const unknownMark = "\u0000";

export interface Word {
  readonly text: string;
  readonly dynamic: boolean;
}

export interface Redirect {
  readonly operator: string;
  target: Word | undefined;
  heredoc: string | undefined;
}

export interface SimpleCommand {
  readonly words: Word[];
  readonly redirects: Redirect[];
  readonly nested: string[];
  readonly pipedIn: boolean;
}

interface Balanced {
  readonly content: string;
  readonly end: number;
}

function balanced(text: string, start: number, open: string, close: string, escape: string): Balanced {
  let depth = 1;
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === escape) {
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === escape ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return { content: text.slice(start + 1, index), end: index + 1 };
      }
    }
    index += 1;
  }
  return { content: text.slice(start + 1), end: text.length };
}

class Builder {
  readonly commands: SimpleCommand[] = [];
  private current: SimpleCommand = { words: [], redirects: [], nested: [], pipedIn: false };
  private text = "";
  private dynamic = false;
  private active = false;
  private pendingRedirect: Redirect | undefined;
  private heredocs: { readonly redirect: Redirect; readonly strip: boolean }[] = [];

  get word(): string {
    return this.text;
  }

  get wordActive(): boolean {
    return this.active;
  }

  get wordDynamic(): boolean {
    return this.dynamic;
  }

  atCommandStart(): boolean {
    return (
      !this.active &&
      this.current.words.length === 0 &&
      this.current.redirects.length === 0 &&
      this.pendingRedirect === undefined
    );
  }

  append(text: string): void {
    this.text += text;
    this.active = true;
  }

  appendUnknown(): void {
    this.text += unknownMark;
    this.dynamic = true;
    this.active = true;
  }

  discardWord(): void {
    this.text = "";
    this.dynamic = false;
    this.active = false;
  }

  endWord(): void {
    if (!this.active) {
      return;
    }
    const word: Word = { text: this.text, dynamic: this.dynamic };
    this.discardWord();
    const redirect = this.pendingRedirect;
    if (redirect !== undefined) {
      redirect.target = word;
      this.pendingRedirect = undefined;
      if (redirect.operator === "<<" || redirect.operator === "<<-") {
        this.heredocs.push({ redirect, strip: redirect.operator === "<<-" });
      }
      return;
    }
    this.current.words.push(word);
  }

  redirect(operator: string): void {
    this.endWord();
    const redirect: Redirect = { operator, target: undefined, heredoc: undefined };
    this.current.redirects.push(redirect);
    this.pendingRedirect = redirect;
  }

  nested(text: string): void {
    this.current.nested.push(text);
  }

  separate(piped: boolean): void {
    this.endWord();
    this.pendingRedirect = undefined;
    const { words, redirects, nested } = this.current;
    if (words.length > 0 || redirects.length > 0 || nested.length > 0) {
      this.commands.push(this.current);
    }
    this.current = { words: [], redirects: [], nested: [], pipedIn: piped };
  }

  readHeredocs(text: string, start: number): number {
    let index = start;
    for (const { redirect, strip } of this.heredocs) {
      const delimiter = redirect.target?.text ?? "";
      const body: string[] = [];
      while (index < text.length) {
        const found = text.indexOf("\n", index);
        const lineEnd = found === -1 ? text.length : found;
        const line = text.slice(index, lineEnd).replace(/\r$/, "");
        index = lineEnd + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
          break;
        }
        body.push(line);
      }
      redirect.heredoc = body.join("\n");
    }
    this.heredocs = [];
    return Math.min(index, text.length);
  }

  finish(): SimpleCommand[] {
    this.separate(false);
    return this.commands;
  }
}

function windowsish(text: string): boolean {
  return /^(?:[A-Za-z]:|\.{1,2}|~)$/.test(text) || text.includes("\\");
}

function skipLine(text: string, index: number): number {
  const end = text.indexOf("\n", index);
  return end === -1 ? text.length : end;
}

function readPosixDollar(text: string, index: number, builder: Builder, quoted: boolean): number {
  const next = text[index + 1];
  if (next === "(") {
    if (text[index + 2] === "(") {
      builder.appendUnknown();
      return balanced(text, index + 1, "(", ")", "\\").end;
    }
    const inner = balanced(text, index + 1, "(", ")", "\\");
    builder.nested(inner.content);
    builder.appendUnknown();
    return inner.end;
  }
  if (next === "{") {
    builder.appendUnknown();
    return balanced(text, index + 1, "{", "}", "\\").end;
  }
  if (next === "'" && !quoted) {
    let position = index + 2;
    let value = "";
    while (position < text.length && text[position] !== "'") {
      if (text[position] === "\\" && position + 1 < text.length) {
        const escaped = text[position + 1] ?? "";
        value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        position += 2;
        continue;
      }
      value += text[position];
      position += 1;
    }
    builder.append(value);
    return position + 1;
  }
  if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) {
    let position = index + 1;
    if (/[A-Za-z_]/.test(next)) {
      while (position < text.length && /[A-Za-z0-9_]/.test(text[position] ?? "")) {
        position += 1;
      }
    } else {
      position += 1;
    }
    builder.appendUnknown();
    return position;
  }
  builder.append("$");
  return index + 1;
}

function readBacktick(text: string, index: number, builder: Builder): number {
  let position = index + 1;
  let content = "";
  while (position < text.length && text[position] !== "`") {
    if (text[position] === "\\" && position + 1 < text.length) {
      content += text[position + 1];
      position += 2;
      continue;
    }
    content += text[position];
    position += 1;
  }
  builder.nested(content);
  builder.appendUnknown();
  return position + 1;
}

function readPosixDouble(text: string, start: number, builder: Builder): number {
  builder.append("");
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      return index + 1;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next !== undefined && "$`\"\\\n".includes(next)) {
        if (next !== "\n") {
          builder.append(next);
        }
        index += 2;
        continue;
      }
      builder.append("\\");
      index += 1;
      continue;
    }
    if (char === "$") {
      index = readPosixDollar(text, index, builder, true);
      continue;
    }
    if (char === "`") {
      index = readBacktick(text, index, builder);
      continue;
    }
    builder.append(char ?? "");
    index += 1;
  }
  return index;
}

const posixRedirects = ["<<<", "<<-", "<<", "<>", "<&", "<", ">>", ">|", ">&", ">"];

function readPosixRedirect(text: string, index: number, builder: Builder): number {
  if (builder.wordActive && !builder.wordDynamic && /^\d+$/.test(builder.word)) {
    builder.discardWord();
  }
  const operator = posixRedirects.find((candidate) => text.startsWith(candidate, index)) ?? ">";
  let position = index + operator.length;
  if (operator === ">&" || operator === "<&") {
    const rest = /^(?:\d+|-)/.exec(text.slice(position));
    if (rest !== null) {
      builder.endWord();
      return position + rest[0].length;
    }
    builder.redirect(">");
    return position;
  }
  while (text[position] === " " || text[position] === "\t") {
    position += 1;
  }
  builder.redirect(operator);
  return position;
}

export function parsePosix(text: string): SimpleCommand[] {
  const builder = new Builder();
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === " " || char === "\t" || char === "\r") {
      builder.endWord();
      index += 1;
      continue;
    }
    if (char === "\n") {
      builder.separate(false);
      index = builder.readHeredocs(text, index + 1);
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        index += 1;
        continue;
      }
      if (next === "\n") {
        index += 2;
        continue;
      }
      if (next === "\r" && text[index + 2] === "\n") {
        index += 3;
        continue;
      }
      if (/[A-Za-z0-9._$-]/.test(next) && windowsish(builder.word)) {
        builder.append("\\");
        index += 1;
        continue;
      }
      builder.append(next);
      index += 2;
      continue;
    }
    if (char === "#" && !builder.wordActive) {
      index = skipLine(text, index);
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const stop = end === -1 ? text.length : end;
      builder.append(text.slice(index + 1, stop));
      index = stop + 1;
      continue;
    }
    if (char === '"') {
      index = readPosixDouble(text, index + 1, builder);
      continue;
    }
    if (char === "`") {
      index = readBacktick(text, index, builder);
      continue;
    }
    if (char === "$") {
      index = readPosixDollar(text, index, builder, false);
      continue;
    }
    if (char === ";") {
      builder.separate(false);
      index += 1;
      while (text[index] === ";" || text[index] === "&") {
        index += 1;
      }
      continue;
    }
    if (char === "&") {
      if (text[index + 1] === "&") {
        builder.separate(false);
        index += 2;
        continue;
      }
      if (text[index + 1] === ">") {
        const operator = text[index + 2] === ">" ? "&>>" : "&>";
        builder.redirect(operator);
        index += operator.length;
        continue;
      }
      builder.separate(false);
      index += 1;
      continue;
    }
    if (char === "|") {
      if (text[index + 1] === "|") {
        builder.separate(false);
        index += 2;
        continue;
      }
      builder.separate(true);
      index += text[index + 1] === "&" ? 2 : 1;
      continue;
    }
    if (char === "(") {
      const inner = balanced(text, index, "(", ")", "\\");
      if (builder.atCommandStart()) {
        builder.nested(inner.content);
      } else {
        builder.append(`(${inner.content})`);
      }
      index = inner.end;
      continue;
    }
    if (char === ")") {
      builder.separate(false);
      index += 1;
      continue;
    }
    if (char === "<" || char === ">") {
      if (text[index + 1] === "(") {
        const inner = balanced(text, index + 1, "(", ")", "\\");
        builder.nested(inner.content);
        builder.appendUnknown();
        index = inner.end;
        continue;
      }
      index = readPosixRedirect(text, index, builder);
      continue;
    }
    if ((char === "{" || char === "}") && builder.atCommandStart()) {
      const next = text[index + 1];
      if (next === undefined || /[\s;]/.test(next)) {
        index += 1;
        continue;
      }
    }
    builder.append(char);
    index += 1;
  }
  return builder.finish();
}

function powershellEscape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "0":
      return "";
    default:
      return char;
  }
}

function readPowershellDollar(text: string, index: number, builder: Builder): number {
  const next = text[index + 1];
  if (next === "(") {
    const inner = balanced(text, index + 1, "(", ")", "`");
    builder.nested(inner.content);
    builder.appendUnknown();
    return inner.end;
  }
  if (next === "{") {
    builder.appendUnknown();
    return balanced(text, index + 1, "{", "}", "`").end;
  }
  if (next !== undefined && /[A-Za-z0-9_?^$:]/.test(next)) {
    let position = index + 1;
    if (/[?^$]/.test(next)) {
      position += 1;
    } else {
      while (position < text.length && /[A-Za-z0-9_:]/.test(text[position] ?? "")) {
        position += 1;
      }
    }
    builder.appendUnknown();
    return position;
  }
  builder.append("$");
  return index + 1;
}

function readPowershellDouble(text: string, start: number, builder: Builder): number {
  builder.append("");
  let index = start;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      if (text[index + 1] === '"') {
        builder.append('"');
        index += 2;
        continue;
      }
      return index + 1;
    }
    if (char === "`") {
      builder.append(powershellEscape(text[index + 1] ?? ""));
      index += 2;
      continue;
    }
    if (char === "$") {
      index = readPowershellDollar(text, index, builder);
      continue;
    }
    builder.append(char);
    index += 1;
  }
  return index;
}

function readPowershellSingle(text: string, start: number, builder: Builder): number {
  builder.append("");
  let index = start;
  while (index < text.length) {
    if (text[index] === "'") {
      if (text[index + 1] === "'") {
        builder.append("'");
        index += 2;
        continue;
      }
      return index + 1;
    }
    builder.append(text[index] ?? "");
    index += 1;
  }
  return index;
}

function readHereString(text: string, index: number, builder: Builder): number {
  const quote = text[index + 1] ?? "'";
  const bodyStart = text.indexOf("\n", index) + 1;
  const terminator = `\n${quote}@`;
  const end = text.indexOf(terminator, bodyStart);
  const stop = end === -1 ? text.length : end;
  builder.append(text.slice(bodyStart, stop).replace(/\r$/, ""));
  if (quote === '"' && /\$[({A-Za-z_]/.test(text.slice(bodyStart, stop))) {
    builder.appendUnknown();
  }
  return end === -1 ? text.length : end + terminator.length;
}

export function parsePowershell(text: string): SimpleCommand[] {
  const builder = new Builder();
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === " " || char === "\t" || char === "\r") {
      builder.endWord();
      index += 1;
      continue;
    }
    if (char === "\n") {
      builder.separate(false);
      index += 1;
      continue;
    }
    if (char === "`") {
      const next = text[index + 1];
      if (next === "\n") {
        index += 2;
        continue;
      }
      if (next === "\r" && text[index + 2] === "\n") {
        index += 3;
        continue;
      }
      builder.append(powershellEscape(next ?? ""));
      index += 2;
      continue;
    }
    if (char === "#" && !builder.wordActive) {
      index = skipLine(text, index);
      continue;
    }
    if (char === "<" && text[index + 1] === "#") {
      const end = text.indexOf("#>", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === "'") {
      index = readPowershellSingle(text, index + 1, builder);
      continue;
    }
    if (char === '"') {
      index = readPowershellDouble(text, index + 1, builder);
      continue;
    }
    if (char === "@" && !builder.wordActive && (text[index + 1] === "'" || text[index + 1] === '"')) {
      const after = text.slice(index + 2).match(/^[ \t]*\r?\n/);
      if (after !== null) {
        index = readHereString(text, index, builder);
        continue;
      }
    }
    if (char === "@" && (text[index + 1] === "(" || text[index + 1] === "{")) {
      const open = text[index + 1] ?? "(";
      const inner = balanced(text, index + 1, open, open === "(" ? ")" : "}", "`");
      builder.nested(inner.content);
      builder.appendUnknown();
      index = inner.end;
      continue;
    }
    if (char === "$") {
      index = readPowershellDollar(text, index, builder);
      continue;
    }
    if (char === "{" && text[index + 1] === "}") {
      builder.append("{}");
      index += 2;
      continue;
    }
    if (char === "(" || char === "{") {
      const inner = balanced(text, index, char, char === "(" ? ")" : "}", "`");
      builder.nested(inner.content);
      builder.appendUnknown();
      index = inner.end;
      continue;
    }
    if (char === ")" || char === "}" || char === ";") {
      builder.separate(false);
      index += 1;
      continue;
    }
    if (char === "&") {
      builder.separate(false);
      index += text[index + 1] === "&" ? 2 : 1;
      continue;
    }
    if (char === "|") {
      if (text[index + 1] === "|") {
        builder.separate(false);
        index += 2;
        continue;
      }
      builder.separate(true);
      index += 1;
      continue;
    }
    if (char === ",") {
      builder.endWord();
      index += 1;
      continue;
    }
    if (char === ">" || char === "<") {
      if (builder.wordActive && !builder.wordDynamic && /^[\d*]$/.test(builder.word)) {
        builder.discardWord();
      }
      const operator = text.startsWith(">>", index) ? ">>" : char;
      index += operator.length;
      const duplicate = /^&\d/.exec(text.slice(index));
      if (duplicate !== null) {
        builder.endWord();
        index += duplicate[0].length;
        continue;
      }
      builder.redirect(operator);
      continue;
    }
    if (char === "-" && !builder.wordActive && text.startsWith("--%", index)) {
      builder.endWord();
      const end = skipLine(text, index);
      for (const part of text.slice(index + 3, end).split(/[ \t]+/)) {
        if (part !== "") {
          builder.append(part);
          builder.endWord();
        }
      }
      index = end;
      continue;
    }
    builder.append(char);
    index += 1;
  }
  return builder.finish();
}

export function parseScript(text: string, dialect: Dialect): SimpleCommand[] {
  return dialect === "posix" ? parsePosix(text) : parsePowershell(text);
}
