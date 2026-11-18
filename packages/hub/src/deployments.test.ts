import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRecord, deploymentFile, deploymentOutcomeMarker, type Deployment, readDeploymentFile,resolveStart, startingEngineTable, type Ticket } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccessVerifier } from "./access.js";
import { type ChainDefaults, type Chains, createChains } from "./chains.js";
import { type CommandService, createCommandService } from "./commands.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { createDeployments, type DeploymentService } from "./deployments.js";
import { lockSettings } from "./irreversible.js";
import { createKeyCache } from "./keys.js";
import { type ConfirmationLock, createConfirmationLock, fingerprintOf } from "./lock.js";
import type { ExecutionEnd, Job, Target } from "./targets.js";
import { assertion, audience, keySet, ownerEmail, signingKey, type SigningKey, staticKeySource, team, TestClock } from "./testing/access.js";
import { testCredentials, waitForState } from "./testing/commands.js";
import { type FakeForge, fakeForge, fakeGitHubBase } from "./testing/forge.js";
import { ManualTimer, settledTurn } from "./testing/timer.js";
import { createTicketService, type TicketService } from "./tickets.js";

const repository = "novan-xu/toy-service";
const first = "1111111111111111111111111111111111111111";
const second = "2222222222222222222222222222222222222222";
const third = "3333333333333333333333333333333333333333";

interface Toy {
  version: string | null;
  broken: Set<string>;
  healthyAfter: Map<string, number>;
  checks: number;
  deployExit: number;
  rollbackExit: number;
  hang: Set<string>;
  jobs: Job[];
  readonly hanging: Map<string, (end: ExecutionEnd) => void>;
  readonly scripted: Map<string, (job: Job) => { readonly exitCode: number; readonly lines: readonly string[] }>;
}

interface Told {
  readonly conversation: string | null;
  readonly notice: string;
  readonly prompt: string;
}

let dataDir: string;
let clock: TestClock;
let timer: ManualTimer;
let key: SigningKey;
let forge: FakeForge;
let toy: Toy;
let told: Told[];
let database: HubDatabase;
let commands: CommandService;
let lock: ConfirmationLock;
let tickets: TicketService;
let chains: Chains;
let deployments: DeploymentService;
let begun: number[];
let open: boolean;

function toyTarget(): Target {
  return {
    name: "box",
    run: (job, sink) => {
      toy.jobs.push(job);
      const said = (line: string) => sink("stdout", Buffer.from(`${line}\n`));
      if (toy.hang.has(job.command)) {
        said(`${job.command} started`);
        const ended = new Promise<ExecutionEnd>((resolve) => toy.hanging.set(job.command, resolve));
        return { ended, stop: async () => toy.hanging.get(job.command)?.({ exitCode: null, signal: "SIGKILL" }) };
      }
      const scripted = toy.scripted.get(job.command);
      if (scripted !== undefined) {
        const answer = scripted(job);
        answer.lines.forEach(said);
        return { ended: Promise.resolve({ exitCode: answer.exitCode, signal: null }), stop: () => Promise.resolve() };
      }
      let exitCode = 0;
      if (job.command === "deploy" || job.command.startsWith("git push")) {
        exitCode = toy.deployExit;
        if (exitCode === 0) {
          toy.version = job.credentials["SUPERAGENT2_COMMIT"] ?? null;
        }
        said(`deployed ${toy.version ?? "nothing"}`);
      } else if (job.command === "check") {
        toy.checks += 1;
        const version = toy.version;
        const healthy = version !== null && !toy.broken.has(version) && toy.checks > (toy.healthyAfter.get(version) ?? 0);
        exitCode = healthy ? 0 : 1;
        said(healthy ? `ok ${version}` : `no answer from ${version ?? "nothing"}`);
      } else if (job.command === "rollback") {
        exitCode = toy.rollbackExit;
        if (exitCode === 0) {
          toy.version = job.credentials["SUPERAGENT2_PREVIOUS_COMMIT"] ?? null;
        }
        said(`rolled back to ${toy.version ?? "nothing"}`);
      }
      return { ended: Promise.resolve({ exitCode, signal: null }), stop: () => Promise.resolve() };
    },
  };
}

const defaults: ChainDefaults = {
  resolve: (ticket: Ticket, owner = ticket.ownerChoice) =>
    resolveStart(
      { kind: ticket.kind, difficulty: ticket.difficulty ?? "standard", platform: ticket.platform ?? "any", brainEngine: ticket.brainEngine ?? "codex", stated: true, owner },
      startingEngineTable,
      [{ name: "pc", platform: "win32", free: 2, engines: [{ engine: "codex", models: [{ id: "gpt-6.1-terra", efforts: ["high"] }] }] }],
      { codex: "available", claude: "available" },
    ),
  machines: () => [],
  machinesFor: () => [],
};

function start(): void {
  database = openDatabase({ dataDir, clock });
  const keys = createKeyCache({ source: staticKeySource(keySet(key)), clock });
  const verify = createAccessVerifier({ team, audience, keys, clock });
  lock = createConfirmationLock({ database, clock, verify, ownerEmail, settings: lockSettings({ projectFolders: [], credentialPaths: [] }) });
  commands = createCommandService({ database, clock, targets: [toyTarget()], credentials: testCredentials, gate: lock.gate });
  tickets = createTicketService({ database, clock });
  chains = createChains({
    database,
    clock,
    tickets,
    verify: async (given) => (given === "owner" ? { ok: true, identity: { kind: "person", email: ownerEmail, subject: "owner" } } : { ok: false, reason: "no" }),
    ownerEmail,
    defaults,
    work: { begin: (ticket) => void begun.push(ticket.id), stop: () => undefined },
  });
  deployments = createDeployments({
    database,
    clock,
    commands,
    credentials: testCredentials,
    targets: () => ["box"],
    fetch: forge.fetch,
    gitHubBase: fakeGitHubBase,
    sleep: timer.sleep,
    tell: (conversation, notice, prompt) => void told.push({ conversation, notice, prompt }),
    deployed: (ticket) => chains.arranger.deployed(ticket),
    ownRepository: "novan-xu/super-agent2",
  });
  open = true;
}

async function stop(): Promise<void> {
  if (!open) {
    return;
  }
  open = false;
  deployments.close();
  await deployments.idle();
  chains.close();
  await chains.idle();
  await commands.close();
  database.close();
}

async function restart(): Promise<void> {
  await stop();
  start();
  deployments.resume();
}

function fileText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ target: "box", deploy: "deploy", health: { command: "check", everySeconds: 5, withinSeconds: 30 }, rollback: "rollback", ...overrides });
}

function commit(sha: string, text: string = fileText()): void {
  forge.file(repository, sha, deploymentFile, text);
  forge.repository(repository).mainline.push(sha);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-deployments-"));
  clock = new TestClock();
  timer = new ManualTimer(clock);
  key = await signingKey("key-1");
  forge = fakeForge();
  toy = { version: null, broken: new Set(), healthyAfter: new Map(), checks: 0, deployExit: 0, rollbackExit: 0, hang: new Set(), jobs: [], hanging: new Map(), scripted: new Map() };
  told = [];
  begun = [];
  commit(first);
  commit(second);
  start();
});

afterEach(async () => {
  for (const resolve of toy.hanging.values()) {
    resolve({ exitCode: null, signal: "SIGKILL" });
  }
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function deployment(id: number): Deployment {
  const found = deployments.get(id);
  if (found === undefined) {
    throw new Error(`deployment ${id} missing`);
  }
  return found;
}

async function begin(sha: string, previous?: string): Promise<Deployment> {
  const started = await deployments.start({ repository, commit: sha, conversation: "c-1", ...(previous === undefined ? {} : { previous }) });
  if (!started.ok) {
    throw new Error(started.reason);
  }
  return started.deployment;
}

async function finished(id: number): Promise<Deployment> {
  for (;;) {
    await settledTurn();
    const current = deployment(id);
    if (current.phase === "done") {
      await deployments.idle();
      return deployment(id);
    }
    if (timer.sleeping > 0) {
      await timer.next();
    }
  }
}

async function deployedOnce(sha: string): Promise<Deployment> {
  return finished((await begin(sha)).id);
}

function commandsOf(found: Deployment): CommandRecord[] {
  return found.steps.map((step) => {
    const record = commands.get(step.command);
    if (record === undefined) {
      throw new Error(`command ${step.command} missing`);
    }
    return record;
  });
}

function mergedTicket(number: number, mergeCommit: string, conversation = "c-1"): Ticket {
  const title = { en: `Issue ${number}`, zh: `问题 ${number}` };
  const opened = tickets.open({
    repository,
    issues: [{ repository, number, url: `https://github.com/${repository}/issues/${number}`, title, summary: title }],
    title,
    summary: title,
    kind: "feature",
    conversation,
  });
  tickets.change((writes) => {
    writes.move(opened.id, "working");
    writes.move(opened.id, "verifying");
    writes.move(opened.id, "merged");
  });
  database.connection.prepare("INSERT INTO ticket_verifications (ticket_id, state, merge_commit) VALUES (?, 'merged', ?)").run(opened.id, mergeCommit);
  return opened;
}

describe("the deployment file", () => {
  it("is small, takes defaults for the health check's period, and refuses what it does not know", () => {
    const read = readDeploymentFile(JSON.stringify({ target: "box", deploy: "./deploy.sh", health: { command: "curl -fsS http://localhost:8080/health" }, rollback: "./rollback.sh" }));
    expect(read).toEqual({
      ok: true,
      file: { target: "box", deploy: "./deploy.sh", health: { command: "curl -fsS http://localhost:8080/health", everySeconds: 5, withinSeconds: 120 }, rollback: "./rollback.sh" },
    });
    expect(readDeploymentFile("{ not json")).toMatchObject({ ok: false, reason: expect.stringContaining("it is not JSON") });
    const unknown = readDeploymentFile(JSON.stringify({ target: "box", deploy: "a", health: { command: "b" }, rollback: "c", token: "secret" }));
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining("token") });
    expect(readDeploymentFile(JSON.stringify({ target: "box", deploy: "a", rollback: "c" }))).toMatchObject({ ok: false, reason: expect.stringContaining("health") });
  });
});

describe("a deployment", () => {
  it("runs the deploy command on the file's target with the repository and commits in its environment, and succeeds when the service answers", async () => {
    const done = await deployedOnce(first);
    expect(done).toMatchObject({ repository, commit: first, previous: null, target: "box", phase: "done", result: "succeeded" });
    expect(toy.version).toBe(first);
    const [deploy, check] = toy.jobs;
    expect(deploy?.command).toBe("deploy");
    expect(deploy?.credentials).toMatchObject({ SUPERAGENT2_REPOSITORY: repository, SUPERAGENT2_COMMIT: first, SUPERAGENT2_DEPLOYMENT: String(done.id), GH_TOKEN: "test-token-for-novan-xu" });
    expect(deploy?.credentials).not.toHaveProperty("SUPERAGENT2_PREVIOUS_COMMIT");
    expect(check?.command).toBe("check");
    expect(done.steps.map((step) => step.kind)).toEqual(["deploy", "health"]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ conversation: "c-1", notice: `${repository} 已部署到 1111111，健康检查通过` });
    expect(told[0]?.prompt).toContain(`[hub] Deployment ${done.id} of ${repository} at commit ${first} on target box succeeded`);
    expect(told[0]?.prompt).toContain("deployed 1111111111111111111111111111111111111111");

    const next = await deployedOnce(second);
    expect(next).toMatchObject({ previous: first, result: "succeeded" });
    expect(toy.jobs.at(-2)?.credentials).toMatchObject({ SUPERAGENT2_COMMIT: second, SUPERAGENT2_PREVIOUS_COMMIT: first });
  });

  it("succeeds when the service becomes healthy late within the period, checking at the file's interval", async () => {
    toy.healthyAfter.set(first, 4);
    const startedAt = clock.now();
    const done = await deployedOnce(first);
    expect(done.result).toBe("succeeded");
    expect(done.steps.filter((step) => step.kind === "health")).toHaveLength(5);
    expect(clock.now() - startedAt).toBe(20_000);
  });

  it("rolls back to the previously deployed commit when the service never answers, and checks that the previous version answers again", async () => {
    await deployedOnce(first);
    told.length = 0;
    toy.broken.add(second);
    const startedAt = clock.now();
    const done = await deployedOnce(second);
    expect(done).toMatchObject({ result: "rolled-back", previous: first, phase: "done" });
    expect(clock.now() - startedAt).toBe(30_000);
    expect(toy.version).toBe(first);
    const kinds = done.steps.map((step) => step.kind);
    expect(kinds.filter((kind) => kind === "health")).toHaveLength(7);
    expect(kinds.slice(-2)).toEqual(["rollback", "recheck"]);
    const rollback = toy.jobs.find((job) => job.command === "rollback");
    expect(rollback?.credentials).toMatchObject({ SUPERAGENT2_COMMIT: second, SUPERAGENT2_PREVIOUS_COMMIT: first });
    expect(done.notes).toContain("The service did not pass its health check within 30 seconds.");
    expect(told).toHaveLength(1);
    expect(told[0]?.notice).toBe(`${repository} 部署 2222222 没有成功，已回滚到 1111111，旧版本恢复正常`);
    expect(told[0]?.prompt).toContain("failed and was rolled back to 1111111111111111111111111111111111111111");
    expect(told[0]?.prompt).toContain("Rollback command:");
    expect(deployments.latest(repository)?.id).toBe(done.id);
    const after = await deployedOnce(first);
    expect(after.previous).toBe(first);
  });

  it("rolls back when the deploy command fails", async () => {
    await deployedOnce(first);
    toy.deployExit = 3;
    const done = await deployedOnce(second);
    expect(done.result).toBe("rolled-back");
    expect(done.notes[0]).toBe("The deploy command exited with code 3.");
    expect(done.steps.map((step) => step.kind)).toEqual(["deploy", "rollback", "recheck"]);
  });

  it("reports a failing rollback as unrecovered", async () => {
    await deployedOnce(first);
    told.length = 0;
    toy.broken.add(second);
    toy.rollbackExit = 1;
    const done = await deployedOnce(second);
    expect(done).toMatchObject({ result: "unrecovered", reason: "The rollback command exited with code 1." });
    expect(done.steps.map((step) => step.kind).at(-1)).toBe("rollback");
    expect(told[0]?.notice).toBe(`${repository} 部署 2222222 没有成功，回滚后服务仍不正常，大脑会决定怎么处理`);
    expect(told[0]?.prompt).toContain("check the service yourself");
  });

  it("reports a rollback after which the service still does not answer as unrecovered", async () => {
    await deployedOnce(first);
    toy.broken.add(second);
    toy.broken.add(first);
    const done = await deployedOnce(second);
    expect(done).toMatchObject({ result: "unrecovered", reason: "The rollback command finished, but the service still did not pass its health check within 30 seconds." });
  });

  it("does not roll back a first deployment, which has no previous version, unless the brain names the commit running now", async () => {
    toy.broken.add(first);
    const done = await deployedOnce(first);
    expect(done.result).toBe("failed");
    expect(done.reason).toContain("there is no previous version to roll back to, and nothing was rolled back");
    expect(toy.jobs.some((job) => job.command === "rollback")).toBe(false);
    expect(told[0]?.notice).toBe(`${repository} 部署 1111111 没有成功，没有可以回滚的上一个版本，大脑会决定怎么处理`);

    toy.broken.clear();
    toy.version = third;
    toy.broken.add(second);
    const given = await finished((await begin(second, third)).id);
    expect(given).toMatchObject({ previous: third, result: "rolled-back" });
    expect(toy.version).toBe(third);
  });

  it("stops a health check that does not end by the end of the period, and counts it as not healthy", async () => {
    toy.hang.add("check");
    const startedAt = clock.now();
    const done = await deployedOnce(first);
    expect(done.result).toBe("failed");
    expect(clock.now() - startedAt).toBe(30_000);
    expect(done.steps.filter((step) => step.kind === "health")).toHaveLength(1);
    expect(commandsOf(done).find((record) => record.command === "check")?.state).toBe("stopped");
  });
});

describe("what a deployment marks deployed", () => {
  it("marks the merged tickets whose merge commit it contains, so the tickets waiting for their deployment begin", async () => {
    const merged = mergedTicket(1, first);
    const later = mergedTicket(2, third);
    const title = { en: "After", zh: "之后" };
    const waiting = tickets.open({ repository, issues: [{ repository, number: 3, url: `https://github.com/${repository}/issues/3`, title, summary: title }], title, summary: title, kind: "feature", conversation: "c-1" });
    tickets.change((writes) => {
      writes.setWaits(waiting.id, [{ ticket: merged.id, deployment: true }]);
      writes.move(waiting.id, "waiting");
    });
    forge.repository(repository).mainline.push(third);
    const done = await deployedOnce(second);
    expect(done.deployedTickets).toEqual([merged.id]);
    expect(tickets.get(merged.id)?.deployedAt).not.toBeNull();
    expect(tickets.get(later.id)?.deployedAt).toBeNull();
    expect(tickets.get(waiting.id)?.state).toBe("working");
    expect(told[0]?.prompt).toContain(`Marked deployed: ticket ${merged.id}`);
  });

  it("marks nothing when the deployment fails", async () => {
    await deployedOnce(first);
    const merged = mergedTicket(1, second);
    toy.broken.add(second);
    const done = await deployedOnce(second);
    expect(done.result).toBe("rolled-back");
    expect(tickets.get(merged.id)?.deployedAt).toBeNull();
  });
});

describe("what a deployment refuses", () => {
  it("refuses a commit with no deployment file, a file that does not parse, an unknown target and an unknown commit, running nothing", async () => {
    forge.tree(repository, third, ["src/index.ts"]);
    expect(await deployments.start({ repository, commit: third })).toEqual({
      ok: false,
      reason: `${repository} has no ${deploymentFile} at 3333333, so it declares no deployment; nothing was deployed. A repository that should be deployed needs that file first, added as ordinary work through a ticket.`,
    });
    forge.file(repository, third, deploymentFile, "{ \"target\": \"box\" ");
    expect(await deployments.start({ repository, commit: third })).toMatchObject({ ok: false, reason: expect.stringContaining("is not a valid deployment file: it is not JSON") });
    forge.file(repository, third, deploymentFile, JSON.stringify({ target: "box", deploy: "deploy", rollback: "rollback" }));
    expect(await deployments.start({ repository, commit: third })).toMatchObject({ ok: false, reason: expect.stringContaining("is not a valid deployment file: health:") });
    forge.file(repository, third, deploymentFile, fileText({ target: "elsewhere" }));
    expect(await deployments.start({ repository, commit: third })).toMatchObject({ ok: false, reason: expect.stringContaining("names the target elsewhere, which the hub does not know (targets now: box)") });
    expect(await deployments.start({ repository, commit: "4444444" })).toEqual({ ok: false, reason: `There is no commit 4444444 in ${repository}; nothing was deployed.` });
    expect(toy.jobs).toEqual([]);
    expect(commands.list()).toEqual([]);
    expect(deployments.list()).toEqual([]);
  });

  it("refuses a file that names the NAS host as its target, saying the hub cannot reach it", async () => {
    forge.file(repository, third, deploymentFile, fileText({ target: "nas" }));
    expect(await deployments.start({ repository, commit: third })).toEqual({
      ok: false,
      reason: `${deploymentFile} at 3333333 names the target nas, the NAS host, which the hub cannot reach: no target runs there. Deploying on the NAS host is out of scope until the owner sets up a way for it deliberately. Nothing was deployed.`,
    });
    expect(toy.jobs).toEqual([]);
    expect(deployments.list()).toEqual([]);
  });

  it("refuses to deploy Super-agent2 itself, whatever its files say, without reading GitHub", async () => {
    const own = "Novan-Xu/Super-Agent2";
    forge.file(own, first, deploymentFile, fileText());
    forge.repository(own).mainline.push(first);
    const calls = forge.calls.length;
    const refused = await deployments.start({ repository: own, commit: first, conversation: "c-1" });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining(`${own} is Super-agent2 itself, which the hub does not deploy`) });
    expect(refused.ok ? "" : refused.reason).toContain("report it with report_deployment");
    expect(forge.calls.length).toBe(calls);
    expect(toy.jobs).toEqual([]);
    expect(deployments.list()).toEqual([]);
  });

  it("refuses a second deployment of the same repository while one runs, saying what runs", async () => {
    toy.hang.add("deploy");
    const running = await begin(first);
    await waitForState(commands, running.steps[0]?.command ?? "", "running");
    const second_ = await deployments.start({ repository, commit: second });
    expect(second_).toEqual({
      ok: false,
      reason: `Deployment ${running.id} of ${repository} at 1111111 is still running (running the deploy command); one deployment per repository at a time. Read it with read_deployment; nothing new was started.`,
    });
    const both = await Promise.all([deployments.start({ repository, commit: second }), deployments.start({ repository: "novan-xu/TOY-SERVICE", commit: second })]);
    expect(both.every((outcome) => !outcome.ok)).toBe(true);
    toy.version = first;
    toy.hanging.get("deploy")?.({ exitCode: 0, signal: null });
    const done = await finished(running.id);
    expect(done.result).toBe("succeeded");
    expect(toy.jobs.filter((job) => job.command === "deploy")).toHaveLength(1);
  });
});

describe("a held command inside a deployment", () => {
  async function owner(): Promise<string> {
    return assertion({ key, clock });
  }

  it("waits for the owner's confirmation like any held command, and goes on once it is confirmed", async () => {
    commit(third, fileText({ deploy: "git push --force origin main" }));
    const started = await begin(third);
    const id = started.steps[0]?.command ?? "";
    const held = await waitForState(commands, id, "held");
    expect(toy.jobs).toEqual([]);
    expect(deployment(started.id).phase).toBe("deploy");
    expect(deployments.report(deployment(started.id))).toContain("It is held until the owner confirms it on the web page; the deployment waits for it.");
    const outcome = await lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf(held) });
    expect(outcome.ok).toBe(true);
    const done = await finished(started.id);
    expect(done.result).toBe("succeeded");
    expect(toy.version).toBe(third);
  });

  it("ends without changing anything when the owner refuses it", async () => {
    commit(third, fileText({ deploy: "git push --force origin main" }));
    const started = await begin(third);
    const id = started.steps[0]?.command ?? "";
    const held = await waitForState(commands, id, "held");
    await lock.refuse(id, { assertion: await owner(), fingerprint: fingerprintOf(held) });
    const done = await finished(started.id);
    expect(done.result).toBe("not-run");
    expect(done.reason).toContain("The deploy command did not run: it ended as dropped");
    expect(told[0]?.notice).toBe(`${repository} 部署 3333333 的命令没有运行，什么都没有改变`);
    expect(toy.jobs).toEqual([]);
  });

  it("still waits after a restart of the hub, and goes on once confirmed", async () => {
    commit(third, fileText({ deploy: "git push --force origin main" }));
    const started = await begin(third);
    const id = started.steps[0]?.command ?? "";
    await waitForState(commands, id, "held");
    await restart();
    const held = await waitForState(commands, id, "held");
    expect(deployment(started.id).phase).toBe("deploy");
    await lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf(held) });
    const done = await finished(started.id);
    expect(done.result).toBe("succeeded");
    expect(toy.jobs.filter((job) => job.command.startsWith("git push"))).toHaveLength(1);
  });
});

describe("a restart of the hub in the middle of a deployment", () => {
  it("records a deploy command it interrupted as not known, runs it no second time and rolls nothing back", async () => {
    await deployedOnce(first);
    told.length = 0;
    toy.hang.add("deploy");
    const started = await begin(second);
    await waitForState(commands, started.steps[0]?.command ?? "", "running");
    await restart();
    await deployments.idle();
    const done = deployment(started.id);
    expect(done).toMatchObject({ phase: "done", result: "interrupted" });
    expect(done.reason).toContain("The health check reported no outcome, so whether it finished is not known, and nothing was rolled back.");
    expect(toy.jobs.filter((job) => job.command === "deploy")).toHaveLength(2);
    expect(done.steps.map((step) => step.kind)).toEqual(["deploy", "health"]);
    expect(toy.jobs.filter((job) => job.command === "rollback")).toHaveLength(0);
    expect(told).toHaveLength(1);
    expect(told[0]?.notice).toBe(`${repository} 部署 2222222 中途被打断，结果不确定，大脑会去确认`);
    await restart();
    await deployments.idle();
    expect(told).toHaveLength(1);
  });

  it("checks health again with a full period after a restart during the health check, and finishes truthfully", async () => {
    await deployedOnce(first);
    toy.broken.add(second);
    const started = await begin(second);
    await timer.next();
    expect(deployment(started.id).phase).toBe("health");
    await restart();
    toy.broken.delete(second);
    const done = await finished(started.id);
    expect(done.result).toBe("succeeded");
    expect(done.notes).toContain("The hub restarted during the health check; the check started again with a full period.");
    expect(toy.jobs.filter((job) => job.command === "deploy")).toHaveLength(2);
  });

  it("reads the outcome a deploy command that it interrupted left behind, through one health check, and runs nothing again", async () => {
    toy.hang.add("deploy");
    const started = await begin(first);
    await waitForState(commands, started.steps[0]?.command ?? "", "running");
    toy.scripted.set("check", () => ({ exitCode: 0, lines: [outcomeLine({ result: "succeeded", reason: "The new version answers." })] }));
    await restart();
    await deployments.idle();
    const done = deployment(started.id);
    expect(done).toMatchObject({ phase: "done", result: "succeeded", reason: "The new version answers." });
    expect(done.steps.map((step) => step.kind)).toEqual(["deploy", "health"]);
    expect(toy.jobs.filter((job) => job.command === "deploy")).toHaveLength(1);
  });

  it("tells a result the hub recorded but had not told yet once it starts again", async () => {
    const started = await begin(first);
    await deployments.idle();
    expect(told).toHaveLength(1);
    database.connection.prepare("UPDATE deployments SET told_at = NULL WHERE id = ?").run(started.id);
    told.length = 0;
    await restart();
    expect(told).toHaveLength(1);
    expect(told[0]?.notice).toBe(`${repository} 已部署到 1111111，健康检查通过`);
  });
});

function outcomeLine(outcome: Record<string, string>): string {
  return `${deploymentOutcomeMarker} ${JSON.stringify(outcome)}`;
}

describe("a deployment that reports how it ended, across a restart of the hub", () => {
  type Release = "running" | "succeeded" | "rolled-back" | "unchanged" | "none";
  let release: Release;

  function selfDeploying(): void {
    release = "none";
    toy.scripted.set("begin", (job) => {
      if (release === "running") {
        return { exitCode: 1, lines: [outcomeLine({ result: "not-run", reason: "Another release is running; nothing was started." })] };
      }
      release = "running";
      return { exitCode: 0, lines: [`release of ${job.credentials["SUPERAGENT2_COMMIT"] ?? "?"} started`] };
    });
    toy.scripted.set("outcome", () => {
      switch (release) {
        case "running":
          return { exitCode: 3, lines: ["the release is still running"] };
        case "succeeded":
          return { exitCode: 0, lines: [outcomeLine({ result: "succeeded", reason: "The new hub answers its health check and the brain is linked." })] };
        case "rolled-back":
          return {
            exitCode: 4,
            lines: [outcomeLine({ result: "rolled-back", reason: "The new hub did not answer; the previous version and its database were restored.", previous: third })],
          };
        case "unchanged":
          return { exitCode: 4, lines: [outcomeLine({ result: "unchanged", reason: "The build failed; the running version was not replaced." })] };
        case "none":
          return { exitCode: 5, lines: ["no release is recorded"] };
      }
    });
    toy.scripted.set("settle", () => ({ exitCode: 0, lines: [] }));
    for (const sha of [first, second]) {
      forge.file(repository, sha, deploymentFile, fileText({ deploy: "begin", health: { command: "outcome", everySeconds: 10, withinSeconds: 3600 }, rollback: "settle" }));
    }
  }

  async function healthChecks(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await settledTurn();
      await timer.next();
    }
  }

  it("finishes the record as succeeded after the restart, from what the deployment recorded, with the deploy command run once", async () => {
    selfDeploying();
    const started = await begin(first);
    await healthChecks(3);
    expect(deployment(started.id).phase).toBe("health");
    await restart();
    await healthChecks(2);
    release = "succeeded";
    const done = await finished(started.id);
    expect(done).toMatchObject({ result: "succeeded", reason: "The new hub answers its health check and the brain is linked." });
    expect(done.notes).toEqual(["The hub restarted during the health check; the check started again with a full period.", "The health check reported how the deployment ended: succeeded."]);
    expect(toy.jobs.filter((job) => job.command === "begin")).toHaveLength(1);
    expect(toy.jobs.some((job) => job.command === "settle")).toBe(false);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ conversation: "c-1", notice: `${repository} 已部署到 1111111，健康检查通过` });
  });

  it("ends at once as rolled back when the deployment went back by itself, naming the version it went back to and why", async () => {
    selfDeploying();
    const started = await begin(first);
    await healthChecks(2);
    await restart();
    release = "rolled-back";
    const before = clock.now();
    const done = await finished(started.id);
    expect(done).toMatchObject({ result: "rolled-back", previous: third, reason: "The new hub did not answer; the previous version and its database were restored." });
    expect(clock.now() - before).toBeLessThan(3600 * 1000);
    expect(toy.jobs.some((job) => job.command === "settle")).toBe(false);
    expect(told[0]?.notice).toBe(`${repository} 部署 1111111 没有成功，已回滚到 3333333，旧版本恢复正常`);
    expect(told[0]?.prompt).toContain("failed and was rolled back to 3333333333333333333333333333333333333333");
  });

  it("keeps the previous commit it recorded itself when the deployment names another", async () => {
    selfDeploying();
    const earlier = await begin(first);
    release = "succeeded";
    expect((await finished(earlier.id)).result).toBe("succeeded");
    release = "none";
    const started = await begin(second);
    release = "rolled-back";
    const done = await finished(started.id);
    expect(done).toMatchObject({ result: "rolled-back", previous: first });
  });

  it("says the running version was kept when the deployment failed before replacing anything", async () => {
    selfDeploying();
    const started = await begin(first);
    release = "unchanged";
    const done = await finished(started.id);
    expect(done).toMatchObject({ result: "unchanged", reason: "The build failed; the running version was not replaced." });
    expect(told[0]?.notice).toBe(`${repository} 部署 1111111 没有成功，正在运行的版本没有被替换，大脑会决定怎么处理`);
  });

  it("takes the outcome a deploy command reports over its exit code, and rolls nothing back", async () => {
    selfDeploying();
    release = "running";
    const done = await deployedOnce(first);
    expect(done).toMatchObject({ result: "not-run", reason: "Another release is running; nothing was started." });
    expect(done.steps.map((step) => step.kind)).toEqual(["deploy"]);
    expect(told[0]?.notice).toBe(`${repository} 部署 1111111 的命令没有运行，什么都没有改变`);
  });
});
