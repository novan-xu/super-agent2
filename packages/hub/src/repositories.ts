import { GitHubAccount, type RepositoryAccount, RepositoryName } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { accountFor } from "./filing.js";

export interface RepositoryAccounts {
  accountOf(repository: string): GitHubAccount;
  list(): RepositoryAccount[];
  set(repository: string, account: GitHubAccount): boolean;
}

const NameRow = z.object({ repository: z.string() });
const AccountRow = z.object({ repository: z.string(), account: z.string() });

export function repositoryAccountList(names: readonly string[], chosen: ReadonlyMap<string, GitHubAccount>): RepositoryAccount[] {
  const known = new Map<string, string>();
  for (const name of [...names, ...chosen.keys()]) {
    if (RepositoryName.safeParse(name).success && !known.has(name.toLowerCase())) {
      known.set(name.toLowerCase(), name);
    }
  }
  return [...known.values()]
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
    .map((repository) => {
      const own = chosen.get(repository.toLowerCase());
      return { repository, account: own ?? accountFor(repository), chosen: own !== undefined };
    });
}

export function createRepositoryAccounts(database: HubDatabase, clock: Clock, source?: string): RepositoryAccounts {
  const { connection } = database;
  const selectNames = connection.prepare(
    "SELECT DISTINCT repository FROM tickets WHERE repository IS NOT NULL",
  );
  const selectChosen = connection.prepare("SELECT repository, account FROM repository_accounts");
  const selectOne = connection.prepare("SELECT repository, account FROM repository_accounts WHERE repository = ?");
  const upsert = connection.prepare(
    "INSERT INTO repository_accounts (repository, account, updated_at) VALUES (?, ?, ?) ON CONFLICT (repository) DO UPDATE SET account = excluded.account, updated_at = excluded.updated_at",
  );
  const remove = connection.prepare("DELETE FROM repository_accounts WHERE repository = ?");

  const chosen = (): Map<string, GitHubAccount> => {
    const map = new Map<string, GitHubAccount>();
    for (const row of selectChosen.all()) {
      const value = AccountRow.parse(row);
      const account = GitHubAccount.safeParse(value.account);
      if (account.success) {
        map.set(value.repository, account.data);
      }
    }
    return map;
  };

  return {
    accountOf: (repository) => {
      const row = selectOne.get(repository.toLowerCase());
      const account = row === undefined ? undefined : GitHubAccount.safeParse(AccountRow.parse(row).account);
      return account?.success === true ? account.data : accountFor(repository);
    },
    list: () => {
      const names = selectNames.all().map((row) => NameRow.parse(row).repository);
      return repositoryAccountList(source === undefined ? names : [...names, source], chosen());
    },
    set: (repository, account) => {
      if (!RepositoryName.safeParse(repository).success) {
        return false;
      }
      const key = repository.toLowerCase();
      if (account === accountFor(repository)) {
        remove.run(key);
      } else {
        upsert.run(key, account, clock.now());
      }
      return true;
    },
  };
}
