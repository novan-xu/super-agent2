import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRecord,
  defaultGitHubAccount,
  type Difficulty,
  finishedStates,
  GeneratedText,
  type GitHubAccount,
  gitHubAccounts,
  type Platform,
  RepositoryName,
  type Ticket,
  type TicketKind,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { CommandService } from "./commands.js";
import type { HubDatabase } from "./database.js";
import type { TicketService } from "./tickets.js";

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly open: boolean;
  readonly pullRequest: boolean;
}

export type HostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly held?: CommandRecord };

export interface IssueHost {
  recent(repository: string, account: GitHubAccount, since: number): Promise<HostResult<GitHubIssue[]>>;
  create(repository: string, account: GitHubAccount, title: string, body: string): Promise<HostResult<GitHubIssue>>;
  read(repository: string, number: number, account: GitHubAccount): Promise<HostResult<GitHubIssue>>;
}

export const filingTarget = "hub";

const IssueJson = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  state: z.string(),
  pull_request: z.unknown().optional(),
});

function toIssue(value: z.infer<typeof IssueJson>): GitHubIssue {
  return {
    number: value.number,
    title: value.title,
    body: value.body ?? "",
    url: value.html_url,
    open: value.state === "open",
    pullRequest: value.pull_request !== undefined && value.pull_request !== null,
  };
}

const safePath = /^[A-Za-z0-9_:\\/. -]+$/;

export function recentIssuesCommand(repository: string, since: number): string {
  const after = new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `gh api "repos/${RepositoryName.parse(repository)}/issues?state=all&sort=created&direction=desc&per_page=100&since=${after}"`;
}

export function createIssueCommand(repository: string, file: string): string {
  if (!safePath.test(file)) {
    throw new Error(`The scratch file ${file} has characters a shell would read`);
  }
  return `gh api "repos/${RepositoryName.parse(repository)}/issues" --method POST --input "${file}"`;
}

export function readIssueCommand(repository: string, number: number): string {
  return `gh api "repos/${RepositoryName.parse(repository)}/issues/${z.number().int().positive().parse(number)}"`;
}

function settledState(command: CommandRecord): boolean {
  return command.state === "held" || finishedStates.includes(command.state);
}

function settle(commands: CommandService, id: string): Promise<CommandRecord | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (record: CommandRecord | undefined) => {
      if (!done) {
        done = true;
        unsubscribe();
        resolve(record);
      }
    };
    const unsubscribe = commands.subscribe((event) => {
      if (event.type === "command" && event.command.id === id && settledState(event.command)) {
        finish(event.command);
      }
    });
    const current = commands.get(id);
    if (current === undefined || settledState(current)) {
      finish(current);
    }
  });
}

export interface CommandIssueHostOptions {
  readonly commands: CommandService;
  readonly scratchDir?: string;
}

export function commandIssueHost(options: CommandIssueHostOptions): IssueHost {
  const { commands } = options;
  const scratchDir = options.scratchDir ?? join(tmpdir(), "super-agent2-issues");

  const run = async (command: string, account: GitHubAccount): Promise<HostResult<string>> => {
    const started = commands.start({ target: filingTarget, command, account });
    const record = await settle(commands, started.id);
    const output = commands.output(started.id);
    const stdout = output.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.data).join("");
    if (record === undefined) {
      return { ok: false, reason: `Command ${started.id} disappeared` };
    }
    if (record.state === "held") {
      return { ok: false, reason: `Command ${record.id} is held until the owner confirms it: ${record.reason ?? ""}`, held: record };
    }
    if (record.state !== "exited" || record.exitCode !== 0) {
      const all = output.map((chunk) => chunk.data).join("").trim();
      return {
        ok: false,
        reason: `Command ${record.id} (${command}) ended ${record.state}${record.exitCode === null ? "" : ` with exit code ${record.exitCode}`}${record.reason === null ? "" : `: ${record.reason}`}${all === "" ? "" : `\n${all}`}`,
      };
    }
    return { ok: true, value: stdout };
  };

  const parsed = <T>(result: HostResult<string>, schema: z.ZodType<T>): HostResult<T> => {
    if (!result.ok) {
      return result;
    }
    try {
      const value = schema.safeParse(JSON.parse(result.value));
      return value.success ? { ok: true, value: value.data } : { ok: false, reason: `GitHub answered in an unexpected shape: ${value.error.message}` };
    } catch {
      return { ok: false, reason: `GitHub's answer is not JSON: ${result.value.slice(0, 2000)}` };
    }
  };

  return {
    recent: async (repository, account, since) => {
      const result = parsed(await run(recentIssuesCommand(repository, since), account), z.array(IssueJson));
      return result.ok ? { ok: true, value: result.value.map(toIssue) } : result;
    },
    create: async (repository, account, title, body) => {
      mkdirSync(scratchDir, { recursive: true });
      const file = join(realpathSync.native(scratchDir), `${randomUUID()}.json`);
      writeFileSync(file, JSON.stringify({ title, body }), { mode: 0o600 });
      try {
        const result = parsed(await run(createIssueCommand(repository, file), account), IssueJson);
        return result.ok ? { ok: true, value: toIssue(result.value) } : result;
      } finally {
        rmSync(file, { force: true });
      }
    },
    read: async (repository, number, account) => {
      const result = parsed(await run(readIssueCommand(repository, number), account), IssueJson);
      return result.ok ? { ok: true, value: toIssue(result.value) } : result;
    },
  };
}

export interface FileIssueRequest {
  readonly repository: string;
  readonly title: GeneratedText;
  readonly summary: GeneratedText;
  readonly body: string;
  readonly kind: TicketKind;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
  readonly account?: GitHubAccount | undefined;
  readonly conversation?: string | undefined;
}

export interface OpenIssueRequest {
  readonly repository: string;
  readonly number: number;
  readonly titleZh: string;
  readonly summary: GeneratedText;
  readonly kind: TicketKind;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
  readonly account?: GitHubAccount | undefined;
  readonly conversation?: string | undefined;
}

export type FilingOutcome =
  | { readonly ok: true; readonly ticket: Ticket; readonly issueCreated: boolean; readonly ticketExisted: boolean }
  | { readonly ok: false; readonly reason: string; readonly held: boolean };

export interface IssueFiler {
  file(request: FileIssueRequest): Promise<FilingOutcome>;
  open(request: OpenIssueRequest): Promise<FilingOutcome>;
}

export function accountFor(repository: string, given?: GitHubAccount): GitHubAccount {
  if (given !== undefined) {
    return given;
  }
  const owner = repository.split("/")[0]?.toLowerCase();
  return gitHubAccounts.find((account) => account === owner) ?? defaultGitHubAccount;
}

export function sameText(a: string, b: string): boolean {
  const normal = (text: string) => text.replaceAll("\r\n", "\n").trim();
  return normal(a) === normal(b);
}

function failed(reason: string, held = false): FilingOutcome {
  return { ok: false, reason, held };
}

export interface IssueFilerOptions {
  readonly accountOf?: (repository: string) => GitHubAccount;
  readonly host: IssueHost;
  readonly tickets: TicketService;
  readonly database: HubDatabase;
  readonly clock: Clock;
}

export interface IssueReference {
  readonly number: number;
  readonly url: string;
}

interface FilingRecord {
  readonly createdAt: number;
  readonly issue: IssueReference | undefined;
}

const lookBack = 10 * 60 * 1000;

export function filingKey(repository: string, title: string, body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([repository.toLowerCase(), title.trim(), body.replaceAll("\r\n", "\n").trim()]))
    .digest("hex");
}

const FilingRow = z.object({ number: z.number().int().nullable(), url: z.string().nullable(), created_at: z.number().int() });

function filingRecords(database: HubDatabase, clock: Clock) {
  const select = database.connection.prepare("SELECT number, url, created_at FROM issue_filings WHERE key = ?");
  const insert = database.connection.prepare(
    "INSERT INTO issue_filings (key, repository, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING",
  );
  const update = database.connection.prepare("UPDATE issue_filings SET number = ?, url = ?, updated_at = ? WHERE key = ?");
  return {
    get: (key: string): FilingRecord | undefined => {
      const row = select.get(key);
      if (row === undefined) {
        return undefined;
      }
      const value = FilingRow.parse(row);
      return {
        createdAt: value.created_at,
        issue: value.number === null || value.url === null ? undefined : { number: value.number, url: value.url },
      };
    },
    start: (key: string, repository: string) => {
      const now = clock.now();
      insert.run(key, repository, now, now);
    },
    found: (key: string, issue: IssueReference) => {
      update.run(issue.number, issue.url, clock.now(), key);
    },
  };
}

export function createIssueFiler(options: IssueFilerOptions): IssueFiler {
  const { host, tickets } = options;
  const records = filingRecords(options.database, options.clock);
  const inFlight = new Map<string, Promise<FilingOutcome>>();

  const once = (key: string, work: () => Promise<FilingOutcome>): Promise<FilingOutcome> => {
    const running = inFlight.get(key);
    if (running !== undefined) {
      return running;
    }
    const started = work().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };

  const liveTicket = (repository: string, number: number): Ticket | undefined =>
    tickets.forIssue(repository, number).find((ticket) => ticket.state !== "stopped");

  const openFor = (
    request: { readonly repository: string; readonly kind: TicketKind; readonly difficulty?: Difficulty | undefined; readonly platform?: Platform | undefined; readonly conversation?: string | undefined },
    issue: IssueReference,
    title: GeneratedText,
    summary: GeneratedText,
    issueCreated: boolean,
  ): FilingOutcome => {
    const existing = liveTicket(request.repository, issue.number);
    if (existing !== undefined) {
      return { ok: true, ticket: existing, issueCreated, ticketExisted: true };
    }
    try {
      const ticket = tickets.open({
        repository: request.repository,
        issues: [{ repository: request.repository, number: issue.number, url: issue.url, title, summary }],
        title,
        summary,
        kind: request.kind,
        difficulty: request.difficulty,
        platform: request.platform,
        conversation: request.conversation,
      });
      return { ok: true, ticket, issueCreated, ticketExisted: false };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  };

  const checkCommon = (repository: string, kind: TicketKind): string | undefined => {
    if (!RepositoryName.safeParse(repository).success) {
      return `${repository} is not a repository name; give it as owner/name`;
    }
    if (kind === "writing") {
      return "Writing work has no repository and is not filed as an issue";
    }
    return undefined;
  };

  return {
    file: (request) => {
      const problem = checkCommon(request.repository, request.kind);
      if (problem !== undefined) {
        return Promise.resolve(failed(problem));
      }
      const title = GeneratedText.safeParse(request.title);
      const summary = GeneratedText.safeParse(request.summary);
      if (!title.success || !summary.success) {
        return Promise.resolve(failed("The title and the summary each need an English original and a Chinese copy"));
      }
      if (request.body.trim() === "") {
        return Promise.resolve(failed("The issue body is empty"));
      }
      const account = request.account ?? (options.accountOf ?? accountFor)(request.repository);
      const key = filingKey(request.repository, title.data.en, request.body);
      return once(key, async () => {
        const record = records.get(key);
        if (record?.issue !== undefined) {
          return openFor(request, record.issue, title.data, summary.data, false);
        }
        if (record !== undefined) {
          const recent = await host.recent(request.repository, account, record.createdAt - lookBack);
          if (!recent.ok) {
            return failed(recent.reason, recent.held !== undefined);
          }
          const found = recent.value.find((issue) => !issue.pullRequest && sameText(issue.title, title.data.en) && sameText(issue.body, request.body));
          if (found !== undefined) {
            records.found(key, found);
            return openFor(request, found, title.data, summary.data, false);
          }
        } else {
          records.start(key, request.repository);
        }
        const created = await host.create(request.repository, account, title.data.en.trim(), request.body.trim());
        if (!created.ok) {
          return failed(created.reason, created.held !== undefined);
        }
        records.found(key, created.value);
        return openFor(request, created.value, title.data, summary.data, true);
      });
    },
    open: (request) => {
      const problem = checkCommon(request.repository, request.kind);
      if (problem !== undefined) {
        return Promise.resolve(failed(problem));
      }
      const summary = GeneratedText.safeParse(request.summary);
      if (!summary.success) {
        return Promise.resolve(failed("The summary needs an English original and a Chinese copy"));
      }
      const account = request.account ?? (options.accountOf ?? accountFor)(request.repository);
      return once(JSON.stringify([request.repository.toLowerCase(), request.number]), async () => {
        const existing = liveTicket(request.repository, request.number);
        if (existing !== undefined) {
          return { ok: true, ticket: existing, issueCreated: false, ticketExisted: true };
        }
        const read = await host.read(request.repository, request.number, account);
        if (!read.ok) {
          return failed(read.reason, read.held !== undefined);
        }
        if (read.value.pullRequest) {
          return failed(`#${request.number} in ${request.repository} is a pull request, not an issue`);
        }
        if (!read.value.open) {
          return failed(`Issue #${request.number} in ${request.repository} is closed`);
        }
        const title = GeneratedText.safeParse({ en: read.value.title, zh: request.titleZh });
        if (!title.success) {
          return failed("The Chinese title must be Chinese");
        }
        return openFor(request, read.value, title.data, summary.data, false);
      });
    },
  };
}
