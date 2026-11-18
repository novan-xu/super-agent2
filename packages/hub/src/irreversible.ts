import { text } from "@super-agent2/catalog";
import { type ApiRequest, type Effect, effectsOf, type Push, textEffects } from "./effects.js";
import { expand, type Invocation, programName } from "./invocations.js";
import { absolute, isSessionItem, type Location, pathText, variableRoot, within } from "./paths.js";
import type { Word } from "./shell.js";

export const formIds = [
  "repository-deletion",
  "repository-publication",
  "default-branch-rewrite",
  "data-deletion",
  "file-deletion",
] as const;

export type FormId = (typeof formIds)[number];

export interface CommandPattern {
  readonly programs: readonly string[];
  readonly subcommand?: readonly (readonly string[])[];
  readonly words?: readonly RegExp[];
  readonly flags?: readonly string[];
  readonly option?: { readonly names: readonly string[]; readonly value: RegExp };
}

export interface RequestRule {
  readonly methods: readonly string[];
  readonly path: RegExp;
  readonly body?: (request: ApiRequest) => boolean;
}

export interface TextRule {
  readonly programs: readonly string[];
  readonly pattern: RegExp;
}

export interface LockSettings {
  readonly projectFolders: readonly Location[];
  readonly temporaryFolders: readonly Location[];
  readonly defaultBranches: ReadonlySet<string>;
}

export interface IrreversibleForm {
  readonly id: FormId;
  readonly description: string;
  readonly commands?: readonly CommandPattern[];
  readonly requests?: readonly RequestRule[];
  readonly texts?: readonly TextRule[];
  readonly effect?: (effect: Effect, settings: LockSettings) => boolean;
}

const dockers = ["docker", "podman", "nerdctl"];

const composes = ["docker-compose", "podman-compose"];

const databaseClients = ["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "clickhouse", "clickhouse-client", "cockroach", "duckdb", "mongosh", "mongo", "redis-cli", "curl", "wget", "http", "https", "xh", "invoke-restmethod", "irm", "invoke-webrequest", "iwr"];

const repository = /^repos\/[^/]+\/[^/]+$/;

function fieldIs(request: ApiRequest, name: string, value: RegExp): boolean {
  const field = request.fields.get(name);
  return field !== undefined && value.test(field);
}

function bodyHas(request: ApiRequest, pattern: RegExp): boolean {
  return pattern.test(request.body);
}

function publishes(request: ApiRequest): boolean {
  return (
    request.bodyUnknown ||
    fieldIs(request, "private", /^false$/i) ||
    fieldIs(request, "visibility", /^public$/i) ||
    bodyHas(request, /"private"\s*:\s*false|"visibility"\s*:\s*"public"|(?:^|&)private=false|(?:^|&)visibility=public/i)
  );
}

function createsPublic(request: ApiRequest): boolean {
  if (request.bodyUnknown) {
    return true;
  }
  const closed =
    fieldIs(request, "private", /^true$/i) ||
    fieldIs(request, "visibility", /^(private|internal)$/i) ||
    bodyHas(request, /"private"\s*:\s*true|"visibility"\s*:\s*"(private|internal)"|(?:^|&)private=true|(?:^|&)visibility=(private|internal)/i);
  return !closed;
}

function forcesRef(request: ApiRequest): boolean {
  return request.bodyUnknown || fieldIs(request, "force", /^true$/i) || bodyHas(request, /"force"\s*:\s*true|(?:^|&)force=true/i);
}

function graphql(pattern: RegExp): (request: ApiRequest) => boolean {
  return (request) => request.bodyUnknown || pattern.test(request.body) || pattern.test(request.fields.get("query") ?? "");
}

function rewritesDefault(push: Push, settings: LockSettings): boolean {
  const isDefault = (destination: string | undefined) => destination === undefined || settings.defaultBranches.has(destination);
  if (push.refspecs.some((refspec) => refspec.deletion && isDefault(refspec.destination))) {
    return true;
  }
  if (!push.forced && !push.refspecs.some((refspec) => refspec.forced)) {
    return false;
  }
  if (push.everything || push.refspecs.length === 0) {
    return true;
  }
  return push.refspecs.some((refspec) => refspec.forced && isDefault(refspec.destination));
}

function insideProject(target: Location, contents: boolean, settings: LockSettings): boolean {
  return settings.projectFolders.some((folder) => within(target, folder, !contents));
}

function insideTemporary(target: Location, contents: boolean, settings: LockSettings): boolean {
  return settings.temporaryFolders.some((folder) => within(target, folder, !contents));
}

export const irreversibleForms: readonly IrreversibleForm[] = [
  {
    id: "repository-deletion",
    description: text("hold.form.repositoryDeletion"),
    commands: [{ programs: ["gh"], subcommand: [["repo"], ["delete"]] }],
    requests: [
      { methods: ["DELETE"], path: repository },
      { methods: ["POST"], path: /^graphql$/, body: graphql(/deleteRepository/i) },
    ],
  },
  {
    id: "repository-publication",
    description: text("hold.form.repositoryPublication"),
    commands: [
      { programs: ["gh"], subcommand: [["repo"], ["edit"]], option: { names: ["--visibility"], value: /^public$/i } },
      { programs: ["gh"], subcommand: [["repo"], ["create", "new"]], flags: ["--public"] },
    ],
    requests: [
      { methods: ["PATCH", "PUT", "POST"], path: repository, body: publishes },
      { methods: ["POST"], path: /^(?:user|orgs\/[^/]+)\/repos$|^repos\/[^/]+\/[^/]+\/generate$/, body: createsPublic },
      { methods: ["POST"], path: /^graphql$/, body: graphql(/visibility\s*:\s*PUBLIC/i) },
    ],
  },
  {
    id: "default-branch-rewrite",
    description: text("hold.form.defaultBranchRewrite"),
    commands: [
      { programs: ["git"], subcommand: [["filter-repo", "filter-branch"]] },
      { programs: ["git-filter-repo", "bfg"] },
      { programs: ["java"], words: [/bfg[^/\\]*\.jar$/i] },
    ],
    requests: [
      { methods: ["DELETE"], path: /^repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(?:main|master|trunk)$/ },
      { methods: ["PATCH", "POST"], path: /^repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(?:main|master|trunk)$/, body: forcesRef },
      { methods: ["POST"], path: /^graphql$/, body: graphql(/force\s*:\s*true/i) },
    ],
    effect: (effect, settings) => effect.kind === "push" && rewritesDefault(effect.push, settings),
  },
  {
    id: "data-deletion",
    description: text("hold.form.dataDeletion"),
    commands: [
      { programs: dockers, subcommand: [["volume"], ["rm", "remove", "prune"]] },
      { programs: dockers, subcommand: [["system"], ["prune"]], flags: ["--volumes"] },
      { programs: dockers, subcommand: [["rm"]], flags: ["-v", "--volumes"] },
      { programs: dockers, subcommand: [["container"], ["rm", "remove"]], flags: ["-v", "--volumes"] },
      { programs: dockers, subcommand: [["compose"], ["down"]], flags: ["-v", "--volumes"] },
      { programs: dockers, subcommand: [["compose"], ["rm"]], flags: ["-v", "--volumes"] },
      { programs: composes, subcommand: [["down"]], flags: ["-v", "--volumes"] },
      { programs: composes, subcommand: [["rm"]], flags: ["-v", "--volumes"] },
      { programs: ["dropdb"] },
      { programs: ["mysqladmin"], words: [/^drop$/i] },
      { programs: ["redis-cli"], words: [/^flush(?:all|db)$/i] },
      { programs: ["pg_restore"], flags: ["-c", "--clean"] },
      { programs: ["prisma"], subcommand: [["migrate"], ["reset"]] },
      { programs: ["prisma"], subcommand: [["db"], ["push"]], flags: ["--force-reset"] },
      { programs: ["rails", "rake"], words: [/^db:(?:drop|reset|purge)(?::|$)/] },
      { programs: ["kubectl"], subcommand: [["delete"], ["pvc", "pv", "persistentvolumeclaim", "persistentvolumeclaims", "persistentvolume", "persistentvolumes"]] },
    ],
    texts: [
      { programs: databaseClients, pattern: /\bdrop\s+(?:database|schema)\b/i },
      { programs: ["redis-cli"], pattern: /\bflush(?:all|db)\b/i },
      { programs: ["mongosh", "mongo"], pattern: /\.dropDatabase\s*\(/ },
    ],
  },
  {
    id: "file-deletion",
    description: text("hold.form.fileDeletion"),
    effect: (effect, settings) =>
      effect.kind === "delete" &&
      !isSessionItem(effect.target) &&
      !insideProject(effect.target, effect.contents, settings) &&
      !insideTemporary(effect.target, effect.contents, settings),
  },
];

export const defaultBranchNames: readonly string[] = ["main", "master", "trunk"];

export const temporaryFolders: readonly string[] = ["/tmp", "/var/tmp", "$TMPDIR", "$TMP", "$TEMP"];

function folderLocation(folder: string): Location | undefined {
  if (folder.startsWith("$")) {
    return { known: true, root: variableRoot(folder.slice(1)), parts: [], caseless: false };
  }
  return absolute(folder);
}

export interface LockSettingsInput {
  readonly projectFolders: readonly string[];
}

export function lockSettings(input: LockSettingsInput): LockSettings {
  const locations = (folders: readonly string[]) =>
    folders.flatMap((folder) => {
      const location = folderLocation(folder);
      return location === undefined ? [] : [location];
    });
  return {
    projectFolders: locations(input.projectFolders.filter((folder) => !folder.startsWith("$"))),
    temporaryFolders: locations(temporaryFolders),
    defaultBranches: new Set(defaultBranchNames),
  };
}

export interface IrreversibleMatch {
  readonly form: FormId;
  readonly description: string;
  readonly evidence: string;
}

const programValueOptions: Readonly<Record<string, readonly string[]>> = {
  docker: ["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey", "-f", "--file", "-p", "--project-name", "--env-file", "--profile", "--project-directory", "--ansi", "--progress", "--parallel", "-t", "--timeout", "--rmi"],
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"],
  gh: ["-R", "--repo"],
  kubectl: ["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-l", "--selector", "-o", "--output"],
  prisma: ["--schema"],
};

function valueOptionsOf(program: string): readonly string[] {
  if (program === "podman" || program === "nerdctl" || program.endsWith("-compose")) {
    return programValueOptions["docker"] ?? [];
  }
  return programValueOptions[program] ?? [];
}

function positionals(invocation: Invocation): Word[] {
  const values = valueOptionsOf(invocation.program);
  const found: Word[] = [];
  let ended = false;
  for (let index = 0; index < invocation.args.length; index += 1) {
    const word = invocation.args[index];
    if (word === undefined) {
      break;
    }
    if (!ended && word.text === "--") {
      ended = true;
      continue;
    }
    if (!ended && word.text.startsWith("-") && word.text.length > 1) {
      if (!word.text.includes("=") && values.includes(word.text)) {
        index += 1;
      }
      continue;
    }
    found.push(word);
  }
  return found;
}

function hasFlag(invocation: Invocation, flags: readonly string[]): boolean {
  return invocation.args.some((word) =>
    flags.some((flag) => {
      const text = word.text;
      if (text === flag || text.startsWith(`${flag}=`)) {
        return true;
      }
      return /^-[A-Za-z]$/.test(flag) && /^-[A-Za-z]{2,}$/.test(text) && text.includes(flag.slice(1));
    }),
  );
}

function hasOption(invocation: Invocation, names: readonly string[], value: RegExp): boolean {
  return invocation.args.some((word, index) =>
    names.some((name) => {
      if (word.text.startsWith(`${name}=`)) {
        return value.test(word.text.slice(name.length + 1));
      }
      const next = invocation.args[index + 1];
      return word.text === name && next !== undefined && value.test(next.text);
    }),
  );
}

function matchesCommand(pattern: CommandPattern, invocation: Invocation): boolean {
  if (!pattern.programs.includes(invocation.program)) {
    return false;
  }
  if (pattern.subcommand !== undefined) {
    const words = positionals(invocation);
    const fits = pattern.subcommand.every((choices, index) => {
      const word = words[index];
      return word !== undefined && choices.includes(word.text.toLowerCase());
    });
    if (!fits) {
      return false;
    }
  }
  if (pattern.words !== undefined) {
    const words = positionals(invocation);
    if (!pattern.words.every((expression) => words.some((word) => expression.test(word.text)))) {
      return false;
    }
  }
  if (pattern.flags !== undefined && !hasFlag(invocation, pattern.flags)) {
    return false;
  }
  if (pattern.option !== undefined && !hasOption(invocation, pattern.option.names, pattern.option.value)) {
    return false;
  }
  return true;
}

function apiPath(request: ApiRequest): string | undefined {
  if (request.host === "api.github.com") {
    return request.path;
  }
  return request.path.startsWith("api/v3/") ? request.path.slice("api/v3/".length) : undefined;
}

function matchesRequest(rule: RequestRule, request: ApiRequest): boolean {
  const path = apiPath(request);
  return path !== undefined && rule.methods.includes(request.method) && rule.path.test(path) && (rule.body === undefined || rule.body(request));
}

const evidenceLimit = 200;

function shorten(text: string): string {
  const clean = text.replace(/\u0000\u0002([^\u0003]*)\u0003/g, "$$$1").replaceAll("\u0000", "…");
  return clean.length > evidenceLimit ? `${clean.slice(0, evidenceLimit - 1)}…` : clean;
}

function describeInvocation(invocation: Invocation): string {
  return shorten([invocation.program, ...invocation.args.map((word) => word.text)].join(" ").trim());
}

function describeEffect(effect: Effect, invocation: Invocation | undefined): string {
  if (effect.kind === "request") {
    return shorten(`${effect.request.method} ${effect.request.host}/${effect.request.path}`);
  }
  if (effect.kind === "push") {
    return invocation === undefined ? "git push" : describeInvocation(invocation);
  }
  return shorten(`${invocation === undefined ? "" : `${describeInvocation(invocation)}: `}${pathText(effect.target)}`);
}

function matchEffect(effect: Effect, settings: LockSettings): IrreversibleForm | undefined {
  return irreversibleForms.find((form) => {
    if (effect.kind === "request") {
      return form.requests?.some((rule) => matchesRequest(rule, effect.request)) === true;
    }
    return form.effect?.(effect, settings) === true;
  });
}

export interface CommandText {
  readonly command: string;
  readonly cwd: string | null;
}

export function findIrreversible(command: CommandText, settings: LockSettings): IrreversibleMatch | undefined {
  const cwd = command.cwd === null ? undefined : absolute(command.cwd);
  const expansion = expand(command.command, cwd);
  for (const invocation of expansion.invocations) {
    for (const form of irreversibleForms) {
      if (form.commands?.some((pattern) => matchesCommand(pattern, invocation)) === true) {
        return { form: form.id, description: form.description, evidence: describeInvocation(invocation) };
      }
    }
    for (const effect of effectsOf(invocation)) {
      const form = matchEffect(effect, settings);
      if (form !== undefined) {
        return { form: form.id, description: form.description, evidence: describeEffect(effect, invocation) };
      }
    }
  }
  const present = new Set(
    expansion.invocations.flatMap((invocation) => [invocation.program, ...invocation.args.map((word) => programName(word))]),
  );
  for (const form of irreversibleForms) {
    for (const rule of form.texts ?? []) {
      if (!rule.programs.some((program) => present.has(program))) {
        continue;
      }
      const text = expansion.texts.find((candidate) => rule.pattern.test(candidate));
      if (text !== undefined) {
        const found = rule.pattern.exec(text)?.[0] ?? "";
        return { form: form.id, description: form.description, evidence: shorten(found) };
      }
    }
  }
  for (const text of expansion.texts) {
    for (const effect of textEffects(text, cwd)) {
      const form = matchEffect(effect, settings);
      if (form !== undefined) {
        return { form: form.id, description: form.description, evidence: describeEffect(effect, undefined) };
      }
    }
  }
  return undefined;
}
