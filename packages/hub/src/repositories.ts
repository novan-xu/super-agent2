import { GitHubAccount, type RepositoryAccount, RepositoryName } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { accountFor } from "./filing.js";

export interface RepositoryAccounts {
  accountOf(repository: string): GitHubAccount;
  conversationNames(): string[];
  list(): RepositoryAccount[];
  set(repository: string, account: GitHubAccount): boolean;
  setPinned(repository: string, pinned: boolean): boolean;
  setAlias(repository: string, alias: string | null): boolean;
  replaceDiscovered(accounts: readonly GitHubAccount[], found: readonly DiscoveredRepository[]): void;
}

export interface DiscoveredRepository {
  readonly repository: string;
  readonly account: GitHubAccount | null;
  readonly archived: boolean;
}

const NameRow = z.object({ repository: z.string() });
const AccountRow = z.object({ repository: z.string(), account: z.string() });
const CatalogRow = z.object({
  repository: z.string(),
  account: GitHubAccount.nullable(),
  pinned: z.number(),
  pinned_order: z.number().nullable(),
  alias: z.string().nullable(),
  listed: z.number(),
  github_archived: z.number(),
});

function sortedNames(names: ReadonlyMap<string, string>): string[] {
  return [...names.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, name]) => name);
}

export function createRepositoryAccounts(database: HubDatabase, clock: Clock, source?: string): RepositoryAccounts {
  const { connection } = database;
  const selectNames = connection.prepare(
    "SELECT DISTINCT coalesce(repository, project) AS repository FROM tickets WHERE repository IS NOT NULL OR project IS NOT NULL",
  );
  const selectChosen = connection.prepare("SELECT repository, account FROM repository_accounts");
  const selectOne = connection.prepare("SELECT repository, account FROM repository_accounts WHERE repository = ?");
  const selectCatalog = connection.prepare("SELECT * FROM repositories");
  const selectDiscoveredAccount = connection.prepare("SELECT account FROM repositories WHERE repository = ?");
  const upsert = connection.prepare(
    "INSERT INTO repository_accounts (repository, account, updated_at) VALUES (?, ?, ?) ON CONFLICT (repository) DO UPDATE SET account = excluded.account, updated_at = excluded.updated_at",
  );
  const remove = connection.prepare("DELETE FROM repository_accounts WHERE repository = ?");
  const setPin = connection.prepare(
    `INSERT INTO repositories (repository, pinned, pinned_order)
     VALUES (?, ?, CASE WHEN ? = 1 THEN (SELECT coalesce(max(pinned_order), 0) + 1 FROM repositories) ELSE NULL END)
     ON CONFLICT (repository) DO UPDATE SET pinned = excluded.pinned,
       pinned_order = CASE WHEN excluded.pinned = 0 THEN NULL WHEN repositories.pinned = 1 THEN repositories.pinned_order ELSE excluded.pinned_order END`,
  );
  const setAlias = connection.prepare("INSERT INTO repositories (repository, alias) VALUES (?, ?) ON CONFLICT (repository) DO UPDATE SET alias = excluded.alias");
  const clearListed = connection.prepare("UPDATE repositories SET listed = 0 WHERE account = ? AND listed = 1");
  const record = connection.prepare(`
    INSERT INTO repositories (repository, account, listed, github_archived) VALUES (?, ?, ?, ?)
    ON CONFLICT (repository) DO UPDATE SET
      repository = excluded.repository,
      account = CASE WHEN repositories.listed = 1 AND repositories.account = 'novan-xu'
        THEN repositories.account ELSE coalesce(excluded.account, repositories.account) END,
      listed = CASE WHEN excluded.github_archived = 1 THEN 0 ELSE max(repositories.listed, excluded.listed) END,
      github_archived = excluded.github_archived
  `);

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

  const knownNames = (overrides: ReadonlyMap<string, GitHubAccount>) => {
    const names = selectNames.all().map((row) => NameRow.parse(row).repository);
    if (source !== undefined) names.push(source);
    const known = new Map<string, string>();
    for (const name of [...names, ...overrides.keys()]) {
      const key = name.toLowerCase();
      if (RepositoryName.safeParse(name).success && !known.has(key)) known.set(key, name);
    }
    return known;
  };
  const defaultAccount = (repository: string) => {
    const account = GitHubAccount.safeParse(selectDiscoveredAccount.get(repository)?.account);
    return account.success ? account.data : accountFor(repository);
  };
  const list = (): RepositoryAccount[] => {
    const overrides = chosen();
    const names = knownNames(overrides);
    const catalog = new Map(selectCatalog.all().map((row) => {
      const stored = CatalogRow.parse(row);
      return [stored.repository.toLowerCase(), stored] as const;
    }));
    for (const [key, stored] of catalog) {
      if (stored.github_archived === 1) names.delete(key);
      else if (stored.listed === 1) names.set(key, stored.repository);
    }
    return sortedNames(names).map((repository) => {
      const key = repository.toLowerCase();
      const stored = catalog.get(key);
      const override = overrides.get(key);
      return { repository, account: override ?? stored?.account ?? accountFor(repository), chosen: override !== undefined, pinned: stored?.pinned === 1, ...(stored?.pinned_order == null ? {} : { pinnedOrder: stored.pinned_order }), ...(stored?.alias == null ? {} : { alias: stored.alias }) };
    });
  };

  return {
    accountOf: (repository) => {
      const row = selectOne.get(repository.toLowerCase());
      const account = row === undefined ? undefined : GitHubAccount.safeParse(AccountRow.parse(row).account);
      return account?.success === true ? account.data : defaultAccount(repository);
    },
    conversationNames: () => sortedNames(knownNames(chosen())),
    list,
    set: (repository, account) => {
      if (!RepositoryName.safeParse(repository).success) {
        return false;
      }
      const key = repository.toLowerCase();
      if (account === defaultAccount(repository)) {
        remove.run(key);
      } else {
        upsert.run(key, account, clock.now());
      }
      return true;
    },
    setPinned: (repository, pinned) => {
      const key = repository.toLowerCase();
      const known = list().find((row) => row.repository.toLowerCase() === key);
      if (known === undefined) return false;
      setPin.run(known.repository, Number(pinned), Number(pinned));
      return true;
    },
    setAlias: (repository, alias) => {
      const known = list().find((row) => row.repository.toLowerCase() === repository.toLowerCase());
      if (known === undefined) return false;
      setAlias.run(known.repository, alias?.trim() || null);
      return true;
    },
    replaceDiscovered: (accounts, found) => {
      connection.exec("BEGIN IMMEDIATE");
      try {
        for (const account of accounts) clearListed.run(account);
        for (const { repository, account, archived } of found) {
          record.run(repository, account, Number(account !== null && !archived), Number(archived));
        }
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
