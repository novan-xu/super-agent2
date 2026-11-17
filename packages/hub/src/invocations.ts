import { type Location, locate } from "./paths.js";
import { type Dialect, dialects, parsePosix, parseScript, type Redirect, type SimpleCommand, unknownMark, variableMark, type Word } from "./shell.js";
import { cmdSpacesAsSpaces, foldLookAlikes, powershellDash } from "./unicode.js";

export interface Invocation {
  readonly program: string;
  readonly args: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly cwd: Location | undefined;
  readonly pipedIn: boolean;
  readonly dialect: Dialect;
}

export interface Expansion {
  readonly invocations: Invocation[];
  readonly texts: string[];
  readonly cwd: Location | undefined;
}

const maximumDepth = 8;

const unknownWord: Word = { text: unknownMark, dynamic: true };

export function programName(word: Word | undefined): string {
  if (word === undefined || word.dynamic) {
    return unknownMark;
  }
  const parts = word.text.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

const keywords = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time", "{", "function"]);

const assignment = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "yash"]);

const powershells = new Set(["powershell", "pwsh"]);

interface Wrapper {
  readonly values: readonly string[];
  readonly chdir?: readonly string[];
  readonly script?: readonly string[];
  readonly positional?: number;
  readonly numericFlags?: boolean;
}

const wrappers: Readonly<Record<string, Wrapper>> = {
  sudo: { values: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--other-user", "--command-timeout", "--close-from"], chdir: ["-D", "--chdir"] },
  doas: { values: ["-u", "-C"] },
  pkexec: { values: ["--user"] },
  env: { values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"], chdir: ["-C", "--chdir"], script: ["-S", "--split-string"] },
  nohup: { values: [] },
  exec: { values: ["-a"] },
  command: { values: [] },
  builtin: { values: [] },
  noglob: { values: [] },
  nocorrect: { values: [] },
  setsid: { values: [] },
  unbuffer: { values: [] },
  chronic: { values: [] },
  busybox: { values: [] },
  toybox: { values: [] },
  time: { values: ["-f", "--format", "-o", "--output"] },
  caffeinate: { values: ["-t", "-w"] },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  nice: { values: ["-n", "--adjustment"], numericFlags: true },
  ionice: { values: ["-c", "-n", "--class", "--classdata"] },
  timeout: { values: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  gosu: { values: [], positional: 1 },
  "su-exec": { values: [], positional: 1 },
  npx: { values: ["-p", "--package", "--cache", "--userconfig"], script: ["-c", "--call"] },
  pnpx: { values: [] },
  bunx: { values: ["-p", "--package"] },
};

const packageRunners = new Set(["pnpm", "yarn", "npm", "bun"]);

const xargsValues = ["-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--eof"];

const sshValues = ["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-E", "-b", "-c", "-e", "-m", "-O", "-Q", "-S", "-W", "-w", "-B", "-I"];

const dockerExecValues = ["-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--detach-keys", "--index"];

const powershellValues = new Set(["-executionpolicy", "-ex", "-ep", "-windowstyle", "-w", "-configurationname", "-config", "-workingdirectory", "-wd", "-outputformat", "-o", "-of", "-inputformat", "-if", "-inp", "-version", "-v", "-psconsolefile", "-settingsfile", "-custompipename"]);

interface Context {
  readonly out: Expansion;
  readonly depth: number;
  readonly temporaries: Set<string>;
}

export const temporaryVariable = "TMPDIR";

const madeByMktemp = "tmp.XXXXXXXXXX";

const declarations = new Set(["local", "export", "declare", "readonly", "typeset"]);

const mktempFlags = new Set(["-d", "-q", "-u", "-t", "--directory", "--quiet", "--dry-run"]);

function makesTemporary(script: string): boolean {
  const commands = parsePosix(script);
  const words = commands[0]?.words ?? [];
  if (commands.length !== 1 || programName(words[0]) !== "mktemp") {
    return false;
  }
  const args = words.slice(1);
  const flags = args.filter((word) => word.text.startsWith("-"));
  const operands = args.filter((word) => !word.text.startsWith("-"));
  if (args.some((word) => word.dynamic) || !flags.every((word) => mktempFlags.has(word.text))) {
    return false;
  }
  return operands.length === 0 || (flags.some((word) => word.text === "-t") && operands.every((word) => !/[\\/]/.test(word.text)));
}

function noteAssignments(command: SimpleCommand, temporaries: Set<string>): void {
  const words = command.words.filter((word, index) => index > 0 || !declarations.has(word.text));
  if (words.length === 0 || !words.every((word) => assignment.test(word.text))) {
    return;
  }
  for (const word of words) {
    const name = word.text.slice(0, word.text.indexOf("=")).replace(/\+$/, "");
    const value = word.text.slice(word.text.indexOf("=") + 1);
    const script = command.nested[0];
    if (value === unknownMark && command.nested.length === 1 && script !== undefined && makesTemporary(script)) {
      temporaries.add(name);
    } else {
      temporaries.delete(name);
    }
  }
}

function withTemporaries(word: Word, temporaries: ReadonlySet<string>): Word {
  if (!word.dynamic || temporaries.size === 0) {
    return word;
  }
  let text = word.text;
  for (const name of temporaries) {
    text = text.replaceAll(variableMark(name), `${variableMark(temporaryVariable)}/${madeByMktemp}`);
  }
  return text === word.text ? word : { text, dynamic: true };
}

function texts(words: readonly Word[]): string {
  return words.map((word) => word.text).join(" ");
}

function optionName(word: Word): string | undefined {
  if (word.dynamic || !word.text.startsWith("-") || word.text.length < 2) {
    return undefined;
  }
  return word.text.split("=")[0];
}

function walk(text: string, dialect: Dialect, cwd: Location | undefined, context: Context): void {
  if (context.depth > maximumDepth) {
    return;
  }
  context.out.texts.push(text);
  const folded = foldLookAlikes(text, dialect);
  if (folded !== text) {
    walk(folded, dialect, cwd, { out: context.out, depth: context.depth + 1, temporaries: new Set(context.temporaries) });
  }
  let current = cwd;
  for (const command of parseScript(text, dialect)) {
    const inner: Context = { ...context, depth: context.depth + 1 };
    for (const script of command.nested) {
      walk(script, dialect, current, inner);
    }
    noteAssignments(command, context.temporaries);
    for (const redirect of command.redirects) {
      if (redirect.heredoc !== undefined) {
        context.out.texts.push(redirect.heredoc);
      }
    }
    current = visit(command.words, command.redirects, command.pipedIn, dialect, current, context);
  }
}

function walkAll(text: string, cwd: Location | undefined, context: Context): void {
  for (const dialect of dialects) {
    walk(text, dialect, cwd, { out: context.out, depth: context.depth + 1, temporaries: new Set() });
  }
}

function stripWrapper(words: Word[], wrapper: Wrapper, cwd: Location | undefined, dialect: Dialect, context: Context): { words: Word[]; cwd: Location | undefined; done: boolean } {
  let index = 1;
  let dir = cwd;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) {
      break;
    }
    if (word.text === "--" && !word.dynamic) {
      index += 1;
      break;
    }
    const name = optionName(word);
    if (name === undefined) {
      if (!word.dynamic && assignment.test(word.text)) {
        index += 1;
        continue;
      }
      break;
    }
    if (wrapper.numericFlags === true && /^-\d+$/.test(word.text)) {
      index += 1;
      continue;
    }
    const inline = word.text.includes("=") && name.startsWith("--") ? word.text.slice(name.length + 1) : undefined;
    const attached = !name.startsWith("--") && name.length > 2 && wrapper.values.includes(name.slice(0, 2)) ? name.slice(2) : undefined;
    const key = attached === undefined ? name : name.slice(0, 2);
    if (wrapper.values.includes(key)) {
      let value: Word | undefined;
      if (inline !== undefined) {
        value = { text: inline, dynamic: word.dynamic };
      } else if (attached !== undefined) {
        value = { text: attached, dynamic: word.dynamic };
      } else {
        index += 1;
        value = words[index];
      }
      if (value !== undefined && wrapper.chdir?.includes(key) === true) {
        dir = locate(value.text, dir);
        if (!dir.known) {
          dir = undefined;
        }
      }
      if (value !== undefined && wrapper.script?.includes(key) === true) {
        walk(value.text, dialect, dir, { ...context, depth: context.depth + 1 });
        return { words: [], cwd, done: true };
      }
    }
    index += 1;
  }
  index += wrapper.positional ?? 0;
  return { words: words.slice(index), cwd: dir, done: false };
}

function stripXargs(words: Word[]): Word[] {
  let index = 1;
  let replace: string | undefined;
  while (index < words.length) {
    const word = words[index];
    const name = word === undefined ? undefined : optionName(word);
    if (word === undefined || name === undefined) {
      break;
    }
    if (word.text === "--") {
      index += 1;
      break;
    }
    if (name === "-I") {
      replace = word.text.length > 2 ? word.text.slice(2) : words[index + 1]?.text;
      index += word.text.length > 2 ? 1 : 2;
      continue;
    }
    if (name.startsWith("-i") || name.startsWith("--replace")) {
      replace = word.text.includes("=") ? word.text.split("=")[1] : word.text.length > 2 && !name.startsWith("--") ? word.text.slice(2) : "{}";
      index += 1;
      continue;
    }
    index += xargsValues.includes(name) && !word.text.includes("=") && (name.startsWith("--") || word.text.length === 2) ? 2 : 1;
  }
  const rest = words.slice(index);
  const command = rest.length === 0 ? [{ text: "echo", dynamic: false }] : rest;
  if (replace === undefined || replace === "") {
    return [...command, unknownWord];
  }
  const marker = replace;
  return command.map((word) => (word.text.includes(marker) ? { text: word.text.replaceAll(marker, unknownMark), dynamic: true } : word));
}

function shellScript(args: readonly Word[]): { script: Word | undefined; hasOperand: boolean } {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined || word.dynamic) {
      return { script: undefined, hasOperand: true };
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word.text) || word.text === "--command") {
      return { script: args[index + 1], hasOperand: true };
    }
    if (word.text === "-o" || word.text === "-O" || word.text === "+O" || word.text === "--rcfile" || word.text === "--init-file") {
      index += 1;
      continue;
    }
    if (!word.text.startsWith("-") && !word.text.startsWith("+")) {
      return { script: undefined, hasOperand: true };
    }
  }
  return { script: undefined, hasOperand: false };
}

function isPrefix(name: string, full: string, minimum: number): boolean {
  return name.length >= minimum && full.startsWith(name);
}

function powershellScript(args: readonly Word[], cwd: Location | undefined, context: Context): { cwd: Location | undefined } {
  let dir = cwd;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) {
      break;
    }
    const text = powershellDash.has(word.text[0]) ? `-${word.text.slice(1)}` : word.text;
    const name = text.toLowerCase().split(":")[0] ?? "";
    if (!text.startsWith("-") && !text.startsWith("/")) {
      walk(texts(args.slice(index)), "powershell", dir, { ...context, depth: context.depth + 1 });
      return { cwd: dir };
    }
    const bare = name.replace(/^[-/]+/, "");
    if (bare === "c" || isPrefix(bare, "command", 2)) {
      walk(texts(args.slice(index + 1)), "powershell", dir, { ...context, depth: context.depth + 1 });
      return { cwd: dir };
    }
    if (bare === "e" || bare === "ec" || isPrefix(bare, "encodedcommand", 2)) {
      const encoded = args[index + 1];
      if (encoded !== undefined && !encoded.dynamic) {
        walk(Buffer.from(encoded.text, "base64").toString("utf16le"), "powershell", dir, { ...context, depth: context.depth + 1 });
      }
      return { cwd: dir };
    }
    if (bare === "f" || isPrefix(bare, "file", 2)) {
      return { cwd: dir };
    }
    if (powershellValues.has(`-${bare}`)) {
      const value = args[index + 1];
      if ((bare === "wd" || isPrefix(bare, "workingdirectory", 2)) && value !== undefined) {
        const next = locate(value.text, dir);
        dir = next.known ? next : undefined;
      }
      index += 1;
    }
  }
  return { cwd: dir };
}

function leadingOptions(args: readonly Word[], values: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    if (word === undefined || word.dynamic || !word.text.startsWith("-") || word.text === "-") {
      break;
    }
    if (word.text === "--") {
      return index + 1;
    }
    index += values.includes(word.text) ? 2 : 1;
  }
  return index;
}

function sshCommand(args: readonly Word[]): Word[] {
  return args.slice(leadingOptions(args, sshValues) + 1);
}

function dockerExecCommand(args: readonly Word[]): Word[] | undefined {
  const subcommand = args.findIndex((word) => word.text === "exec");
  if (subcommand === -1) {
    return undefined;
  }
  let index = subcommand + 1;
  while (index < args.length) {
    const word = args[index];
    if (word === undefined || !word.text.startsWith("-") || word.dynamic) {
      break;
    }
    index += dockerExecValues.includes(word.text) ? 2 : 1;
  }
  return args.slice(index + 1);
}

function findRoots(args: readonly Word[]): { roots: Word[]; expression: number } {
  let index = 0;
  while (index < args.length && /^-(?:H|L|P|O\d*|D)$/.test(args[index]?.text ?? "")) {
    index += args[index]?.text === "-D" ? 2 : 1;
  }
  const roots: Word[] = [];
  while (index < args.length) {
    const word = args[index];
    if (word === undefined || (!word.dynamic && /^[-(!)]/.test(word.text))) {
      break;
    }
    roots.push(word);
    index += 1;
  }
  return { roots: roots.length === 0 ? [{ text: ".", dynamic: false }] : roots, expression: index };
}

function findCommands(args: readonly Word[]): { words: Word[]; roots: Word[] }[] {
  const { roots, expression } = findRoots(args);
  const found: { words: Word[]; roots: Word[] }[] = [];
  for (let index = expression; index < args.length; index += 1) {
    const word = args[index];
    if (word !== undefined && /^-(?:exec|execdir|ok|okdir)$/.test(word.text)) {
      const words: Word[] = [];
      index += 1;
      while (index < args.length && args[index]?.text !== ";" && args[index]?.text !== "+") {
        const inner = args[index];
        if (inner !== undefined) {
          words.push(inner);
        }
        index += 1;
      }
      found.push({ words, roots });
    }
  }
  return found;
}

export function findRootWords(args: readonly Word[]): Word[] {
  return findRoots(args).roots;
}

function changeDirectory(program: string, args: readonly Word[], cwd: Location | undefined): Location | undefined {
  if (program === "popd" || program === "pop-location") {
    return undefined;
  }
  let target: Word | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) {
      break;
    }
    const lower = word.text.toLowerCase();
    if (lower === "-path" || lower === "-literalpath" || lower === "-lp") {
      target = args[index + 1];
      break;
    }
    if (word.text.startsWith("-") && word.text !== "-" && !word.dynamic) {
      continue;
    }
    target = word;
    break;
  }
  if (target === undefined || target.text === "-") {
    return undefined;
  }
  const next = locate(target.text, cwd);
  return next.known ? next : undefined;
}

const directoryChanges = new Set(["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location"]);

function visit(
  original: readonly Word[],
  redirects: readonly Redirect[],
  pipedIn: boolean,
  dialect: Dialect,
  cwd: Location | undefined,
  context: Context,
): Location | undefined {
  let words = original.map((word) => withTemporaries(word, context.temporaries));
  let dir = cwd;
  const inner: Context = { ...context, depth: context.depth + 1 };
  for (let guard = 0; guard < 32; guard += 1) {
    const first = words[0];
    if (first === undefined) {
      break;
    }
    if (dialect === "posix" && !first.dynamic && assignment.test(first.text)) {
      words = words.slice(1);
      continue;
    }
    if (!first.dynamic && keywords.has(first.text)) {
      words = words.slice(1);
      continue;
    }
    const name = programName(first);
    if (name === "xargs") {
      words = stripXargs(words);
      continue;
    }
    if (packageRunners.has(name) && (words[1]?.text === "dlx" || words[1]?.text === "exec" || words[1]?.text === "x")) {
      words = words.slice(2).filter((word, index) => index > 0 || word.text !== "--");
      continue;
    }
    const wrapper = wrappers[name];
    if (wrapper !== undefined) {
      if (name === "command" && (words[1]?.text === "-v" || words[1]?.text === "-V")) {
        return dir;
      }
      const stripped = stripWrapper(words, wrapper, dir, dialect, context);
      if (stripped.done) {
        return dir;
      }
      words = stripped.words;
      dir = stripped.cwd;
      continue;
    }
    break;
  }
  if (words.length === 0 && redirects.length === 0) {
    return dir;
  }
  const program = words.length === 0 ? "" : programName(words[0]);
  const args = words.slice(1);
  context.out.invocations.push({ program, args, redirects, cwd: dir, pipedIn, dialect });
  if (shells.has(program)) {
    const { script, hasOperand } = shellScript(args);
    if (script !== undefined) {
      walk(script.text, "posix", dir, inner);
    } else if (!hasOperand) {
      for (const redirect of redirects) {
        if (redirect.heredoc !== undefined) {
          walk(redirect.heredoc, "posix", dir, inner);
        }
      }
    }
  } else if (powershells.has(program)) {
    powershellScript(args, dir, context);
  } else if (program === "cmd") {
    const index = args.findIndex((word) => /^\/[ck]/i.test(word.text));
    if (index !== -1) {
      const head = args[index]?.text.slice(2) ?? "";
      walk(cmdSpacesAsSpaces([head, texts(args.slice(index + 1))].join(" ")).trim(), "posix", dir, inner);
    }
  } else if (program === "ssh") {
    const remote = sshCommand(args);
    if (remote.length > 0) {
      walkAll(texts(remote), undefined, context);
    } else {
      for (const redirect of redirects) {
        if (redirect.heredoc !== undefined) {
          walkAll(redirect.heredoc, undefined, context);
        }
      }
    }
  } else if (program === "su" || program === "runuser") {
    const index = args.findIndex((word) => word.text === "-c" || word.text === "--command" || word.text.startsWith("--command="));
    const script = index === -1 ? undefined : args[index]?.text.startsWith("--command=") === true ? args[index]?.text.slice(10) : args[index + 1]?.text;
    if (script !== undefined) {
      walk(script, "posix", undefined, inner);
    }
  } else if (program === "eval") {
    walk(texts(args), "posix", dir, inner);
  } else if (program === "iex" || program === "invoke-expression") {
    const rest = args.filter((word) => word.text.toLowerCase() !== "-command");
    walk(texts(rest), "powershell", dir, inner);
  } else if (program === "watch") {
    walk(texts(args.slice(leadingOptions(args, ["-n", "--interval", "-q", "--equexit"]))), "posix", dir, inner);
  } else if (program === "flock") {
    const index = args.findIndex((word) => word.text === "-c" || word.text === "--command");
    const script = index === -1 ? undefined : args[index + 1];
    if (script !== undefined) {
      walk(script.text, "posix", dir, inner);
    } else {
      visit(args.slice(leadingOptions(args, ["-w", "--timeout", "-E", "--conflict-exit-code"]) + 1), [], false, dialect, dir, inner);
    }
  } else if (["docker", "podman", "nerdctl", "docker-compose", "podman-compose"].includes(program)) {
    const remote = dockerExecCommand(args);
    if (remote !== undefined && remote.length > 0) {
      visit(remote, [], false, dialect, undefined, inner);
    }
  } else if (program === "kubectl") {
    const separator = args.findIndex((word) => word.text === "--");
    if (args.some((word) => word.text === "exec") && separator !== -1) {
      visit(args.slice(separator + 1), [], false, dialect, undefined, inner);
    }
  } else if (program === "find") {
    for (const found of findCommands(args)) {
      const placeholder = found.words.some((word) => word.text.includes("{}"));
      for (const root of found.roots) {
        const replaced = found.words.map((word) =>
          word.text.includes("{}") ? { text: word.text.replaceAll("{}", root.text), dynamic: word.dynamic || root.dynamic } : word,
        );
        visit(placeholder ? replaced : [...replaced, root], [], false, dialect, dir, inner);
      }
    }
  }
  if (directoryChanges.has(program)) {
    return changeDirectory(program, args, dir);
  }
  return dir;
}

export function expand(text: string, cwd: Location | undefined): Expansion {
  const out: Expansion = { invocations: [], texts: [], cwd };
  for (const dialect of dialects) {
    walk(text, dialect, cwd, { out, depth: 0, temporaries: new Set() });
  }
  return out;
}
