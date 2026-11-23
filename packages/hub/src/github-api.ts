import { type GitHubAccount, RepositoryName } from "@super-agent2/protocol";
import { z } from "zod";

export type Fetch = typeof fetch;

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface PullRequestState {
  readonly number: number;
  readonly open: boolean;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly mergeCommit: string | null;
  readonly head: string;
  readonly headRef: string;
  readonly headRepository: string | null;
  readonly base: string;
  readonly baseHead?: string;
  readonly mergeable: boolean | null;
  readonly url: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly previous: string | null;
}

export type Contents = { readonly kind: "file" } | { readonly kind: "folder"; readonly files: readonly string[] };

export type Comparison = "ahead" | "behind" | "identical" | "diverged" | "unknown";

export type MergeMethod = "squash" | "merge" | "rebase";

export type MergeAnswer =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly kind: "unmergeable" | "moved" | "refused"; readonly message: string };

export interface MergeMethods {
  readonly squash: boolean;
  readonly merge: boolean;
  readonly rebase: boolean;
}

interface IssueState {
  readonly state: "open" | "closed";
  readonly stateReason: string | null;
  readonly closedAt: string | null;
  readonly comments: number;
}

export interface GitHubApi {
  repositories(affiliation: string): Promise<GitHubRepository[]>;
  hasAuthoredCommits(repository: string, author: GitHubAccount): Promise<boolean>;
  pullRequest(repository: string, number: number): Promise<PullRequestState>;
  files(repository: string, number: number): Promise<ChangedFile[]>;
  changedOn(repository: string, head: string, base: string): Promise<string[]>;
  contents(repository: string, path: string, ref: string): Promise<Contents | null>;
  fileText(repository: string, path: string, ref: string): Promise<string | null>;
  commit(repository: string, ref: string): Promise<string | null>;
  compare(repository: string, base: string, head: string): Promise<Comparison>;
  mergeMethods(repository: string): Promise<MergeMethods>;
  merge(repository: string, number: number, sha: string, method: MergeMethod): Promise<MergeAnswer>;
  issue(repository: string, number: number): Promise<IssueState | null>;
  closingComment(repository: string, number: number): Promise<string | null>;
  findIssueComment(repository: string, number: number, body: string): Promise<string | null>;
  postIssueComment(repository: string, number: number, body: string): Promise<string>;
  reopenIssue(repository: string, number: number): Promise<void>;
  closeIssue(repository: string, number: number): Promise<void>;
  deleteBranch(repository: string, branch: string): Promise<void>;
  closingIssues(repository: string, number: number): Promise<number[]>;
}

export interface GitHubApiOptions {
  readonly fetch: Fetch;
  readonly token: string;
  readonly base?: string;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export const gitHubApiBase = "https://api.github.com";

const PullJson = z.looseObject({
  number: z.number().int(),
  state: z.string(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  html_url: z.string(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullable().optional() }),
  base: z.looseObject({ ref: z.string(), sha: z.string().optional() }),
});

const FileJson = z.looseObject({ filename: z.string(), previous_filename: z.string().optional() });

const CompareJson = z.looseObject({ files: z.array(FileJson).optional() });

const StatusJson = z.looseObject({ status: z.string() });

const FileContentJson = z.looseObject({ type: z.string(), content: z.string().optional(), encoding: z.string().optional() });

const CommitJson = z.looseObject({ sha: z.string() });

const EntryJson = z.looseObject({ name: z.string(), type: z.string() });

const RepositoryJson = z.looseObject({
  allow_squash_merge: z.boolean().optional(),
  allow_merge_commit: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
});

const RepositoryListing = z.object({
  full_name: RepositoryName,
  owner: z.object({ login: z.string() }),
  archived: z.boolean(),
  pushed_at: z.string().nullable(),
  default_branch: z.string(),
});
export type GitHubRepository = z.infer<typeof RepositoryListing>;

const MergeJson = z.looseObject({ sha: z.string() });

const IssueJson = z.looseObject({
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  comments: z.number().int().nonnegative().default(0),
});
const IssueCommentJson = z.object({ body: z.string(), html_url: z.url() });

const TimelineEvent = z.looseObject({
  event: z.string(),
  created_at: z.string().optional(),
  actor: z.looseObject({ login: z.string() }).nullable().optional(),
  user: z.looseObject({ login: z.string() }).nullable().optional(),
  commit_id: z.string().nullable().optional(),
  body: z.string().optional(),
});
type TimelineEvent = z.infer<typeof TimelineEvent>;

function adjacentClosingComment(events: readonly TimelineEvent[]): string | null {
  const index = events.findLastIndex((event) => event.event === "closed" || event.event === "reopened");
  const closing = events[index];
  if (closing?.event !== "closed" || closing.actor == null || closing.commit_id != null) {
    return null;
  }
  const at = Date.parse(closing.created_at ?? "");
  const comment = [events[index - 1], events[index + 1]].find((event) =>
    event?.event === "commented" && (event.actor ?? event.user)?.login === closing.actor?.login
    && Math.abs(Date.parse(event.created_at ?? "") - at) <= 10_000);
  return comment?.body?.trim() || null;
}

const MessageJson = z.looseObject({ message: z.string() });

const ClosingJson = z.looseObject({
  data: z
    .looseObject({
      repository: z
        .looseObject({
          pullRequest: z
            .looseObject({
              closingIssuesReferences: z.looseObject({
                nodes: z.array(z.looseObject({ number: z.number().int(), repository: z.looseObject({ nameWithOwner: z.string() }) }).nullable()),
                pageInfo: z.looseObject({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
              }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.looseObject({ message: z.string() })).optional(),
});

const closingQuery = [
  "query($owner: String!, $name: String!, $number: Int!, $after: String) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $number) {",
  "      closingIssuesReferences(first: 100, after: $after) {",
  "        nodes { number repository { nameWithOwner } }",
  "        pageInfo { hasNextPage endCursor }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

const pageSize = 100;
const filePages = 30;

function pathOf(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function createGitHubApi(options: GitHubApiOptions): GitHubApi {
  const base = options.base ?? gitHubApiBase;
  const timeout = options.timeoutMilliseconds ?? 60_000;

  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    try {
      const deadline = AbortSignal.timeout(timeout);
      return await options.fetch(`${base}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "super-agent2-hub",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]),
      });
    } catch (error) {
      throw new ForgeError(`GitHub could not be reached for ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
  };

  const messageOf = async (response: Response): Promise<string> => {
    try {
      const parsed = MessageJson.safeParse(await response.json());
      return parsed.success ? parsed.data.message : "";
    } catch {
      return "";
    }
  };

  const failure = async (method: string, path: string, response: Response): Promise<ForgeError> => {
    const message = await messageOf(response);
    return new ForgeError(`GitHub answered ${response.status} to ${method} ${path}${message === "" ? "" : `: ${message}`}`, response.status);
  };

  const readResponse = async <T>(path: string, response: Response, schema: z.ZodType<T>): Promise<T> => {
    if (!response.ok) {
      throw await failure("GET", path, response);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ForgeError(`GitHub answered GET ${path} in an unexpected shape: ${parsed.error.message}`, response.status);
    }
    return parsed.data;
  };
  const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => readResponse(path, await send("GET", path), schema);

  const repo = (repository: string) => `/repos/${RepositoryName.parse(repository)}`;

  return {
    repositories: async (affiliation) => {
      const repositories: GitHubRepository[] = [];
      for (let page = 1; ; page += 1) {
        const path = `/user/repos?affiliation=${affiliation}&per_page=${pageSize}&sort=full_name&page=${page}`;
        const response = await send("GET", path);
        repositories.push(...await readResponse(path, response, z.array(RepositoryListing)));
        if (!response.headers.get("link")?.includes('rel="next"')) {
          return repositories;
        }
      }
    },
    hasAuthoredCommits: async (repository, author) => {
      const path = `${repo(repository)}/commits?author=${author}&per_page=1`;
      const response = await send("GET", path);
      if (response.status === 409) {
        return false;
      }
      return (await readResponse(path, response, z.array(CommitJson))).length > 0;
    },
    pullRequest: async (repository, number) => {
      const pull = await read(`${repo(repository)}/pulls/${number}`, PullJson);
      return {
        number: pull.number,
        open: pull.state === "open",
        merged: pull.merged === true || (pull.merged_at !== undefined && pull.merged_at !== null),
        mergedAt: pull.merged_at ?? null,
        mergeCommit: pull.merge_commit_sha ?? null,
        head: pull.head.sha,
        headRef: pull.head.ref,
        headRepository: pull.head.repo?.full_name ?? null,
        base: pull.base.ref,
        ...(pull.base.sha === undefined ? {} : { baseHead: pull.base.sha }),
        mergeable: pull.mergeable ?? null,
        url: pull.html_url,
      };
    },
    files: async (repository, number) => {
      const files: ChangedFile[] = [];
      for (let page = 1; page <= filePages; page += 1) {
        const batch = await read(`${repo(repository)}/pulls/${number}/files?per_page=${pageSize}&page=${page}`, z.array(FileJson));
        files.push(...batch.map((file) => ({ path: file.filename, previous: file.previous_filename ?? null })));
        if (batch.length < pageSize) {
          break;
        }
      }
      return files;
    },
    changedOn: async (repository, head, base) => {
      const compared = await read(`${repo(repository)}/compare/${encodeURIComponent(head)}...${encodeURIComponent(base)}?per_page=${pageSize}`, CompareJson);
      return (compared.files ?? []).map((file) => file.filename);
    },
    contents: async (repository, path, ref) => {
      const address = `${repo(repository)}/contents/${pathOf(path)}?ref=${encodeURIComponent(ref)}`;
      const response = await send("GET", address);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw await failure("GET", address, response);
      }
      const body: unknown = await response.json();
      if (Array.isArray(body)) {
        const entries = z.array(EntryJson).safeParse(body);
        if (!entries.success) {
          throw new ForgeError(`GitHub answered GET ${address} in an unexpected shape: ${entries.error.message}`, response.status);
        }
        return { kind: "folder", files: entries.data.filter((entry) => entry.type === "file").map((entry) => entry.name) };
      }
      return { kind: "file" };
    },
    fileText: async (repository, path, ref) => {
      const address = `${repo(repository)}/contents/${pathOf(path)}?ref=${encodeURIComponent(ref)}`;
      const response = await send("GET", address);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw await failure("GET", address, response);
      }
      const parsed = FileContentJson.safeParse(await response.json());
      if (!parsed.success || parsed.data.type !== "file") {
        throw new ForgeError(`GitHub answered GET ${address} with something that is not a file`, response.status);
      }
      const content = parsed.data.content ?? "";
      return parsed.data.encoding === "base64" ? Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8") : content;
    },
    commit: async (repository, ref) => {
      const address = `${repo(repository)}/commits/${encodeURIComponent(ref)}`;
      const response = await send("GET", address);
      if (response.status === 404 || response.status === 422) {
        return null;
      }
      if (!response.ok) {
        throw await failure("GET", address, response);
      }
      const parsed = CommitJson.safeParse(await response.json());
      if (!parsed.success) {
        throw new ForgeError(`GitHub answered GET ${address} in an unexpected shape`, response.status);
      }
      return parsed.data.sha;
    },
    compare: async (repository, base, head) => {
      const address = `${repo(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`;
      const response = await send("GET", address);
      if (response.status === 404) {
        return "unknown";
      }
      if (!response.ok) {
        throw await failure("GET", address, response);
      }
      const parsed = StatusJson.safeParse(await response.json());
      const status = parsed.success ? parsed.data.status : "";
      return status === "ahead" || status === "behind" || status === "identical" || status === "diverged" ? status : "unknown";
    },
    mergeMethods: async (repository) => {
      const found = await read(repo(repository), RepositoryJson);
      return { squash: found.allow_squash_merge !== false, merge: found.allow_merge_commit !== false, rebase: found.allow_rebase_merge !== false };
    },
    merge: async (repository, number, sha, method) => {
      const path = `${repo(repository)}/pulls/${number}/merge`;
      const response = await send("PUT", path, { sha, merge_method: method });
      if (response.ok) {
        const parsed = MergeJson.safeParse(await response.json());
        if (!parsed.success) {
          throw new ForgeError(`GitHub merged pull request ${number} but answered in an unexpected shape`, response.status);
        }
        return { ok: true, sha: parsed.data.sha };
      }
      const message = await messageOf(response);
      const said = `GitHub answered ${response.status} to the merge${message === "" ? "" : `: ${message}`}`;
      if (response.status === 405) {
        return { ok: false, kind: "unmergeable", message: said };
      }
      if (response.status === 409) {
        return { ok: false, kind: "moved", message: said };
      }
      if (response.status === 403 || response.status === 422) {
        return { ok: false, kind: "refused", message: said };
      }
      throw new ForgeError(said, response.status);
    },
    issue: async (repository, number) => {
      const path = `${repo(repository)}/issues/${number}`;
      const response = await send("GET", path);
      if (response.status === 404 || response.status === 410) {
        return null;
      }
      const issue = await readResponse(path, response, IssueJson);
      return { state: issue.state, stateReason: issue.state_reason?.toUpperCase() ?? null, closedAt: issue.closed_at ?? null, comments: issue.comments };
    },
    closingComment: async (repository, number) => {
      const events: TimelineEvent[] = [];
      for (let page = 1; ; page += 1) {
        const path = `${repo(repository)}/issues/${number}/timeline?per_page=${pageSize}&page=${page}`;
        const response = await send("GET", path);
        events.push(...await readResponse(path, response, z.array(TimelineEvent)));
        if (!response.headers.get("link")?.includes('rel="next"')) {
          return adjacentClosingComment(events);
        }
      }
    },
    findIssueComment: async (repository, number, body) => {
      for (let page = 1; ; page += 1) {
        const path = `${repo(repository)}/issues/${number}/comments?per_page=${pageSize}&page=${page}`;
        const response = await send("GET", path);
        const comments = await readResponse(path, response, z.array(IssueCommentJson));
        const existing = comments.find((comment) => comment.body === body);
        if (existing !== undefined) return existing.html_url;
        if (!response.headers.get("link")?.includes('rel="next"')) return null;
      }
    },
    postIssueComment: async (repository, number, body) => {
      const path = `${repo(repository)}/issues/${number}/comments`;
      const response = await send("POST", path, { body });
      if (!response.ok) throw await failure("POST", path, response);
      return IssueCommentJson.parse(await response.json()).html_url;
    },
    reopenIssue: async (repository, number) => {
      const path = `${repo(repository)}/issues/${number}`;
      const response = await send("PATCH", path, { state: "open" });
      if (!response.ok) throw await failure("PATCH", path, response);
    },
    closeIssue: async (repository, number) => {
      const path = `${repo(repository)}/issues/${number}`;
      const response = await send("PATCH", path, { state: "closed", state_reason: "completed" });
      if (!response.ok) {
        throw await failure("PATCH", path, response);
      }
    },
    closingIssues: async (repository, number) => {
      const name = RepositoryName.parse(repository);
      const [owner = "", short = ""] = name.split("/");
      const found: number[] = [];
      let after: string | null = null;
      for (;;) {
        const response = await send("POST", "/graphql", { query: closingQuery, variables: { owner, name: short, number, after } });
        if (!response.ok) {
          throw await failure("POST", "/graphql", response);
        }
        const parsed = ClosingJson.safeParse(await response.json());
        if (!parsed.success) {
          throw new ForgeError(`GitHub answered the closing references of pull request ${number} in an unexpected shape: ${parsed.error.message}`, response.status);
        }
        const errors = parsed.data.errors ?? [];
        const references = parsed.data.data?.repository?.pullRequest?.closingIssuesReferences;
        if (errors.length > 0 || references === undefined) {
          throw new ForgeError(`GitHub could not give the closing references of pull request ${number}${errors.length === 0 ? "" : `: ${errors.map((error) => error.message).join("; ")}`}`, response.status);
        }
        for (const node of references.nodes) {
          if (node !== null && node.repository.nameWithOwner.toLowerCase() === name.toLowerCase() && !found.includes(node.number)) {
            found.push(node.number);
          }
        }
        if (!references.pageInfo.hasNextPage || references.pageInfo.endCursor === null) {
          return found;
        }
        after = references.pageInfo.endCursor;
      }
    },
    deleteBranch: async (repository, branch) => {
      const path = `${repo(repository)}/git/refs/heads/${pathOf(branch)}`;
      const response = await send("DELETE", path);
      if (!response.ok && response.status !== 404 && response.status !== 422) {
        throw await failure("DELETE", path, response);
      }
    },
  };
}
