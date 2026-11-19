import { type GitHubAccount, gitHubAccounts } from "@super-agent2/protocol";
import type { Clock } from "./clock.js";
import type { CredentialSource } from "./credentials.js";
import { createGitHubApi, type Fetch, type GitHubRepository } from "./github-api.js";
import type { DiscoveredRepository, RepositoryAccounts } from "./repositories.js";

const refreshCooldown = 60_000;
const checkLifetime = 24 * 60 * 60 * 1000;
const checksInParallel = 5;

interface DiscoveryOptions {
  readonly repositories: RepositoryAccounts;
  readonly credentials: CredentialSource;
  readonly clock: Clock;
  readonly fetch: Fetch;
  readonly base?: string;
  readonly changed: () => void;
  readonly report: (line: string) => void;
}

interface CommitCheck {
  readonly pushedAt: string | null;
  readonly branch: string;
  readonly checkedAt: number;
  readonly authored: boolean;
}

export function createRepositoryDiscovery(options: DiscoveryOptions) {
  const stop = new AbortController();
  const { signal } = stop;
  let startedAt = -Infinity;
  let pending: Promise<void> | undefined;
  let previousChecks = new Map<string, CommitCheck>();

  const discover = async (now: number) => {
    const accounts: GitHubAccount[] = [];
    const found = new Map<string, DiscoveredRepository>();
    const checked = new Map<string, CommitCheck>();
    const observe = (row: GitHubRepository, account: GitHubAccount | null) => {
      const key = row.full_name.toLowerCase();
      const existing = found.get(key);
      if (existing === undefined || row.archived || (!existing.archived && existing.account === null)) {
        found.set(key, { repository: row.full_name, account, archived: row.archived });
      }
    };

    for (const account of gitHubAccounts) {
      signal.throwIfAborted();
      const credentials = options.credentials(account);
      if (!credentials.ok) continue;
      const token = credentials.credentials.GITHUB_TOKEN ?? credentials.credentials.GH_TOKEN;
      if (!token) continue;
      const api = createGitHubApi({ fetch: options.fetch, token, signal, ...(options.base === undefined ? {} : { base: options.base }) });
      const personal = account === "novan-xu";
      const rows = await api.repositories(personal ? "owner" : "owner,collaborator,organization_member");
      accounts.push(account);
      if (personal) {
        for (const row of rows) {
          if (row.owner.login.toLowerCase() === account) observe(row, row.archived ? null : account);
        }
        continue;
      }
      for (const row of rows.filter((row) => row.archived)) observe(row, null);
      const candidates = rows.filter((row) => !row.archived);
      for (let offset = 0; offset < candidates.length; offset += checksInParallel) {
        signal.throwIfAborted();
        const batch = candidates.slice(offset, offset + checksInParallel);
        await Promise.all(batch.map(async (row) => {
          const key = row.full_name.toLowerCase();
          const last = previousChecks.get(key);
          const check = last !== undefined && last.pushedAt === row.pushed_at && last.branch === row.default_branch && now - last.checkedAt < checkLifetime
            ? last
            : { pushedAt: row.pushed_at, branch: row.default_branch, checkedAt: now, authored: await api.hasAuthoredCommits(row.full_name, account) };
          checked.set(key, check);
          observe(row, check.authored ? account : null);
        }));
      }
    }
    if (!signal.aborted && accounts.length > 0) {
      options.repositories.replaceDiscovered(accounts, [...found.values()]);
      previousChecks = checked;
      options.changed();
    }
  };

  return {
    refresh: (): Promise<void> => {
      if (pending !== undefined) return pending;
      const now = options.clock.now();
      if (signal.aborted || now - startedAt < refreshCooldown) return Promise.resolve();
      startedAt = now;
      pending = discover(now).catch((error: unknown) => {
        if (!signal.aborted) options.report(`Refreshing GitHub repositories failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { pending = undefined; });
      return pending;
    },
    close: () => stop.abort(),
  };
}
