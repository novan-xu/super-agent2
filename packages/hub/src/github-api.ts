import { RepositoryName } from "@super-agent2/protocol";
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
  readonly mergeCommit: string | null;
  readonly head: string;
  readonly headRef: string;
  readonly headRepository: string | null;
  readonly base: string;
  readonly mergeable: boolean | null;
  readonly url: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly previous: string | null;
}

export type Contents = { readonly kind: "file" } | { readonly kind: "folder"; readonly files: readonly string[] };

export type MergeMethod = "squash" | "merge" | "rebase";

export type MergeAnswer =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly kind: "unmergeable" | "moved" | "refused"; readonly message: string };

export interface MergeMethods {
  readonly squash: boolean;
  readonly merge: boolean;
  readonly rebase: boolean;
}

export interface GitHubApi {
  pullRequest(repository: string, number: number): Promise<PullRequestState>;
  files(repository: string, number: number): Promise<ChangedFile[]>;
  contents(repository: string, path: string, ref: string): Promise<Contents | null>;
  mergeMethods(repository: string): Promise<MergeMethods>;
  merge(repository: string, number: number, sha: string, method: MergeMethod): Promise<MergeAnswer>;
  issueOpen(repository: string, number: number): Promise<boolean | null>;
  closeIssue(repository: string, number: number): Promise<void>;
  deleteBranch(repository: string, branch: string): Promise<void>;
}

export interface GitHubApiOptions {
  readonly fetch: Fetch;
  readonly token: string;
  readonly base?: string;
  readonly timeoutMilliseconds?: number;
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
  base: z.looseObject({ ref: z.string() }),
});

const FileJson = z.looseObject({ filename: z.string(), previous_filename: z.string().optional() });

const EntryJson = z.looseObject({ name: z.string(), type: z.string() });

const RepositoryJson = z.looseObject({
  allow_squash_merge: z.boolean().optional(),
  allow_merge_commit: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
});

const MergeJson = z.looseObject({ sha: z.string() });

const IssueJson = z.looseObject({ state: z.string() });

const MessageJson = z.looseObject({ message: z.string() });

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
        signal: AbortSignal.timeout(timeout),
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

  const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await send("GET", path);
    if (!response.ok) {
      throw await failure("GET", path, response);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ForgeError(`GitHub answered GET ${path} in an unexpected shape: ${parsed.error.message}`, response.status);
    }
    return parsed.data;
  };

  const repo = (repository: string) => `/repos/${RepositoryName.parse(repository)}`;

  return {
    pullRequest: async (repository, number) => {
      const pull = await read(`${repo(repository)}/pulls/${number}`, PullJson);
      return {
        number: pull.number,
        open: pull.state === "open",
        merged: pull.merged === true || (pull.merged_at !== undefined && pull.merged_at !== null),
        mergeCommit: pull.merge_commit_sha ?? null,
        head: pull.head.sha,
        headRef: pull.head.ref,
        headRepository: pull.head.repo?.full_name ?? null,
        base: pull.base.ref,
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
    issueOpen: async (repository, number) => {
      const path = `${repo(repository)}/issues/${number}`;
      const response = await send("GET", path);
      if (response.status === 404 || response.status === 410) {
        return null;
      }
      if (!response.ok) {
        throw await failure("GET", path, response);
      }
      const parsed = IssueJson.safeParse(await response.json());
      if (!parsed.success) {
        throw new ForgeError(`GitHub answered GET ${path} in an unexpected shape`, response.status);
      }
      return parsed.data.state === "open";
    },
    closeIssue: async (repository, number) => {
      const path = `${repo(repository)}/issues/${number}`;
      const response = await send("PATCH", path, { state: "closed", state_reason: "completed" });
      if (!response.ok) {
        throw await failure("PATCH", path, response);
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
