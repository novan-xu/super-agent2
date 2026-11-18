import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandGate, type CommandService, createCommandService } from "./commands.js";
import { type HubDatabase, openDatabase } from "./database.js";
import {
  accountFor,
  commandIssueHost,
  createIssueCommand,
  createIssueFiler,
  type FileIssueRequest,
  type IssueFiler,
  readIssueCommand,
  recentIssuesCommand,
  sameText,
} from "./filing.js";
import { TestClock } from "./testing/access.js";
import { testCredentials, testTokens } from "./testing/commands.js";
import { type FakeGitHub, fakeGitHub } from "./testing/github.js";
import { createTicketService, type TicketService } from "./tickets.js";

let dataDir: string;
let scratchDir: string;
let database: HubDatabase;
let commands: CommandService;
let tickets: TicketService;
let github: FakeGitHub;
let filer: IssueFiler;
const cleanups: (() => void | Promise<void>)[] = [];

const sandbox = "novan-xu/super-agent-sandbox";

function setUp(gate?: CommandGate): void {
  const clock = new TestClock();
  database = openDatabase({ dataDir, clock });
  database.connection.prepare("INSERT INTO conversations (id, title, state, created_at, updated_at) VALUES ('c-1', 'Code', 'idle', ?, ?)").run(clock.now(), clock.now());
  github = fakeGitHub();
  github.repositories.set(sandbox, []);
  github.repositories.set("nuofan-island/notes", []);
  commands = createCommandService({ database, clock, targets: [github], credentials: testCredentials, ...(gate === undefined ? {} : { gate }) });
  tickets = createTicketService({ database, clock });
  filer = createIssueFiler({ host: commandIssueHost({ commands, scratchDir }), tickets, database, clock });
  const opened = { commands, database };
  cleanups.push(() => opened.commands.close(), () => opened.database.close());
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-filing-"));
  scratchDir = join(dataDir, "scratch");
});

afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function filing(overrides: Partial<FileIssueRequest> = {}): FileIssueRequest {
  return {
    repository: sandbox,
    title: { en: "Print a greeting on start", zh: "启动时打印问候" },
    summary: { en: "The program greets the user when it starts.", zh: "程序启动时向用户问好。" },
    body: "## Goal\n\nPrint `hello` when the program starts.\n\n## Assumptions\n\n- English only.\n",
    kind: "feature",
    conversation: "c-1",
    ...overrides,
  };
}

describe("filing an issue", () => {
  it("creates the issue as the repository's owner through the command channel and opens a pending ticket", async () => {
    setUp();
    const outcome = await filer.file(filing({ difficulty: "mechanical", platform: "any" }));
    expect(outcome).toMatchObject({ ok: true, issueCreated: true, ticketExisted: false });
    if (!outcome.ok) {
      return;
    }
    expect(outcome.ticket).toMatchObject({
      repository: sandbox,
      state: "pending",
      kind: "feature",
      difficulty: "mechanical",
      platform: "any",
      conversation: "c-1",
      title: { en: "Print a greeting on start", zh: "启动时打印问候" },
    });
    expect(outcome.ticket.issues).toEqual([
      {
        repository: sandbox,
        number: 1,
        url: `https://github.com/${sandbox}/issues/1`,
        title: { en: "Print a greeting on start", zh: "启动时打印问候" },
        summary: { en: "The program greets the user when it starts.", zh: "程序启动时向用户问好。" },
      },
    ]);
    expect(github.repositories.get(sandbox)?.[0]).toMatchObject({ title: "Print a greeting on start", body: filing().body.trim() });
    expect(github.jobs.every((job) => job.credentials.GH_TOKEN === testTokens["novan-xu"])).toBe(true);
    expect(commands.list().map((command) => command.target)).toEqual(["hub"]);
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("acts as nuofan-island in that account's repositories", async () => {
    setUp();
    const outcome = await filer.file(filing({ repository: "nuofan-island/notes" }));
    expect(outcome.ok).toBe(true);
    expect(github.jobs.map((job) => job.credentials.GH_TOKEN)).toEqual([testTokens["nuofan-island"]]);
  });

  it("does not create the issue again when the call is repeated after the creation failed part-way", async () => {
    setUp();
    github.failAfterCreate = 1;
    const first = await filer.file(filing());
    expect(first).toMatchObject({ ok: false, held: false });
    expect(github.created).toBe(1);
    expect(tickets.list()).toEqual([]);
    const second = await filer.file(filing());
    expect(second).toMatchObject({ ok: true, issueCreated: false, ticketExisted: false });
    expect(github.created).toBe(1);
    expect(tickets.list()).toHaveLength(1);
    expect(github.jobs.map((job) => job.command.split(" ")[2])).toEqual([
      `"repos/${sandbox}/issues"`,
      `"repos/${sandbox}/issues?state=all&sort=created&direction=desc&per_page=100&since=2026-11-17T11:50:00Z"`,
    ]);
    const third = await filer.file(filing());
    expect(third).toMatchObject({ ok: true, ticketExisted: true });
    expect(github.jobs).toHaveLength(2);
  });

  it("creates the issue on a repeat when the earlier attempt never reached GitHub", async () => {
    setUp();
    github.repositories.delete(sandbox);
    expect(await filer.file(filing())).toMatchObject({ ok: false });
    github.repositories.set(sandbox, []);
    expect(await filer.file(filing())).toMatchObject({ ok: true, issueCreated: true });
    expect(github.created).toBe(1);
  });

  it("returns the same ticket when the whole call is repeated, without asking GitHub again", async () => {
    setUp();
    const first = await filer.file(filing());
    const again = await filer.file(filing({ body: `${filing().body}\r\n` }));
    expect(again).toMatchObject({ ok: true, issueCreated: false, ticketExisted: true });
    expect(first.ok && again.ok && first.ticket.id === again.ticket.id).toBe(true);
    expect(github.created).toBe(1);
    expect(github.jobs).toHaveLength(1);
  });

  it("files one issue for two identical calls made at the same time", async () => {
    setUp();
    const [a, b] = await Promise.all([filer.file(filing()), filer.file(filing())]);
    expect(github.created).toBe(1);
    expect(a.ok && b.ok && a.ticket.id === b.ticket.id).toBe(true);
  });

  it("files a second issue when the body differs", async () => {
    setUp();
    await filer.file(filing());
    const other = await filer.file(filing({ body: "Something else entirely." }));
    expect(other).toMatchObject({ ok: true, issueCreated: true });
    expect(github.created).toBe(2);
  });

  it("refuses writing work, a malformed repository and an empty body without running anything", async () => {
    setUp();
    expect(await filer.file(filing({ kind: "writing" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/Writing/) });
    expect(await filer.file(filing({ repository: "not a repository" }))).toMatchObject({ ok: false });
    expect(await filer.file(filing({ body: "  " }))).toMatchObject({ ok: false, reason: expect.stringMatching(/empty/) });
    expect(await filer.file(filing({ title: { en: "Hello", zh: "Hello" } }))).toMatchObject({ ok: false });
    expect(github.jobs).toEqual([]);
  });

  it("reports what GitHub said when it refuses", async () => {
    setUp();
    const outcome = await filer.file(filing({ repository: "novan-xu/missing" }));
    expect(outcome).toMatchObject({ ok: false, held: false, reason: expect.stringContaining("Not Found") });
  });

  it("says the command is held rather than failed when the lock holds it", async () => {
    setUp((_command, control) => {
      control.hold("Held for the test");
      return new Promise(() => undefined);
    });
    const outcome = await filer.file(filing());
    expect(outcome).toMatchObject({ ok: false, held: true, reason: expect.stringContaining("Held for the test") });
  });
});

describe("a ticket for an existing issue", () => {
  it("reads the issue from GitHub and opens a pending ticket with its English title", async () => {
    setUp();
    github.repositories.set(sandbox, [{ number: 1, title: "Fix the typo in the README", body: "It says teh.", state: "open", pullRequest: false }]);
    const outcome = await filer.open({
      repository: sandbox,
      number: 1,
      titleZh: "修正 README 里的错字",
      summary: { en: "Fix one typo.", zh: "修一个错字。" },
      kind: "parameter",
    });
    expect(outcome).toMatchObject({
      ok: true,
      issueCreated: false,
      ticketExisted: false,
      ticket: { kind: "parameter", title: { en: "Fix the typo in the README", zh: "修正 README 里的错字" }, issues: [{ number: 1 }] },
    });
    const again = await filer.open({ repository: sandbox, number: 1, titleZh: "修正错字", summary: { en: "x", zh: "修" }, kind: "fix" });
    expect(again).toMatchObject({ ok: true, ticketExisted: true });
    expect(tickets.list()).toHaveLength(1);
  });

  it("opens a new ticket for an issue whose earlier ticket stopped", async () => {
    setUp();
    github.repositories.set(sandbox, [{ number: 1, title: "Fix it", body: "", state: "open", pullRequest: false }]);
    const request = { repository: sandbox, number: 1, titleZh: "修好它", summary: { en: "Fix it.", zh: "修好它。" }, kind: "fix" } as const;
    const first = await filer.open(request);
    if (!first.ok) {
      throw new Error(first.reason);
    }
    tickets.stop(first.ticket.id, { en: "Try again", zh: "重来" });
    const second = await filer.open(request);
    expect(second).toMatchObject({ ok: true, ticketExisted: false });
    expect(second.ok && second.ticket.id !== first.ticket.id).toBe(true);
  });

  it("refuses a pull request, a closed issue and one that does not exist", async () => {
    setUp();
    github.repositories.set(sandbox, [
      { number: 1, title: "A change", body: "", state: "open", pullRequest: true },
      { number: 2, title: "Done", body: "", state: "closed", pullRequest: false },
    ]);
    const base = { repository: sandbox, titleZh: "某事", summary: { en: "x", zh: "某事" }, kind: "fix" } as const;
    expect(await filer.open({ ...base, number: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/pull request/) });
    expect(await filer.open({ ...base, number: 2 })).toMatchObject({ ok: false, reason: expect.stringMatching(/closed/) });
    expect(await filer.open({ ...base, number: 3 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Not Found/) });
    expect(tickets.list()).toEqual([]);
  });
});

describe("the commands behind filing", () => {
  it("quotes only names it has checked, so either shell reads them the same", () => {
    expect(recentIssuesCommand(sandbox, Date.UTC(2026, 10, 17, 9, 30, 15, 250))).toBe(`gh api "repos/${sandbox}/issues?state=all&sort=created&direction=desc&per_page=100&since=2026-11-17T09:30:15Z"`);
    expect(readIssueCommand(sandbox, 12)).toBe(`gh api "repos/${sandbox}/issues/12"`);
    expect(createIssueCommand(sandbox, "/tmp/x/1.json")).toBe(`gh api "repos/${sandbox}/issues" --method POST --input "/tmp/x/1.json"`);
    expect(() => recentIssuesCommand('a/b" && rm -rf / "', 0)).toThrow();
    expect(() => createIssueCommand(sandbox, '/tmp/x"y.json')).toThrow();
    expect(() => createIssueCommand(sandbox, "/tmp/%PATH%.json")).toThrow();
    expect(() => readIssueCommand(sandbox, 0)).toThrow();
  });

  it("chooses the owner's account, or the one given", () => {
    expect(accountFor("novan-xu/x")).toBe("novan-xu");
    expect(accountFor("Nuofan-Island/x")).toBe("nuofan-island");
    expect(accountFor("someone-else/x")).toBe("novan-xu");
    expect(accountFor("novan-xu/x", "nuofan-island")).toBe("nuofan-island");
  });

  it("compares text as GitHub returns it", () => {
    expect(sameText("a\r\nb\n", "a\nb")).toBe(true);
    expect(sameText("a b", "a  b")).toBe(false);
  });

  it("leaves no scratch file behind when the creation fails", async () => {
    setUp();
    github.failAfterCreate = 1;
    await filer.file(filing());
    expect(existsSync(scratchDir) ? readdirSync(scratchDir) : []).toEqual([]);
  });

  it("names the scratch file by the folder's real path when the folder is reached through a name a shell would read", async () => {
    const real = join(dataDir, "real");
    mkdirSync(real);
    scratchDir = join(dataDir, "SCRATC~1");
    symlinkSync(real, scratchDir, "junction");
    setUp();
    const outcome = await filer.file(filing());
    expect(outcome.ok).toBe(true);
    expect(readdirSync(real)).toEqual([]);
  });
});
