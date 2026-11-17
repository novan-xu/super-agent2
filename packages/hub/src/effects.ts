import { findRootWords, type Invocation } from "./invocations.js";
import { baseName, join, type Location, locate, parent } from "./paths.js";
import { unknownMark, type Word } from "./shell.js";

export interface ApiRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
  readonly bodyUnknown: boolean;
}

export interface Refspec {
  readonly forced: boolean;
  readonly destination: string | undefined;
  readonly deletion: boolean;
}

export interface Push {
  readonly forced: boolean;
  readonly everything: boolean;
  readonly refspecs: readonly Refspec[];
}

export type Effect =
  | { readonly kind: "delete"; readonly target: Location; readonly contents: boolean }
  | { readonly kind: "write"; readonly target: Location }
  | { readonly kind: "relocate"; readonly target: Location }
  | { readonly kind: "request"; readonly request: ApiRequest }
  | { readonly kind: "push"; readonly push: Push };

interface Parsed {
  readonly flags: readonly string[];
  readonly options: ReadonlyMap<string, readonly Word[]>;
  readonly operands: readonly Word[];
}

interface Spec {
  readonly values?: readonly string[];
  readonly caseless?: boolean;
  readonly attached?: boolean;
}

function parseArgs(args: readonly Word[], spec: Spec = {}): Parsed {
  const values = new Set((spec.values ?? []).map((value) => (spec.caseless === true ? value.toLowerCase() : value)));
  const flags: string[] = [];
  const options = new Map<string, Word[]>();
  const operands: Word[] = [];
  const add = (name: string, value: Word) => options.set(name, [...(options.get(name) ?? []), value]);
  let ended = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) {
      break;
    }
    if (ended || !word.text.startsWith("-") || word.text === "-") {
      operands.push(word);
      continue;
    }
    if (word.text === "--") {
      ended = true;
      continue;
    }
    const text = spec.caseless === true ? word.text.toLowerCase() : word.text;
    const long = text.startsWith("--");
    const equals = text.indexOf("=");
    const colon = !long ? text.indexOf(":") : -1;
    if (long && equals !== -1) {
      const name = text.slice(0, equals);
      if (values.has(name)) {
        add(name, { text: word.text.slice(equals + 1), dynamic: word.dynamic });
      } else {
        flags.push(text);
      }
      continue;
    }
    if (colon > 1 && values.has(text.slice(0, colon))) {
      add(text.slice(0, colon), { text: word.text.slice(colon + 1), dynamic: word.dynamic });
      continue;
    }
    if (values.has(text)) {
      const value = args[index + 1];
      if (value !== undefined) {
        add(text, value);
        index += 1;
      }
      continue;
    }
    if (spec.attached === true && !long && text.length > 2 && values.has(text.slice(0, 2))) {
      add(text.slice(0, 2), { text: word.text.slice(2), dynamic: word.dynamic });
      continue;
    }
    flags.push(text);
  }
  return { flags, options, operands };
}

function hasFlag(parsed: Parsed, names: readonly string[], letters = ""): boolean {
  return parsed.flags.some(
    (flag) =>
      names.some((name) => flag === name || flag.startsWith(`${name}=`)) ||
      (letters !== "" && /^-[A-Za-z]+$/.test(flag) && [...letters].some((letter) => flag.includes(letter))),
  );
}

function option(parsed: Parsed, names: readonly string[]): Word[] {
  return names.flatMap((name) => [...(parsed.options.get(name) ?? [])]);
}

function lastOption(parsed: Parsed, names: readonly string[]): Word | undefined {
  const found = option(parsed, names);
  return found[found.length - 1];
}

const unknownLocation: Location = { known: false, text: unknownMark };

const commonPowershellValues = [
  "-erroraction",
  "-ea",
  "-warningaction",
  "-wa",
  "-informationaction",
  "-infa",
  "-errorvariable",
  "-ev",
  "-warningvariable",
  "-wv",
  "-informationvariable",
  "-iv",
  "-outvariable",
  "-ov",
  "-outbuffer",
  "-ob",
  "-pipelinevariable",
  "-pv",
  "-progressaction",
  "-proga",
  "-credential",
  "-include",
  "-exclude",
  "-filter",
  "-stream",
];

const pathOptions = ["-path", "-literalpath", "-lp", "-pspath"];

const deletePrograms = new Set(["rm", "unlink", "shred", "srm", "wipe", "rimraf", "del", "erase", "rd", "rmdir", "remove-item", "ri"]);

const cmdStyle = new Set(["del", "erase", "rd", "rmdir"]);

function deletions(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, { values: [...pathOptions, ...commonPowershellValues, "-n", "--iterations", "-s", "--size", "--random-source"], caseless: true });
  let targets = [...parsed.operands, ...option(parsed, pathOptions)];
  if (cmdStyle.has(invocation.program)) {
    targets = targets.filter((word) => !/^\/[a-z](?::.*)?$/i.test(word.text));
  }
  if (targets.length === 0) {
    return invocation.pipedIn ? [{ kind: "delete", target: unknownLocation, contents: false }] : [];
  }
  return targets.map((word) => ({ kind: "delete", target: locate(word.text, invocation.cwd), contents: false }));
}

function findDeletions(invocation: Invocation): Effect[] {
  if (!invocation.args.some((word) => word.text === "-delete")) {
    return [];
  }
  return findRootWords(invocation.args).map((word) => ({ kind: "delete", target: locate(word.text, invocation.cwd), contents: false }));
}

function remoteAware(text: string, cwd: Location | undefined): Location {
  const remote = /^(?:rsync:\/\/[^/]+\/|[^/\\:]{2,}:)(.*)$/.exec(text);
  if (remote !== null && !/^[A-Za-z]:[\\/]/.test(text)) {
    return { known: false, text: remote[1] ?? text };
  }
  return locate(text, cwd);
}

const rsyncValues = ["-e", "--rsh", "-f", "--filter", "--exclude", "--include", "--files-from", "--exclude-from", "--include-from", "--chmod", "--chown", "--backup-dir", "--suffix", "--log-file", "--password-file", "--port", "--timeout", "--bwlimit", "--rsync-path", "-T", "--temp-dir", "--partial-dir", "--compare-dest", "--copy-dest", "--link-dest", "--max-size", "--min-size", "-B", "--block-size", "-M", "--remote-option"];

function mayBeFolder(text: string, sources: number, explicit: boolean): boolean {
  return explicit || sources > 1 || /[\\/]$/.test(text) || !baseName(text).includes(".") || baseName(text).startsWith(".");
}

function rsync(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, { values: rsyncValues });
  const operands = parsed.operands;
  const destination = operands[operands.length - 1];
  if (destination === undefined || operands.length < 2) {
    return [];
  }
  const target = remoteAware(destination.text, invocation.cwd);
  const sources = operands.slice(0, -1);
  const effects: Effect[] = [{ kind: "write", target }];
  for (const source of sources) {
    effects.push({ kind: "write", target: join(target, baseName(source.text)) });
  }
  if (parsed.flags.some((flag) => flag.startsWith("--delete") || flag === "--del")) {
    effects.push({ kind: "delete", target, contents: true });
  }
  if (hasFlag(parsed, ["--remove-source-files"])) {
    for (const source of sources) {
      effects.push({ kind: "delete", target: remoteAware(source.text, invocation.cwd), contents: false });
    }
  }
  return effects;
}

const gitGlobalValues = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"];

const defaultHead = new Set(["HEAD", "@"]);

function branchOf(text: string): string | undefined {
  if (text === "" || defaultHead.has(text) || text.includes("*") || text.includes(unknownMark) || /^[0-9a-f]{7,40}$/.test(text)) {
    return undefined;
  }
  if (text.startsWith("refs/heads/")) {
    return text.slice("refs/heads/".length);
  }
  if (text.startsWith("refs/")) {
    return `\u0001${text}`;
  }
  return text.replace(/^heads\//, "");
}

function refspec(word: Word, forced: boolean, deleting: boolean): Refspec {
  if (word.dynamic) {
    return { forced, destination: undefined, deletion: deleting };
  }
  const plus = word.text.startsWith("+");
  const text = plus ? word.text.slice(1) : word.text;
  if (deleting) {
    return { forced: forced || plus, destination: branchOf(text), deletion: true };
  }
  const colon = text.indexOf(":");
  if (colon === -1) {
    return { forced: forced || plus, destination: branchOf(text), deletion: false };
  }
  const source = text.slice(0, colon);
  const destination = text.slice(colon + 1);
  if (destination === "") {
    return { forced: true, destination: source === "" ? undefined : branchOf(source), deletion: false };
  }
  return { forced: forced || plus, destination: branchOf(destination), deletion: source === "" };
}

function git(invocation: Invocation): Effect[] {
  const args = invocation.args;
  let index = 0;
  let dir = invocation.cwd;
  while (index < args.length) {
    const word = args[index];
    if (word === undefined || !word.text.startsWith("-")) {
      break;
    }
    const name = word.text.split("=")[0] ?? "";
    const inline = word.text.includes("=") && name.startsWith("--") ? word.text.slice(name.length + 1) : undefined;
    const value = inline ?? (gitGlobalValues.includes(name) ? args[index + 1]?.text : undefined);
    if ((name === "-C" || name === "--work-tree") && value !== undefined) {
      const next = locate(value, dir);
      dir = next.known ? next : undefined;
    }
    index += gitGlobalValues.includes(name) && inline === undefined ? 2 : 1;
  }
  const subcommand = args[index]?.text;
  const rest = args.slice(index + 1);
  if (subcommand === "clean") {
    const parsed = parseArgs(rest, { values: ["-e", "--exclude"] });
    if (!hasFlag(parsed, ["--force"], "f") || hasFlag(parsed, ["--dry-run"], "n")) {
      return [];
    }
    const targets = parsed.operands.length === 0 ? [{ text: ".", dynamic: false }] : parsed.operands;
    return targets.map((word) => ({ kind: "delete", target: locate(word.text, dir), contents: true }));
  }
  if (subcommand === "push") {
    const parsed = parseArgs(rest, { values: ["-o", "--push-option", "--repo", "--receive-pack", "--exec"] });
    if (hasFlag(parsed, ["--dry-run"], "n")) {
      return [];
    }
    const mirror = hasFlag(parsed, ["--mirror"]);
    const forced = mirror || hasFlag(parsed, ["--force", "--force-with-lease"], "f");
    const deleting = hasFlag(parsed, ["--delete"], "d");
    const everything = mirror || hasFlag(parsed, ["--all", "--branches"]);
    const refspecs = parsed.operands.slice(1).map((word) => refspec(word, forced, deleting));
    return [{ kind: "push", push: { forced, everything, refspecs } }];
  }
  return [];
}

function destinationWrites(invocation: Invocation, relocate: boolean): Effect[] {
  const parsed = parseArgs(invocation.args, {
    values: ["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-destination", "-newname", ...pathOptions, ...commonPowershellValues],
    caseless: true,
  });
  const explicit = lastOption(parsed, ["-destination", "-t", "--target-directory"]);
  const named = option(parsed, pathOptions);
  const operands = [...named, ...parsed.operands];
  const destination = explicit ?? (operands.length >= 2 ? operands[operands.length - 1] : undefined);
  const sources = explicit === undefined ? operands.slice(0, -1) : operands;
  const effects: Effect[] = [];
  if (destination !== undefined) {
    const target = remoteAware(destination.text, invocation.cwd);
    effects.push({ kind: "write", target });
    if (mayBeFolder(destination.text, sources.length, explicit !== undefined)) {
      for (const source of sources) {
        effects.push({ kind: "write", target: join(target, baseName(source.text)) });
      }
    }
  }
  if (relocate) {
    for (const source of sources) {
      effects.push({ kind: "relocate", target: locate(source.text, invocation.cwd) });
    }
  }
  return effects;
}

function rename(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, { values: [...pathOptions, "-newname", ...commonPowershellValues], caseless: true });
  const path = option(parsed, pathOptions)[0] ?? parsed.operands[0];
  const name = lastOption(parsed, ["-newname"]) ?? parsed.operands[option(parsed, pathOptions).length > 0 ? 0 : 1];
  if (path === undefined) {
    return [];
  }
  const source = locate(path.text, invocation.cwd);
  const effects: Effect[] = [{ kind: "relocate", target: source }];
  if (name !== undefined) {
    effects.push({ kind: "write", target: join(parent(source), name.text) });
  }
  return effects;
}

function operandWrites(invocation: Invocation, values: readonly string[], skip = 0): Effect[] {
  const parsed = parseArgs(invocation.args, { values, caseless: true });
  return parsed.operands.slice(skip).map((word) => ({ kind: "write", target: locate(word.text, invocation.cwd) }));
}

function inPlace(invocation: Invocation): Effect[] {
  const perl = invocation.program !== "sed";
  const parsed = parseArgs(invocation.args, { values: perl ? ["-e", "-E", "-I", "-M", "-m"] : ["-e", "--expression", "-f", "--file", "-l", "--line-length"] });
  const editing = parsed.flags.some((flag) => flag.startsWith("--in-place") || /^-[A-Za-z]*i/.test(flag));
  if (!editing) {
    return [];
  }
  const scripted = option(parsed, perl ? ["-e", "-E"] : ["-e", "--expression", "-f", "--file"]).length > 0;
  return parsed.operands.slice(scripted ? 0 : 1).map((word) => ({ kind: "write", target: locate(word.text, invocation.cwd) }));
}

function dd(invocation: Invocation): Effect[] {
  const effects: Effect[] = [];
  for (const word of invocation.args) {
    if (word.text.startsWith("of=")) {
      const target = locate(word.text.slice(3), invocation.cwd);
      effects.push({ kind: "write", target });
      if (/^\/dev\/(?!null$|zero$|stdout$|stderr$|tty$|fd\/)/.test(word.text.slice(3))) {
        effects.push({ kind: "delete", target, contents: true });
      }
    }
  }
  return effects;
}

function powershellWrites(invocation: Invocation, fileOptions: readonly string[], extraValues: readonly string[]): Effect[] {
  const parsed = parseArgs(invocation.args, { values: [...fileOptions, ...extraValues, ...commonPowershellValues], caseless: true });
  const path = option(parsed, fileOptions)[0] ?? parsed.operands[0];
  if (path === undefined) {
    return [];
  }
  const name = lastOption(parsed, ["-name"]);
  const base = locate(path.text, invocation.cwd);
  return [{ kind: "write", target: name === undefined ? base : join(base, name.text) }];
}

const sshKeygenValues = ["-f", "-t", "-b", "-C", "-N", "-P", "-a", "-O", "-Z", "-I", "-n", "-V", "-z", "-s", "-D", "-E", "-m", "-w", "-Y", "-r", "-R", "-F", "-G", "-K", "-S", "-M", "-J", "-j", "-W"];

function sshKeygen(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, { values: sshKeygenValues, attached: true });
  const reading = ["-l", "-y", "-B", "-L", "-Q", "-H", "-k", "-A"].some((name) => hasFlag(parsed, [name])) || ["-F", "-R", "-r", "-D", "-Y", "-G", "-K", "-s"].some((name) => parsed.options.has(name));
  if (reading) {
    return [];
  }
  const file = lastOption(parsed, ["-f"]);
  const type = lastOption(parsed, ["-t"])?.text ?? "rsa";
  return [{ kind: "write", target: locate(file?.text ?? `~/.ssh/id_${type}`, invocation.cwd) }];
}

function openssl(invocation: Invocation): Effect[] {
  const effects: Effect[] = [];
  invocation.args.forEach((word, index) => {
    const value = invocation.args[index + 1];
    if ((word.text === "-out" || word.text === "-keyout") && value !== undefined) {
      effects.push({ kind: "write", target: locate(value.text, invocation.cwd) });
    }
  });
  return effects;
}

function splitUrl(text: string, defaultHost: string): { host: string; path: string } {
  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hasHost = withoutScheme !== text || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$)/i.test(withoutScheme);
  const slash = withoutScheme.indexOf("/");
  const host = hasHost ? (slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)) : defaultHost;
  const rest = hasHost ? (slash === -1 ? "" : withoutScheme.slice(slash)) : withoutScheme;
  const path = rest
    .split(/[?#]/)[0]
    ?.replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase() ?? "";
  return { host: host.toLowerCase().replace(/:\d+$/, ""), path };
}

function fieldsOf(words: readonly Word[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const word of words) {
    const equals = word.text.indexOf("=");
    if (equals > 0) {
      fields.set(word.text.slice(0, equals).toLowerCase(), word.dynamic ? unknownMark : word.text.slice(equals + 1));
    }
  }
  return fields;
}

function request(method: string, url: string, defaultHost: string, fields: Map<string, string>, body: string, bodyUnknown: boolean): Effect {
  const { host, path } = splitUrl(url, defaultHost);
  return { kind: "request", request: { method: method.toUpperCase(), host, path, fields, body, bodyUnknown } };
}

const ghApiValues = ["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache"];

function gh(invocation: Invocation): Effect[] {
  if (invocation.args[0]?.text !== "api") {
    return [];
  }
  const parsed = parseArgs(invocation.args.slice(1), { values: ghApiValues, attached: true });
  const endpoint = parsed.operands[0];
  if (endpoint === undefined) {
    return [];
  }
  const fieldWords = option(parsed, ["-f", "--raw-field", "-F", "--field"]);
  const input = option(parsed, ["--input"]).length > 0;
  const method = lastOption(parsed, ["-X", "--method"])?.text ?? (fieldWords.length > 0 || input ? "POST" : "GET");
  const fields = fieldsOf(fieldWords);
  const host = lastOption(parsed, ["--hostname"])?.text ?? "api.github.com";
  return [request(method, endpoint.text, host, fields, fieldWords.map((word) => word.text).join("\n"), input || endpoint.dynamic)];
}

const curlValues = ["-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "-F", "--form", "--form-string", "-T", "--upload-file", "--url", "-H", "--header", "-A", "--user-agent", "-b", "--cookie", "-c", "--cookie-jar", "-e", "--referer", "-o", "--output", "-u", "--user", "-w", "--write-out", "-m", "--max-time", "-x", "--proxy", "-E", "--cert", "--key", "--cacert", "-K", "--config", "-r", "--range", "-y", "-Y", "-z", "-C", "-D", "--dump-header", "-U", "--proxy-user", "-Q", "--quote", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--resolve", "--interface", "--limit-rate", "--oauth2-bearer", "--aws-sigv4", "--variable", "--expand-url"];

const urlLike = /^(?:https?:\/\/|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/)/i;

function curl(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, { values: curlValues, attached: true });
  const data = option(parsed, ["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "-F", "--form", "--form-string"]);
  const upload = option(parsed, ["-T", "--upload-file"]).length > 0;
  const unknownBody = upload || data.some((word) => word.dynamic || (word.text.startsWith("@") && word.text !== "@-") || word.text === "@-");
  const explicit = lastOption(parsed, ["-X", "--request"])?.text;
  const method = explicit ?? (hasFlag(parsed, ["--get"], "G") ? "GET" : hasFlag(parsed, ["--head"], "I") ? "HEAD" : upload ? "PUT" : data.length > 0 ? "POST" : "GET");
  const urls = [...option(parsed, ["--url"]), ...parsed.operands.filter((word) => urlLike.test(word.text))];
  const body = data.map((word) => word.text).join("&");
  return urls.map((url) => request(method, url.text, "", fieldsOf(data), body, unknownBody));
}

function wget(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, { values: ["--method", "--body-data", "--post-data", "--body-file", "--post-file", "-O", "--output-document", "-o", "--output-file", "--header", "-U", "--user-agent"] });
  const body = option(parsed, ["--body-data", "--post-data"]);
  const unknownBody = option(parsed, ["--body-file", "--post-file"]).length > 0 || body.some((word) => word.dynamic);
  const method = lastOption(parsed, ["--method"])?.text ?? (body.length > 0 || unknownBody ? "POST" : "GET");
  return parsed.operands
    .filter((word) => urlLike.test(word.text))
    .map((url) => request(method, url.text, "", new Map(), body.map((word) => word.text).join("&"), unknownBody));
}

const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function httpie(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, { values: ["-a", "--auth", "-A", "--auth-type", "-o", "--output", "--session", "--verify", "--cert", "--cert-key", "--timeout", "--proxy"] });
  const operands = [...parsed.operands];
  const first = operands[0];
  const explicit = first !== undefined && httpMethods.has(first.text) ? operands.shift()?.text : undefined;
  const url = operands.shift();
  if (url === undefined) {
    return [];
  }
  const items = operands.filter((word) => /^[^=:@]+(?::=|=|@)/.test(word.text));
  const fields = new Map<string, string>();
  let unknownBody = false;
  for (const item of items) {
    const match = /^([^=:@]+)(:=|=|@)(.*)$/.exec(item.text);
    if (match === null) {
      continue;
    }
    if (match[2] === "@" || (match[3] ?? "").startsWith("@") || item.dynamic) {
      unknownBody = true;
    }
    fields.set((match[1] ?? "").toLowerCase(), match[3] ?? "");
  }
  const method = explicit ?? (items.length > 0 ? "POST" : "GET");
  return [request(method, url.text, "", fields, items.map((word) => word.text).join("&"), unknownBody)];
}

function invokeRest(invocation: Invocation): Effect[] {
  const parsed = parseArgs(invocation.args, {
    values: ["-method", "-uri", "-body", "-headers", "-contenttype", "-infile", "-outfile", "-useragent", "-websession", "-sessionvariable", "-maximumredirection", "-timeoutsec", "-proxy", "-proxycredential", "-certificate", "-certificatethumbprint", "-transferencoding", "-form", "-authentication", "-token", "-custommethod", ...commonPowershellValues],
    caseless: true,
  });
  const url = lastOption(parsed, ["-uri"]) ?? parsed.operands[0];
  if (url === undefined) {
    return [];
  }
  const body = option(parsed, ["-body"]);
  const unknownBody = body.some((word) => word.dynamic) || option(parsed, ["-infile", "-form"]).length > 0;
  const method = lastOption(parsed, ["-method", "-custommethod"])?.text ?? "GET";
  return [request(method, url.text, "", new Map(), body.map((word) => word.text).join("&"), unknownBody)];
}

function redirectWrites(invocation: Invocation): Effect[] {
  return invocation.redirects
    .filter((redirect) => redirect.operator.includes(">") && redirect.target !== undefined)
    .map((redirect) => ({ kind: "write", target: locate(redirect.target?.text ?? "", invocation.cwd) }));
}

type Interpreter = (invocation: Invocation) => Effect[];

const interpreters: Readonly<Record<string, Interpreter>> = {
  find: findDeletions,
  rsync,
  git,
  cp: (invocation) => destinationWrites(invocation, false),
  install: (invocation) => destinationWrites(invocation, false),
  ln: (invocation) => destinationWrites(invocation, false),
  scp: (invocation) => destinationWrites(invocation, false),
  copy: (invocation) => destinationWrites(invocation, false),
  "copy-item": (invocation) => destinationWrites(invocation, false),
  cpi: (invocation) => destinationWrites(invocation, false),
  mv: (invocation) => destinationWrites(invocation, true),
  move: (invocation) => destinationWrites(invocation, true),
  "move-item": (invocation) => destinationWrites(invocation, true),
  mi: (invocation) => destinationWrites(invocation, true),
  "rename-item": rename,
  ren: rename,
  rni: rename,
  tee: (invocation) => operandWrites(invocation, []),
  "tee-object": (invocation) => powershellWrites(invocation, ["-filepath", "-literalpath", "-path"], ["-variable", "-encoding"]),
  sed: inPlace,
  perl: inPlace,
  ruby: inPlace,
  truncate: (invocation) => operandWrites(invocation, ["-s", "--size", "-r", "--reference"]),
  dd,
  "set-content": (invocation) => powershellWrites(invocation, pathOptions, ["-value", "-encoding", "-delimiter"]),
  sc: (invocation) => powershellWrites(invocation, pathOptions, ["-value", "-encoding", "-delimiter"]),
  "add-content": (invocation) => powershellWrites(invocation, pathOptions, ["-value", "-encoding", "-delimiter"]),
  ac: (invocation) => powershellWrites(invocation, pathOptions, ["-value", "-encoding", "-delimiter"]),
  "clear-content": (invocation) => powershellWrites(invocation, pathOptions, []),
  clc: (invocation) => powershellWrites(invocation, pathOptions, []),
  "out-file": (invocation) => powershellWrites(invocation, ["-filepath", "-literalpath", "-path"], ["-encoding", "-width", "-inputobject"]),
  "new-item": (invocation) => powershellWrites(invocation, pathOptions, ["-name", "-itemtype", "-type", "-value"]),
  ni: (invocation) => powershellWrites(invocation, pathOptions, ["-name", "-itemtype", "-type", "-value"]),
  "ssh-keygen": sshKeygen,
  openssl,
  gh,
  curl,
  wget,
  http: httpie,
  https: httpie,
  xh: httpie,
  xhs: httpie,
  "invoke-restmethod": invokeRest,
  irm: invokeRest,
  "invoke-webrequest": invokeRest,
  iwr: invokeRest,
};

const dotnetCall = /\[(?:System\.)?IO\.(File|Directory|FileInfo|DirectoryInfo)\]::(Delete|WriteAll\w*|AppendAll\w*|Move|Copy|Replace|Create\w*)\s*\(\s*(?:(['"])([^'"]*)\3)?/gi;

export function textEffects(text: string, cwd: Location | undefined): Effect[] {
  const effects: Effect[] = [];
  for (const match of text.matchAll(dotnetCall)) {
    const method = (match[2] ?? "").toLowerCase();
    const literal = match[4];
    const target = literal === undefined || literal.includes("$") ? unknownLocation : locate(literal, cwd);
    if (method === "delete") {
      effects.push({ kind: "delete", target, contents: false });
    } else {
      effects.push({ kind: "write", target });
    }
  }
  return effects;
}

export function effectsOf(invocation: Invocation): Effect[] {
  const effects = redirectWrites(invocation);
  if (deletePrograms.has(invocation.program)) {
    effects.push(...deletions(invocation));
  } else if (invocation.program.startsWith("mkfs") || invocation.program === "wipefs") {
    effects.push({ kind: "delete", target: unknownLocation, contents: true });
  } else {
    const interpreter = interpreters[invocation.program];
    if (interpreter !== undefined) {
      effects.push(...interpreter(invocation));
    }
  }
  return effects;
}
