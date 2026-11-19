import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HubDatabase, openDatabase } from "./database.js";
import { migrations } from "./migrations.js";
import { createRepositoryAccounts } from "./repositories.js";
import { createRepositoryDiscovery } from "./repository-discovery.js";
import { TestClock } from "./testing/access.js";
import { createTicketService } from "./tickets.js";

const base = "https://forge.example";
const organizationRepo = "Island-Exterior-Fabricators/Design";
let dataDir: string;
let clock: TestClock;
const opened: HubDatabase[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-repositories-"));
  clock = new TestClock();
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function open(versions = migrations) {
  const database = openDatabase({ dataDir, clock, migrations: versions });
  opened.push(database);
  return database;
}

function addTicket(database: HubDatabase, repository: string, number: number) {
  const title = { en: "Example work", zh: "示例工单" };
  createTicketService({ database, clock }).open({
    repository, kind: "feature", title, summary: title,
    issues: [{ repository, number, url: `https://github.com/${repository}/issues/${number}`, title, summary: title }],
  });
}

function githubRepo(full_name: string, archived = false, pushed_at: string | null = "2026-11-19T00:00:00Z") {
  return { full_name, owner: { login: full_name.split("/")[0] }, archived, pushed_at, default_branch: "main" };
}

function startDiscovery(repositories: ReturnType<typeof createRepositoryAccounts>, fetch: typeof globalThis.fetch) {
  const report = vi.fn();
  const changed = vi.fn();
  const discovery = createRepositoryDiscovery({
    repositories, clock, fetch, base, changed, report,
    credentials: (account) => ({ ok: true, credentials: { GITHUB_TOKEN: account } }),
  });
  return { discovery, report, changed };
}

describe("repository discovery", () => {
  it("paginates personal ownership and checks work authorship with the work credential", async () => {
    const repositories = createRepositoryAccounts(open(), clock);
    const requested: string[] = [];
    const checked: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const token = new Headers(init?.headers).get("authorization");
      if (url.pathname === "/user/repos") {
        requested.push(`${token} ${url.searchParams.get("affiliation")} ${url.searchParams.get("page")}`);
        if (token === "Bearer novan-xu") {
          return url.searchParams.get("page") === "1"
            ? Response.json([githubRepo("Novan-Xu/Personal"), githubRepo("other/stray"), githubRepo("novan-xu/Old", true)], {
              headers: { link: `<${base}/user/repos?page=2>; rel="next"` },
            })
            : Response.json([githubRepo("novan-xu/Fork")]);
        }
        return Response.json([
          githubRepo("nuofan-island/Personal"), githubRepo("nuofan-island/NoCommits"), githubRepo(organizationRepo),
          githubRepo("Island-Exterior-Fabricators/Empty", false, null), githubRepo("Island-Exterior-Fabricators/Other"),
          githubRepo("Island-Exterior-Fabricators/Old", true), githubRepo("novan-xu/personal"),
        ]);
      }
      expect(token).toBe("Bearer nuofan-island");
      expect(url.searchParams.get("author")).toBe("nuofan-island");
      const name = url.pathname.slice("/repos/".length, -"/commits".length);
      checked.push(name);
      if (name.endsWith("/Empty")) return Response.json({ message: "Git Repository is empty." }, { status: 409 });
      const authored = [organizationRepo, "nuofan-island/Personal", "novan-xu/personal"].includes(name);
      return Response.json(authored ? [{ sha: "commit" }] : []);
    };
    const { discovery, report, changed } = startDiscovery(repositories, fetcher);
    await discovery.refresh();
    expect(report).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    expect(requested).toEqual([
      "Bearer novan-xu owner 1",
      "Bearer novan-xu owner 2",
      "Bearer nuofan-island owner,collaborator,organization_member 1",
    ]);
    expect(checked).toEqual(expect.arrayContaining([organizationRepo, "nuofan-island/NoCommits", "Island-Exterior-Fabricators/Empty"]));
    expect(checked.every((name) => !name.endsWith("/Old"))).toBe(true);
    expect(repositories.list()).toEqual([
      { repository: organizationRepo, account: "nuofan-island", chosen: false, pinned: false },
      { repository: "novan-xu/Fork", account: "novan-xu", chosen: false, pinned: false },
      { repository: "Novan-Xu/Personal", account: "novan-xu", chosen: false, pinned: false },
      { repository: "nuofan-island/Personal", account: "nuofan-island", chosen: false, pinned: false },
    ]);
    expect(repositories.conversationNames()).toEqual([]);
    expect(repositories.accountOf(organizationRepo.toLowerCase())).toBe("nuofan-island");
    repositories.set(organizationRepo, "novan-xu");
    expect(repositories.accountOf(organizationRepo)).toBe("novan-xu");
    expect(repositories.list()[0]?.chosen).toBe(true);
    repositories.set(organizationRepo, "nuofan-island");
    expect(repositories.list()[0]?.chosen).toBe(false);

    await discovery.refresh();
    expect(requested).toHaveLength(3);
    const firstChecks = checked.length;
    clock.advance(60_000);
    await discovery.refresh();
    expect(requested).toHaveLength(6);
    expect(checked).toHaveLength(firstChecks);
  });

  it("keeps the full catalog on a failed refresh and restores a pin after GitHub unarchives a repository", async () => {
    const database = open();
    addTicket(database, organizationRepo, 1);
    const repositories = createRepositoryAccounts(database, clock);
    let fail = false;
    let archived = false;
    let visible = true;
    let personal = [githubRepo("novan-xu/Present")];
    let pushed = "2026-11-19T00:00:00Z";
    const { discovery, report, changed } = startDiscovery(repositories, async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/commits")) {
        return fail ? Response.json({ message: "Try again" }, { status: 503 }) : Response.json([{ sha: "commit" }]);
      }
      const token = new Headers(init?.headers).get("authorization");
      const work = visible ? [githubRepo(organizationRepo, archived, pushed)] : [];
      return Response.json(token === "Bearer novan-xu" ? personal : work);
    });
    await discovery.refresh();
    expect(repositories.setPinned(organizationRepo, true)).toBe(true);
    const previous = repositories.list();
    expect(previous.map((row) => row.repository)).toEqual([organizationRepo, "novan-xu/Present"]);
    fail = true;
    pushed = "2026-11-19T01:00:00Z";
    personal = [];
    clock.advance(60_000);
    await discovery.refresh();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("503"));
    expect(changed).toHaveBeenCalledOnce();
    expect(repositories.list()).toEqual(previous);

    fail = false;
    archived = true;
    clock.advance(60_000);
    await discovery.refresh();
    expect(repositories.list()).toEqual([]);
    expect(repositories.setPinned(organizationRepo, false)).toBe(false);
    expect(repositories.conversationNames()).toEqual([organizationRepo]);

    archived = false;
    clock.advance(60_000);
    await discovery.refresh();
    expect(repositories.list()).toEqual([{ repository: organizationRepo, account: "nuofan-island", chosen: false, pinned: true }]);
    expect(createRepositoryAccounts(open(), clock).list()).toEqual(repositories.list());
    visible = false;
    clock.advance(60_000);
    await discovery.refresh();
    expect(repositories.list()).toEqual([{ repository: organizationRepo, account: "nuofan-island", chosen: false, pinned: true }]);
  });
});

it("migrates existing ticket repositories once and leaves later repositories archived", () => {
  const previous = open(migrations.slice(0, -1));
  addTicket(previous, "novan-xu/Existing", 1);
  addTicket(previous, "novan-xu/existing", 2);
  const database = open();
  addTicket(database, "novan-xu/Later", 3);
  const repositories = createRepositoryAccounts(database, clock);
  expect(repositories.list().map(({ repository, pinned }) => [repository.toLowerCase(), pinned])).toEqual([
    ["novan-xu/existing", true], ["novan-xu/later", false],
  ]);
  expect(repositories.setPinned("novan-xu/existing", false)).toBe(true);
  expect(createRepositoryAccounts(open(), clock).list().every((row) => !row.pinned)).toBe(true);
});
