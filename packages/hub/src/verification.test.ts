import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChainDefaults, type Chains, createChains } from "./chains.js";
import type { CredentialSource } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { TestClock } from "./testing/access.js";
import { type FakeForge, fakeForge, fakeGitHubBase, type FakePipeline, fakeWoodpeckerServer } from "./testing/forge.js";
import { createTicketService, type TicketService } from "./tickets.js";
import { createVerification, judge, type VerificationService, workflowName } from "./verification.js";

const repository = "novan-xu/super-agent-sandbox";
const twoWorkflows = [".woodpecker/check-macos.yaml", ".woodpecker/check-windows.yaml"];

interface Told {
  readonly conversation: string | null;
  readonly notice: string;
  readonly prompt: string;
}

let dataDir: string;
let clock: TestClock;
let forge: FakeForge;
let databases: HubDatabase[];
let database: HubDatabase;
let tickets: TicketService;
let chains: Chains;
let verification: VerificationService;
let told: Told[];
let begun: number[];
let sentBack: { readonly ticket: number; readonly note: string }[];
let ticks: (() => void)[];
let withWoodpecker: boolean;

const noDefaults: ChainDefaults = {
  resolve: () => {
    throw new Error("not used");
  },
  machinesFor: () => [],
  machines: () => [],
};

const credentials: CredentialSource = (account) => ({
  ok: true,
  credentials: {
    GH_TOKEN: `token-of-${account}`,
    GITHUB_TOKEN: `token-of-${account}`,
    ...(withWoodpecker ? { WOODPECKER_SERVER: fakeWoodpeckerServer, WOODPECKER_TOKEN: "woodpecker-token" } : {}),
  },
});

function open(): void {
  database = openDatabase({ dataDir, clock });
  databases.push(database);
  tickets = createTicketService({ database, clock, work: { begin: () => undefined, stop: () => undefined } });
  chains = createChains({
    database,
    clock,
    tickets,
    verify: () => Promise.resolve({ ok: false, reason: "not used" }),
    ownerEmail: "owner@example.com",
    defaults: noDefaults,
    work: { begin: (ticket) => void begun.push(ticket.id), stop: () => undefined },
  });
  verification = createVerification({
    database,
    clock,
    tickets,
    credentials,
    fetch: forge.fetch,
    gitHubBase: fakeGitHubBase,
    ticker: (tick) => {
      ticks.push(tick);
      return () => undefined;
    },
    tell: (conversation, notice, prompt) => void told.push({ conversation, notice, prompt }),
    sendBack: (ticket, note, reason) => {
      sentBack.push({ ticket, note });
      const moved = tickets.move(ticket, "working", reason);
      return moved.ok ? { ok: true } : { ok: false, reason: moved.error };
    },
  });
}

async function shut(): Promise<void> {
  verification.close();
  await verification.idle();
  chains.close();
  await chains.idle();
  database.close();
}

function restart(): void {
  open();
  verification.resume();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-verification-"));
  clock = new TestClock();
  forge = fakeForge();
  databases = [];
  told = [];
  begun = [];
  sentBack = [];
  ticks = [];
  withWoodpecker = true;
  open();
});

afterEach(async () => {
  verification.close();
  await verification.idle();
  chains.close();
  await chains.idle();
  for (const opened of databases) {
    try {
      opened.close();
    } catch {
      continue;
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function current(id: number): Ticket {
  const ticket = tickets.get(id);
  if (ticket === undefined) {
    throw new Error(`ticket ${id} missing`);
  }
  return ticket;
}

function openTicket(issues: readonly number[], waitsFor: readonly number[] = []): Ticket {
  for (const number of issues) {
    forge.repository(repository).issues.set(number, "open");
  }
  const summary = { en: "Change it", zh: "改一下" };
  return tickets.open({
    repository,
    issues: issues.map((number) => ({ repository, number, url: `https://github.com/${repository}/issues/${number}`, title: { en: `Issue ${number}`, zh: `问题 ${number}` }, summary })),
    title: { en: `Ticket for ${issues.join(", ")}`, zh: `问题 ${issues.join("、")} 的工单` },
    summary,
    kind: "feature",
    conversation: "c-1",
    waitsFor,
  });
}

function verifying(issues: readonly number[], pull: number, head: string, files: readonly string[], tree: readonly string[] = files): Ticket {
  const ticket = openTicket(issues);
  const branch = `sa2/ticket-${ticket.id}-beef`;
  forge.pull(repository, pull, head, files, branch);
  forge.tree(repository, head, tree);
  tickets.change((writes) => {
    writes.choose(ticket.id, { machine: "pc", engine: "codex", model: "gpt-6-luna", effort: "medium", by: { machine: "default", engine: "default", model: "default", effort: "default" } });
    writes.move(ticket.id, "working");
    writes.setBranch(ticket.id, branch);
    writes.setPullRequest(ticket.id, pull, { en: "Done", zh: "做完了" });
    writes.move(ticket.id, "verifying");
  });
  return current(ticket.id);
}

function handBack(id: number): void {
  tickets.change((writes) => writes.move(id, "verifying"));
}

function woodpeckerRepository(): void {
  forge.woodpecker.set(repository, { id: 6, active: true, configFile: "", pipelines: [] });
}

let stepIds = 100;

function pipeline(number: number, commit: string, pull: number, status: string, workflows: readonly (readonly [string, string])[], config: readonly string[] = ["check-macos", "check-windows"]): FakePipeline {
  const created: FakePipeline = {
    number,
    commit,
    ref: `refs/pull/${pull}/merge`,
    event: "pull_request",
    status,
    workflows: workflows.map(([name, state]) => {
      stepIds += 2;
      return {
        name,
        state,
        steps: [
          { id: stepIds, name: "clone", state: "success", exitCode: 0 },
          { id: stepIds + 1, name: "check", state: state === "failure" ? "failure" : state, exitCode: state === "failure" ? 1 : 0 },
        ],
      };
    }),
    config: [...config],
  };
  const found = forge.woodpecker.get(repository);
  if (found === undefined) {
    throw new Error("no Woodpecker repository");
  }
  found.pipelines = [...found.pipelines.filter((entry) => entry.number !== number), created];
  return created;
}

async function settle(): Promise<void> {
  await verification.idle();
  await chains.idle();
}

async function poll(): Promise<void> {
  await verification.poll();
  await settle();
}

function mergeCalls(): string[] {
  return forge.calledWith(/^PUT .*\/merge$/);
}

describe("which files are text and documentation", () => {
  it("names workflows the way Woodpecker does", () => {
    expect(workflowName(".woodpecker/check-macos.yaml")).toBe("check-macos");
    expect(workflowName(".woodpecker/build.yml")).toBe("build");
    expect(workflowName(".woodpecker.yaml")).toBe("woodpecker");
  });
});

describe("a documentation-only pull request", () => {
  it("merges without waiting for any pipeline, closes its issues, deletes its branch and reports", async () => {
    woodpeckerRepository();
    const ticket = verifying([21, 22], 7, "d0c5", ["docs/guide.md", "README.md", "LICENSE"], ["docs/guide.md", "README.md", "LICENSE", ...twoWorkflows]);
    await settle();
    const merged = current(ticket.id);
    expect(merged.state).toBe("merged");
    expect(merged.verification).toMatchObject({ rule: "documentation", level: "documentation", state: "merged", head: "d0c5", mergeCommit: "merge-of-d0c5", deployment: false });
    expect(forge.merges).toEqual([{ repository, number: 7, sha: "d0c5", method: "squash" }]);
    expect(forge.calledWith(/woodpecker\.test/)).toEqual([]);
    expect([...forge.repository(repository).issues]).toEqual([
      [21, "closed"],
      [22, "closed"],
    ]);
    expect(forge.repository(repository).branches.has(`sa2/ticket-${ticket.id}-beef`)).toBe(false);
    expect(tickets.moves(ticket.id).at(-1)).toMatchObject({ from: "verifying", to: "merged", reason: { zh: "只改了文本和文档，直接合并" } });
    expect(told).toHaveLength(1);
    expect(told[0]?.notice).toBe(`工单 ${ticket.id} 已合并`);
    expect(told[0]?.prompt).toContain("only text and documentation files changed");
  });

  it("counts a renamed code file as code, even when its new name is documentation", async () => {
    withWoodpecker = false;
    const ticket = openTicket([5]);
    forge.pull(repository, 9, "r1", [], `sa2/ticket-${ticket.id}-beef`).files = [{ path: "notes.md", previous: "src/notes.ts" }];
    forge.tree(repository, "r1", ["notes.md", ".woodpecker.yaml"]);
    tickets.change((writes) => {
      writes.move(ticket.id, "working");
      writes.setPullRequest(ticket.id, 9, { en: "Done", zh: "做完了" });
      writes.move(ticket.id, "verifying");
    });
    await settle();
    expect(current(ticket.id).verification).toMatchObject({ level: "code", rule: "workflows", state: "waiting", waiting: "woodpecker" });
    expect(forge.merges).toEqual([]);
  });
});

describe("a code pull request", () => {
  it("merges only after green on its head, and not on green for an older commit", async () => {
    woodpeckerRepository();
    pipeline(1, "old1", 8, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    const ticket = verifying([31], 8, "new2", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    await settle();
    expect(current(ticket.id).state).toBe("verifying");
    expect(current(ticket.id).verification).toMatchObject({ rule: "workflows", state: "waiting", waiting: "pipeline", head: "new2" });
    pipeline(2, "new2", 8, "running", [
      ["check-macos", "success"],
      ["check-windows", "running"],
    ]);
    await poll();
    expect(current(ticket.id).verification).toMatchObject({ state: "waiting", waiting: "workflows", pipeline: { number: 2, url: `${fakeWoodpeckerServer}/repos/6/pipeline/2` } });
    expect(mergeCalls()).toEqual([]);
    pipeline(2, "new2", 8, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    await poll();
    expect(current(ticket.id).state).toBe("merged");
    expect(current(ticket.id).verification).toMatchObject({ rule: "workflows", state: "merged", workflows: [{ name: "check-macos", state: "success" }, { name: "check-windows", state: "success" }] });
    expect(forge.merges).toEqual([{ repository, number: 8, sha: "new2", method: "squash" }]);
  });

  it("starts the wait again when a new commit arrives, even when the old head turns green", async () => {
    woodpeckerRepository();
    const ticket = verifying([32], 9, "c1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    pipeline(1, "c1", 9, "running", [
      ["check-macos", "running"],
      ["check-windows", "running"],
    ]);
    await poll();
    const pull = forge.repository(repository).pulls.get(9);
    if (pull === undefined) {
      throw new Error("pull missing");
    }
    pull.head = "c2";
    forge.tree(repository, "c2", ["src/app.ts", ...twoWorkflows]);
    pipeline(1, "c1", 9, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    await poll();
    expect(current(ticket.id).verification).toMatchObject({ head: "c2", state: "waiting", waiting: "pipeline" });
    expect(forge.merges).toEqual([]);
    pipeline(2, "c2", 9, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    await poll();
    expect(forge.merges).toEqual([{ repository, number: 9, sha: "c2", method: "squash" }]);
  });

  it.each([
    ["a pending pipeline", "pending", [["check-macos", "pending"], ["check-windows", "pending"]], ["check-macos", "check-windows"], "workflows"],
    ["a cancelled workflow", "killed", [["check-macos", "success"], ["check-windows", "killed"]], ["check-macos", "check-windows"], "halted"],
    ["a skipped workflow", "success", [["check-macos", "success"], ["check-windows", "skipped"]], ["check-macos", "check-windows"], "halted"],
    ["a declined pipeline", "declined", [], ["check-macos", "check-windows"], "halted"],
    ["a pipeline built without a workflow the head defines", "success", [["check-macos", "success"]], ["check-macos"], "halted"],
  ] as const)("does not merge on %s", async (_name, status, workflows, config, waiting) => {
    woodpeckerRepository();
    const ticket = verifying([33], 10, "h1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    pipeline(3, "h1", 10, status, workflows, config);
    await poll();
    await poll();
    expect(current(ticket.id).state).toBe("verifying");
    expect(current(ticket.id).verification).toMatchObject({ state: "waiting", waiting });
    expect(mergeCalls()).toEqual([]);
  });

  it("does not take a pipeline of another pull request or of a push for its own", async () => {
    woodpeckerRepository();
    const ticket = verifying([34], 11, "h2", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    const elsewhere = pipeline(4, "h2", 111, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    elsewhere.ref = "refs/pull/111/merge";
    const pushed = pipeline(5, "h2", 11, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    pushed.event = "push";
    pushed.ref = "refs/heads/sa2/ticket-1-beef";
    await poll();
    expect(current(ticket.id).verification).toMatchObject({ state: "waiting", waiting: "pipeline" });
    expect(mergeCalls()).toEqual([]);
  });

  it("accepts a workflow Woodpecker filtered out of the pipeline by its own conditions", async () => {
    woodpeckerRepository();
    const ticket = verifying([35], 12, "h3", ["src/app.ts"], ["src/app.ts", ".woodpecker/check.yaml", ".woodpecker/docs.yml"]);
    pipeline(6, "h3", 12, "success", [["check", "success"]], ["check", "docs"]);
    await poll();
    expect(current(ticket.id).state).toBe("merged");
  });

  it("stays honestly verifying while its pipeline never reports, whatever the time", async () => {
    woodpeckerRepository();
    const ticket = verifying([36], 13, "h4", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    for (let round = 0; round < 5; round += 1) {
      clock.advance(24 * 60 * 60 * 1000);
      await poll();
    }
    expect(current(ticket.id).state).toBe("verifying");
    expect(current(ticket.id).verification).toMatchObject({ state: "waiting", waiting: "pipeline" });
    expect(told).toEqual([]);
  });

  it("records a red workflow with its failing step and log, tells the brain once, and does not retry", async () => {
    woodpeckerRepository();
    const ticket = verifying([37], 14, "bad1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    const red = pipeline(7, "bad1", 14, "failure", [
      ["check-macos", "success"],
      ["check-windows", "failure"],
    ]);
    const step = red.workflows[1]?.steps[1]?.id ?? 0;
    forge.logs.set(step, ["pnpm check", "1 comment finding(s) in 321 checked file(s).", "[ELIFECYCLE] Command failed with exit code 1."]);
    await poll();
    await poll();
    const failed = current(ticket.id);
    expect(failed.state).toBe("verifying");
    expect(failed.verification).toMatchObject({ rule: "workflows", state: "failed", failures: [{ workflow: "check-windows", step: "check", exitCode: 1 }] });
    expect(verification.logs(ticket.id)).toEqual([
      { workflow: "check-windows", step: "check", exitCode: 1, log: "pnpm check\n1 comment finding(s) in 321 checked file(s).\n[ELIFECYCLE] Command failed with exit code 1." },
    ]);
    expect(told).toHaveLength(1);
    expect(told[0]?.notice).toBe(`工单 ${ticket.id} 没有通过验证，大脑会决定怎么处理`);
    expect(told[0]?.prompt).toContain("workflow check-windows, step check (exit code 1)");
    expect(told[0]?.prompt).toContain("1 comment finding(s)");
    expect(mergeCalls()).toEqual([]);
    expect(forge.calledWith(/restart|POST/)).toEqual([]);
    expect(sentBack).toEqual([]);
  });

  it("re-reads the head immediately before merging and merges only that commit", async () => {
    woodpeckerRepository();
    const ticket = verifying([38], 15, "g1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    pipeline(8, "g1", 15, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    forge.tree(repository, "g2", ["src/app.ts", "src/more.ts", ...twoWorkflows]);
    forge.beforePullRead = (_name, pull, reads) => {
      if (reads === 2) {
        pull.head = "g2";
      }
    };
    await poll();
    expect(mergeCalls()).toEqual([]);
    expect(current(ticket.id).verification).toMatchObject({ head: "g2", state: "waiting", waiting: "pipeline" });
  });

  it("is refused by GitHub when a push lands between the last read and the merge, and does not merge it", async () => {
    woodpeckerRepository();
    const ticket = verifying([39], 16, "k1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    pipeline(9, "k1", 16, "success", [
      ["check-macos", "success"],
      ["check-windows", "success"],
    ]);
    forge.tree(repository, "k2", ["src/app.ts", ...twoWorkflows]);
    forge.beforeMerge = (_name, pull) => {
      pull.head = "k2";
      forge.beforeMerge = undefined;
    };
    await poll();
    expect(forge.merges).toEqual([]);
    expect(current(ticket.id).state).toBe("verifying");
    expect(current(ticket.id).verification).toMatchObject({ head: "k2", waiting: "pipeline" });
  });
});

describe("a repository without a Woodpecker workflow", () => {
  it("merges when Woodpecker does not run the repository", async () => {
    const ticket = verifying([41], 17, "n1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    await settle();
    expect(current(ticket.id).verification).toMatchObject({ rule: "none", state: "merged" });
    expect(told[0]?.prompt).toContain("the repository has no Woodpecker workflow");
  });

  it("merges when Woodpecker runs the repository but the head defines no workflow", async () => {
    woodpeckerRepository();
    const ticket = verifying([42], 18, "n2", ["src/app.ts"]);
    await settle();
    expect(current(ticket.id).verification).toMatchObject({ rule: "none", state: "merged" });
  });

  it("reads the workflows from the head when the hub has no Woodpecker, and waits rather than guess when there are some", async () => {
    withWoodpecker = false;
    const none = verifying([43], 19, "n3", ["src/app.ts"]);
    const some = verifying([44], 20, "n4", ["src/app.ts"], ["src/app.ts", ".woodpecker.yml"]);
    await settle();
    expect(current(none.id).state).toBe("merged");
    expect(current(some.id).state).toBe("verifying");
    expect(current(some.id).verification).toMatchObject({ state: "waiting", waiting: "woodpecker" });
    expect(current(some.id).verification?.reason).toContain("(woodpecker)");
  });
});

describe("a conflict at merge time", () => {
  it("goes back to the worker, and the pull request merges after the fix", async () => {
    woodpeckerRepository();
    const ticket = verifying([51], 21, "x1", ["docs/a.md"]);
    const pull = forge.repository(repository).pulls.get(21);
    if (pull === undefined) {
      throw new Error("pull missing");
    }
    pull.mergeable = false;
    await settle();
    expect(current(ticket.id).state).toBe("working");
    expect(sentBack).toHaveLength(1);
    expect(sentBack[0]?.note).toContain("conflicts with main");
    expect(tickets.moves(ticket.id).at(-1)).toMatchObject({ from: "verifying", to: "working", reason: { zh: "和 main 有冲突，交回工作者解决" } });
    expect(forge.merges).toEqual([]);
    pull.head = "x2";
    pull.mergeable = true;
    forge.tree(repository, "x2", ["docs/a.md"]);
    handBack(ticket.id);
    await settle();
    expect(current(ticket.id).state).toBe("merged");
    expect(forge.merges).toEqual([{ repository, number: 21, sha: "x2", method: "squash" }]);
    expect(sentBack).toHaveLength(1);
  });

  it("does not send the same conflict back twice, and tells the brain it was not resolved", async () => {
    const ticket = verifying([52], 22, "y1", ["docs/a.md"]);
    const pull = forge.repository(repository).pulls.get(22);
    if (pull === undefined) {
      throw new Error("pull missing");
    }
    pull.mergeable = false;
    await settle();
    handBack(ticket.id);
    await settle();
    await poll();
    expect(sentBack).toHaveLength(1);
    expect(current(ticket.id).state).toBe("verifying");
    expect(current(ticket.id).verification).toMatchObject({ state: "conflict" });
    expect(told.map((entry) => entry.notice)).toEqual([`工单 ${ticket.id} 没有通过验证，大脑会决定怎么处理`]);
    expect(told[0]?.prompt).toContain("without resolving it");
  });
});

describe("the skip shortcut", () => {
  it("merges the current head at once with the rules skipped, and does everything a merge does", async () => {
    woodpeckerRepository();
    const ticket = verifying([61, 62], 23, "s1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    await settle();
    expect(current(ticket.id).verification).toMatchObject({ waiting: "pipeline" });
    const outcome = await verification.skip(ticket.id, "The owner wants it merged now");
    expect(outcome.ok && outcome.ticket.state).toBe("merged");
    expect(current(ticket.id).verification).toMatchObject({ rule: "skipped", skipReason: "The owner wants it merged now", mergeCommit: "merge-of-s1" });
    expect(forge.merges).toEqual([{ repository, number: 23, sha: "s1", method: "squash" }]);
    expect([...forge.repository(repository).issues.values()]).toEqual(["closed", "closed"]);
    expect(told.at(-1)?.prompt).toContain("you merged it with the rules skipped (The owner wants it merged now)");
  });

  it("refuses a ticket that is not in verifying", async () => {
    const ticket = openTicket([63]);
    expect(await verification.skip(ticket.id, "Because")).toEqual({ ok: false, reason: `Ticket ${ticket.id} is pending; only a ticket in verifying, whose worker has handed back its pull request, can be merged.` });
    expect(forge.merges).toEqual([]);
  });
});

describe("after the merge", () => {
  it("begins the ticket that waited for it, once", async () => {
    const first = verifying([71], 24, "w1", ["src/app.ts"]);
    const second = openTicket([72], [first.id]);
    tickets.change((writes) => writes.move(second.id, "waiting"));
    await settle();
    await poll();
    expect(current(first.id).state).toBe("merged");
    expect(current(second.id).state).toBe("working");
    expect(begun).toEqual([second.id]);
  });

  it("reports whether the repository has a deployment at the merged commit", async () => {
    const plain = verifying([81], 26, "p1", ["src/app.ts"]);
    const deployed = verifying([82], 27, "p2", ["src/app.ts"], ["src/app.ts", ".superagent2/deployment.json"]);
    await settle();
    expect(current(plain.id).verification?.deployment).toBe(false);
    expect(current(deployed.id).verification?.deployment).toBe(true);
    const plainReport = told.find((entry) => entry.prompt.includes(`Ticket ${plain.id} (`));
    const deployedReport = told.find((entry) => entry.prompt.includes(`Ticket ${deployed.id} (`));
    expect(plainReport?.notice).toBe(`工单 ${plain.id} 已合并`);
    expect(plainReport?.prompt).toContain("the repository has no deployment");
    expect(deployedReport?.notice).toBe(`工单 ${deployed.id} 已合并，这次改动需要部署`);
    expect(deployedReport?.prompt).toContain("so this change needs deploying");
    expect(deployedReport?.prompt).toContain("The ticket deployed nothing");
  });

  it("stops polling a ticket that is no longer verifying", async () => {
    withWoodpecker = false;
    const ticket = verifying([91], 28, "q1", ["src/app.ts"]);
    const stopped = verifying([92], 29, "q2", ["src/app.ts"], ["src/app.ts", ".woodpecker.yml"]);
    await settle();
    expect(current(stopped.id).verification).toMatchObject({ waiting: "woodpecker" });
    tickets.stop(stopped.id, { en: "Not wanted", zh: "不要了" });
    const before = forge.calls.length;
    await poll();
    await poll();
    expect(current(ticket.id).state).toBe("merged");
    expect(forge.calls.slice(before)).toEqual([]);
  });

  it("takes an issue GitHub closed itself while the hub was closing it as closed", async () => {
    forge.closedMeanwhile.add(94);
    const ticket = verifying([94], 35, "v1", ["docs/a.md"]);
    await settle();
    expect(current(ticket.id).state).toBe("merged");
    expect(forge.repository(repository).issues.get(94)).toBe("closed");
  });

  it("finishes a pull request merged on GitHub outside the hub", async () => {
    woodpeckerRepository();
    const ticket = verifying([93], 30, "o1", ["src/app.ts"], ["src/app.ts", ...twoWorkflows]);
    await settle();
    const pull = forge.repository(repository).pulls.get(30);
    if (pull === undefined) {
      throw new Error("pull missing");
    }
    pull.merged = true;
    pull.open = false;
    pull.mergeCommit = "by-hand";
    await poll();
    expect(current(ticket.id).verification).toMatchObject({ rule: "outside", state: "merged", mergeCommit: "by-hand" });
    expect(forge.merges).toEqual([]);
    expect(forge.repository(repository).issues.get(93)).toBe("closed");
  });
});

describe("merging exactly once", () => {
  it("merges once when several triggers arrive together", async () => {
    const first = verifying([101, 102], 31, "e1", ["src/app.ts"]);
    const after = openTicket([103], [first.id]);
    tickets.change((writes) => writes.move(after.id, "waiting"));
    await Promise.all([verification.check(first.id), verification.check(first.id), verification.poll(), verification.skip(first.id, "Now"), verification.check(first.id)]);
    await settle();
    expect(forge.merges).toHaveLength(1);
    expect(forge.calledWith(/^PATCH .*\/issues\/101$/)).toHaveLength(1);
    expect(forge.calledWith(/^PATCH .*\/issues\/102$/)).toHaveLength(1);
    expect(begun).toEqual([after.id]);
    expect(told.filter((entry) => entry.notice.includes("已合并"))).toHaveLength(1);
  });

  it("picks up after a restart in the middle of a merge, without merging twice", async () => {
    const first = verifying([111], 32, "r1", ["src/app.ts"]);
    const after = openTicket([112], [first.id]);
    tickets.change((writes) => writes.move(after.id, "waiting"));
    forge.loseMergeAnswer = true;
    await settle();
    expect(forge.merges).toHaveLength(1);
    expect(current(first.id).state).toBe("verifying");
    expect(current(first.id).verification).toMatchObject({ state: "waiting", waiting: "github" });
    await shut();
    restart();
    await settle();
    expect(current(first.id).state).toBe("merged");
    expect(current(first.id).verification).toMatchObject({ rule: "none", mergeCommit: "merge-of-r1" });
    expect(forge.merges).toHaveLength(1);
    expect(forge.calledWith(/^PATCH .*\/issues\/111$/)).toHaveLength(1);
    expect(begun).toEqual([after.id]);
    await poll();
    expect(forge.merges).toHaveLength(1);
    expect(begun).toEqual([after.id]);
  });

  it("finishes after a restart that came while closing the issues, and reports once", async () => {
    forge.failing = /\/issues\/122$/;
    const ticket = verifying([121, 122], 33, "t1", ["src/app.ts"]);
    await settle();
    expect(current(ticket.id).state).toBe("verifying");
    expect(current(ticket.id).verification).toMatchObject({ state: "merging", waiting: "finishing" });
    expect(forge.repository(repository).issues.get(121)).toBe("closed");
    await shut();
    forge.failing = undefined;
    restart();
    await settle();
    expect(current(ticket.id).state).toBe("merged");
    expect(forge.merges).toHaveLength(1);
    expect(forge.calledWith(/^PATCH .*\/issues\/121$/)).toHaveLength(1);
    expect(forge.calledWith(/^PATCH .*\/issues\/122$/)).toHaveLength(1);
    expect(told.filter((entry) => entry.notice.includes("已合并"))).toHaveLength(1);
    await shut();
    restart();
    await settle();
    expect(told.filter((entry) => entry.notice.includes("已合并"))).toHaveLength(1);
  });

  it("checks every ticket in verifying again after a restart, without being told", async () => {
    withWoodpecker = false;
    const ticket = verifying([131], 34, "u1", ["src/app.ts"], ["src/app.ts", ".woodpecker.yml"]);
    await settle();
    expect(current(ticket.id).state).toBe("verifying");
    await shut();
    withWoodpecker = true;
    woodpeckerRepository();
    pipeline(10, "u1", 34, "success", [["woodpecker", "success"]], ["woodpecker"]);
    restart();
    await settle();
    expect(current(ticket.id).state).toBe("merged");
    expect(ticks).toHaveLength(1);
  });
});

describe("judging a pipeline", () => {
  const base = { number: 4, status: "success", commit: "abc", errors: null };

  it("is green only when every workflow of the head's pipeline succeeded", () => {
    expect(judge("abc", ["a", "b"], { ...base, workflows: [{ name: "a", state: "success", steps: [] }, { name: "b", state: "success", steps: [] }] }, ["a", "b"]).kind).toBe("green");
    expect(judge("abd", ["a"], { ...base, workflows: [{ name: "a", state: "success", steps: [] }] }, ["a"]).kind).toBe("waiting");
    expect(judge("abc", ["a"], { ...base, workflows: [] }, ["a"]).kind).toBe("waiting");
    expect(judge("abc", ["a"], { ...base, status: "error", errors: "config not found", workflows: [] }, ["a"])).toMatchObject({ kind: "red", failed: [{ workflow: "", step: "" }] });
  });
});
