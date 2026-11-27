import { ticketReference } from "@super-agent2/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deploymentFile,
  type HubToRunner,
  type MachineReport,
  protocolVersion,
  type StartCard,
  type Ticket,
  WaitingList,
  type WorkEvent,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import type { Hub } from "./hub.js";
import type { RunnerLink } from "./runners.js";
import { chainChoicePath, chainStartPath } from "./server.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { type FakeForge, fakeForge, fakeGitHubBase, fakeWoodpeckerServer } from "./testing/forge.js";
import { startTestHub } from "./testing/http.js";

const repository = "novan-xu/super-agent-sandbox";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let forge: FakeForge;
let hub: Hub | undefined;

const credentials: CredentialSource = (account) => ({
  ok: true,
  credentials: { GH_TOKEN: `token-of-${account}`, GITHUB_TOKEN: `token-of-${account}`, WOODPECKER_SERVER: fakeWoodpeckerServer, WOODPECKER_TOKEN: "woodpecker-token" },
});

function machine(hostname: string, platform: MachineReport["platform"] = "win32"): MachineReport {
  return {
    hostname,
    platform,
    release: "1",
    arch: "x64",
    user: "owner",
    slots: { total: 2, free: 2 },
    programs: [{ id: "codex", installed: true, path: "codex", version: "1", models: [{ id: "gpt-6.1-terra", efforts: ["high"] }], source: "program", problem: null }],
    allowances: [],
  };
}

const recipe = {
  target: "pc",
  deploy: "node scripts/deploy.mjs",
  health: { command: "node scripts/health.mjs", everySeconds: 5, withinSeconds: 120 },
  rollback: "node scripts/rollback.mjs",
};

const deploymentRequest = {
  title: { en: "Deploy", zh: "部署" },
  summary: { en: "Deploy", zh: "部署" },
  task: "Deploy using the recipe.",
  kind: "operation",
  repository,
  deploy: true,
};

const seqs = new Map<string, number>();

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-task-tickets-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  forge = fakeForge();
  seqs.clear();
  forge.repository(repository).mainline.push("head1");
  forge.tree(repository, "head1", ["src/app.ts"]);
  forge.file(repository, "head1", deploymentFile, JSON.stringify(recipe));
  forge.woodpecker.set(repository, { id: 6, active: true, configFile: "", pipelines: [] });
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

interface Started {
  readonly running: Hub;
  readonly runners: Map<string, { readonly link: RunnerLink; readonly sent: HubToRunner[] }>;
  readonly conversation: string;
}

function connect(running: Hub, report: MachineReport): { readonly link: RunnerLink; readonly sent: HubToRunner[] } {
  const name = report.hostname;
  if (running.machines.get(name) === undefined) running.machines.add({ name, accessClientId: `${name}.access` });
  const found = running.machines.get(name);
  if (found === undefined) throw new Error(`Missing machine ${name}`);
  const sent: HubToRunner[] = [];
  const link = running.runners.attach(found, { send: (message) => void sent.push(message), close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
  return { link, sent };
}

async function start(reports = [machine("pc"), machine("mac")]): Promise<Started> {
  const running = await startTestHub({
    config: testConfig(dataDir),
    keySource: staticKeySource(keySet(key)),
    clock,
    credentials,
    forgeFetch: forge.fetch,
    gitHubBase: fakeGitHubBase,
  });
  hub = running;
  const runners = new Map<string, { readonly link: RunnerLink; readonly sent: HubToRunner[] }>();
  for (const report of reports) {
    runners.set(report.hostname, connect(running, report));
  }
  return { running, runners, conversation: running.conversations.create().id };
}

function current(running: Hub, id: number): Ticket {
  const ticket = running.tickets.get(id);
  if (ticket === undefined) {
    throw new Error(`ticket ${id} missing`);
  }
  return ticket;
}

function event(link: RunnerLink, ticket: number, attempt: number, body: WorkEvent): void {
  const key = `${ticket}:${attempt}`;
  const seq = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, seq);
  link.receive({ type: "work.event", ticket, attempt, seq, at: clock.now(), event: body });
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function ownerPost(running: Hub, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), origin: base(running), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function cards(running: Hub): Promise<StartCard[]> {
  const response = await fetch(`${base(running)}/api/waiting`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
  return WaitingList.parse(await response.json()).cards.flatMap((card) => (card.kind === "start" ? [card] : []));
}

function chain(running: Hub, conversation: string, issue: number): Ticket {
  forge.repository(repository).issues.set(issue, "open");
  const summary = { en: `Do step ${issue}`, zh: `做第 ${issue} 步` };
  return running.tickets.open({
    repository,
    issues: [{ repository, number: issue, url: `https://github.com/${repository}/issues/${issue}`, title: { en: `Step ${issue}`, zh: `第 ${issue} 步` }, summary }],
    title: { en: `Step ${issue}`, zh: `第 ${issue} 步` },
    summary,
    kind: "feature",
    conversation,
  });
}

async function stated(running: Hub, tickets: readonly Ticket[]): Promise<void> {
  const answer = await callBrainTool(running, "choose_defaults", {
    chains: tickets.map((ticket) =>
      ticket.form === "task"
        ? { ticket: ticket.code, kind: "operation", difficulty: "standard", reason: { en: "A known procedure", zh: "已知的步骤" }, platform: "any", engine: "codex" }
        : { ticket: ticket.code, kind: "feature", issues: ticket.issues.map((issue) => ({ number: issue.number, difficulty: "standard" })), reason: { en: "Bounded work", zh: "有边界的工作" }, platform: "any", engine: "codex" },
    ),
  });
  expect(answer.isError, answer.text).toBe(false);
}

async function merge(running: Hub, runners: Started["runners"], ticket: Ticket, pull: number, head: string): Promise<void> {
  const branch = current(running, ticket.id).branch ?? "";
  const link = runners.get(current(running, ticket.id).machine ?? "")?.link;
  if (link === undefined) {
    throw new Error("the chain runs on no machine of the test");
  }
  forge.pull(repository, pull, head, ["src/app.ts"], branch, ticket.issues.map((issue) => issue.number));
  forge.tree(repository, head, ["src/app.ts", ".woodpecker/check.yaml", deploymentFile]);
  forge.woodpecker.get(repository)?.pipelines.push({
    number: pull,
    commit: head,
    ref: `refs/pull/${pull}/merge`,
    event: "pull_request",
    status: "success",
    workflows: [{ name: "check", state: "success", steps: [{ id: 900 + pull, name: "test", state: "success", exitCode: 0 }] }],
    config: ["check"],
  });
  event(link, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
  event(link, ticket.id, 1, { kind: "finished", pullRequest: pull, url: `https://github.com/${repository}/pull/${pull}`, closes: ticket.issues.map((issue) => issue.number), report: { en: "Done", zh: "做完了" } });
  await running.verification.idle();
  await running.chains.idle();
}

const DeliveryRow = z.object({ body: z.string() });

function deliveries(running: Hub, conversation: string): unknown[] {
  return running.database.connection
    .prepare("SELECT body FROM conversation_entries WHERE conversation_id = ? AND kind = 'delivery' ORDER BY seq")
    .all(conversation)
    .map((row) => JSON.parse(DeliveryRow.parse(row).body) as unknown);
}

function tasksSent(sent: readonly HubToRunner[], ticket: number): Extract<HubToRunner, { readonly type: "work.task" }>[] {
  return sent.flatMap((message) => (message.type === "work.task" && message.task.ticket === ticket ? [message] : []));
}

describe("a deployment arranged with the work it deploys", () => {
  it("starts with the chain's one 开始, begins at the chain's final merge commit once merged, and marks it deployed when done", async () => {
    const { running, runners, conversation } = await start();
    const pc = runners.get("pc");
    if (pc === undefined) {
      throw new Error("no pc");
    }
    const first = chain(running, conversation, 7);
    const opened = await callBrainTool(
      running,
      "open_task_ticket",
      {
        title: { en: "Deploy the sandbox", zh: "部署沙盒" },
        summary: { en: "Deploy the merged step", zh: "部署合并后的改动" },
        task: "Deploy the repository by its deployment file, check health, roll back if it does not come up.",
        kind: "operation",
        repository,
        deploy: true,
        after: [first.code],
      },
      conversation,
    );
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain("names the machine pc");
    expect(opened.text).toContain("do not ask for a second start");
    const deployment = running.tickets.list({ open: true }).find((ticket) => ticket.form === "task");
    if (deployment === undefined) {
      throw new Error("no task ticket");
    }
    expect(deployment).toMatchObject({ kind: "operation", repository, requiredMachine: "pc", commitRef: "merged", commit: null, deploys: true, waitsFor: [first.id] });
    const later = chain(running, conversation, 8);
    const arranged = await callBrainTool(running, "arrange_chains", {
      chains: [
        { name: "first", repository, issues: [7] },
        { name: "later", repository, issues: [8], after: ["first"], after_deployment: true },
      ],
    });
    expect(arranged.isError, arranged.text).toBe(false);
    await stated(running, [current(running, first.id), current(running, deployment.id), current(running, later.id)]);

    const shown = await cards(running);
    const deploymentCard = shown.find((card) => card.ticket.id === deployment.id);
    expect(deploymentCard).toMatchObject({ startable: false, choice: { machine: "pc", engine: "codex", missing: [] } });
    expect(deploymentCard?.machines.map((entry) => entry.name)).toEqual(["pc"]);
    expect((await ownerPost(running, chainChoicePath, { ticket: deployment.id, machine: "mac" })).status).toBe(422);
    expect(current(running, deployment.id).ownerChoice.machine).toBeNull();

    const firstCard = (await cards(running)).find((card) => card.ticket.id === first.id);
    expect((await ownerPost(running, chainStartPath, { chains: [{ ticket: first.id, fingerprint: firstCard?.fingerprint }] })).status).toBe(202);
    expect(current(running, first.id).state).toBe("working");
    expect(current(running, deployment.id)).toMatchObject({ state: "waiting", machine: "pc" });
    expect(current(running, later.id).state).toBe("waiting");

    await merge(running, runners, current(running, first.id), 21, "aaa111");
    expect(current(running, first.id)).toMatchObject({ state: "merged", deployedAt: null });
    expect(current(running, deployment.id)).toMatchObject({ state: "working", commit: "merge-of-aaa111" });
    expect(current(running, later.id).state).toBe("waiting");
    const assignment = tasksSent(pc.sent, deployment.id)[0]?.task;
    expect(assignment).toMatchObject({
      attempt: 1,
      deploys: true,
      checkout: { repository, account: "novan-xu", commit: "merge-of-aaa111", ref: null },
      environment: { GH_TOKEN: "token-of-novan-xu", GITHUB_TOKEN: "token-of-novan-xu" },
      engine: "codex",
    });
    const merged = running.database.connection.prepare("SELECT prompt FROM conversation_entries WHERE conversation_id = ? AND kind = 'notice' ORDER BY seq").all(conversation);
    expect(JSON.stringify(merged)).toContain(`task ticket ${ticketReference(deployment)} deploys it`);

    event(pc.link, deployment.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(pc.link, deployment.id, 1, {
      kind: "delivered",
      outcome: "done",
      commit: "merge-of-aaa111",
      text: null,
      files: [],
      report: { en: "Deployed merge-of-aaa111; the health check passed.", zh: "部署好了，健康检查通过。" },
    });
    await running.taskTickets.idle();
    await running.chains.idle();
    expect(current(running, deployment.id)).toMatchObject({ state: "delivered", report: { zh: "部署好了，健康检查通过。" } });
    expect(current(running, deployment.id).deployedAt).not.toBeNull();
    expect(current(running, first.id).deployedAt).not.toBeNull();
    expect(current(running, later.id).state).toBe("working");
    expect(deliveries(running, conversation)).toEqual([
      { ticket: deployment.id, title: { en: "Deploy the sandbox", zh: "部署沙盒" }, text: null, report: { en: "Deployed merge-of-aaa111; the health check passed.", zh: "部署好了，健康检查通过。" }, files: [] },
    ]);
  });

  it("is a failed ticket when its worker hands back failed, guided by the brain like any failure", async () => {
    const { running, runners, conversation } = await start();
    const pc = runners.get("pc");
    if (pc === undefined) {
      throw new Error("no pc");
    }
    const opened = await callBrainTool(running, "open_task_ticket", { title: { en: "Deploy main", zh: "部署主分支" }, summary: { en: "Deploy it", zh: "部署" }, task: "Deploy main.", kind: "operation", repository, deploy: true, commit: "main" }, conversation);
    expect(opened.isError, opened.text).toBe(false);
    const ticket = running.tickets.list({ open: true })[0];
    if (ticket === undefined) {
      throw new Error("no ticket");
    }
    expect(ticket).toMatchObject({ commitRef: "main", requiredMachine: "pc" });
    await stated(running, [ticket]);
    const card = (await cards(running)).find((entry) => entry.ticket.id === ticket.id);
    expect((await ownerPost(running, chainStartPath, { chains: [{ ticket: ticket.id, fingerprint: card?.fingerprint }] })).status).toBe(202);
    await running.chains.idle();
    expect(tasksSent(pc.sent, ticket.id)[0]?.task.checkout).toEqual({ repository, account: "novan-xu", commit: null, ref: "main" });
    event(pc.link, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(pc.link, ticket.id, 1, { kind: "delivered", outcome: "failed", commit: "head1", text: null, files: [{ name: "deploy.log", size: 3, mediaType: "text/plain" }], report: { en: "The service did not come up; rolled back.", zh: "服务没起来，已回滚。" } });
    expect(current(running, ticket.id)).toMatchObject({ state: "working", commit: "head1", report: { zh: "服务没起来，已回滚。" }, work: { state: "failed", failure: "task-failed", reason: "The service did not come up; rolled back." } });
    expect(pc.sent.filter((message) => message.type === "work.file")).toEqual([]);
    expect(deliveries(running, conversation)).toEqual([]);
    const told = running.database.connection.prepare("SELECT prompt FROM conversation_entries WHERE conversation_id = ? AND kind = 'notice' ORDER BY seq").all(conversation);
    expect(JSON.stringify(told)).toContain("the worker handed back that its task failed");
    const guided = await callBrainTool(running, "guide_ticket", { ticket: ticket.code, guidance: { en: "Check the port before deploying.", zh: "部署前先检查端口。" } }, conversation);
    expect(guided.isError, guided.text).toBe(false);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 1, work: { attempt: 2 } });
    expect(tasksSent(pc.sent, ticket.id)[1]?.task).toMatchObject({ attempt: 2, checkout: { commit: "head1" } });
    expect(tasksSent(pc.sent, ticket.id)[1]?.task.note).toContain("Check the port before deploying.");
  });
});

describe("a deployment with several eligible machines", () => {
  const targets = ["mac-mini", "macbook-air", "pc"];
  const pc = { ...machine("pc"), slots: { total: 8, free: 8 } };
  const mini = machine("mac-mini", "darwin");
  const air = machine("macbook-air", "darwin");
  const outside = { ...machine("outside"), slots: { total: 16, free: 16 } };

  async function open({ running, conversation }: Started): Promise<Ticket> {
    forge.file(repository, "head1", deploymentFile, JSON.stringify({ ...recipe, target: targets }));
    const opened = await callBrainTool(running, "open_task_ticket", {
      title: { en: "Deploy main", zh: "部署主分支" }, summary: { en: "Deploy it", zh: "部署" },
      task: "Deploy using the recipe.", kind: "operation", platform: "macos", repository, deploy: true,
    }, conversation);
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain("allows this deployment on mac-mini, macbook-air, pc");
    const ticket = running.tickets.list({ open: true })[0]!;
    expect(ticket).toMatchObject({ requiredMachine: null, deploymentTargets: targets, platform: "any" });
    return ticket;
  }

  async function state(running: Hub, ticket: Ticket, machine?: string) {
    return callBrainTool(running, "choose_defaults", { chains: [{
      ticket: ticket.code, kind: "operation", difficulty: "standard", reason: { en: "A known procedure", zh: "已知的步骤" },
      platform: "macos", ...(machine === undefined ? {} : { machine }),
    }] });
  }

  async function approve(running: Hub, ticket: Ticket): Promise<void> {
    const card = (await cards(running)).find((entry) => entry.ticket.id === ticket.id);
    expect((await ownerPost(running, chainStartPath, { chains: [{ ticket: ticket.id, fingerprint: card?.fingerprint }] })).status).toBe(202);
    await running.chains.idle();
  }

  function loadPc(link: RunnerLink): void {
    for (let index = 0; index < 9; index++) {
      link.receive({ type: "report", machine: { ...pc, load: { cpuPercent: 85, ownCpuPercent: 36, gpuPercent: 97, sampledAt: clock.now() } } });
      clock.advance(15_000);
    }
  }

  it.each(targets)("lets the owner choose %s from the card and excludes unlisted machines", async (name) => {
    const started = await start([pc, mini, air, outside]);
    const { running, runners } = started;
    const ticket = await open(started);
    expect(await state(running, ticket, outside.hostname)).toMatchObject({ isError: true, text: expect.stringContaining("mac-mini, macbook-air, pc") });
    expect((await state(running, ticket)).isError).toBe(false);
    const card = (await cards(running)).find((entry) => entry.ticket.id === ticket.id);
    expect(card?.ticket.platform).toBe("any");
    expect(card?.machines.map((entry) => entry.name).sort()).toEqual([...targets].sort());
    expect((await ownerPost(running, chainChoicePath, { ticket: ticket.id, machine: outside.hostname })).status).toBe(422);
    expect((await ownerPost(running, chainChoicePath, { ticket: ticket.id, machine: name })).status).toBe(202);
    await approve(running, ticket);
    expect(tasksSent(runners.get(name)!.sent, ticket.id)).toHaveLength(1);
  });

  it("prefers a listed, normal-load machine that offers the requested engine and model", async () => {
    const started = await start([pc, mini, { ...air, programs: [] }, outside]);
    const { running, runners } = started;
    const ticket = await open(started);
    expect((await state(running, ticket)).isError).toBe(false);
    expect((await cards(running)).find((entry) => entry.ticket.id === ticket.id)?.choice.machine).toBe("pc");
    loadPc(runners.get("pc")!.link);
    expect((await cards(running)).find((entry) => entry.ticket.id === ticket.id)?.choice.machine).toBe("mac-mini");
    await approve(running, ticket);
    expect(tasksSent(runners.get("mac-mini")!.sent, ticket.id)).toHaveLength(1);
  });

  it("moves a queued automatic choice to a free listed machine and keeps an owner choice", async () => {
    const started = await start([pc, { ...air, programs: [] }, outside]);
    const { running, runners } = started;
    const pcRunner = runners.get("pc")!;
    loadPc(pcRunner.link);
    const automatic = await open(started);
    expect((await state(running, automatic)).isError).toBe(false);
    await approve(running, automatic);
    expect(current(running, automatic.id).work).toMatchObject({ machine: "pc", state: "queued", reason: expect.stringContaining("under high load") });
    const manual = await open(started);
    expect((await state(running, manual)).isError).toBe(false);
    expect((await ownerPost(running, chainChoicePath, { ticket: manual.id, machine: "pc" })).status).toBe(202);
    await approve(running, manual);
    const airRunner = runners.get("macbook-air")!;
    airRunner.link.receive({ type: "report", machine: air });
    expect(current(running, automatic.id)).toMatchObject({ machine: "macbook-air", work: { machine: "macbook-air", state: "preparing", attempt: 1, reason: null } });
    expect(tasksSent(airRunner.sent, automatic.id)).toHaveLength(1);
    expect(tasksSent(airRunner.sent, manual.id)).toHaveLength(0);
    expect(tasksSent(pcRunner.sent, automatic.id)).toHaveLength(0);
    expect(current(running, manual.id).work).toMatchObject({ machine: "pc", state: "queued" });
  });
});

describe("opening a task ticket", () => {
  it("holds new code and task attempts on a loaded machine without interrupting work", async () => {
    const { running, runners, conversation } = await start();
    const pc = runners.get("pc")!;
    const mac = runners.get("mac")!;
    const pcReport = { ...machine("pc"), slots: { total: 8, free: 8 } };
    const sample = (gpuPercent: number) => {
      pc.link.receive({ type: "report", machine: { ...pcReport, load: { cpuPercent: 85, ownCpuPercent: 36, gpuPercent, sampledAt: clock.now() } } });
      clock.advance(15_000);
    };
    const startTicket = async (ticket: Ticket) => {
      const card = (await cards(running)).find((entry) => entry.ticket.id === ticket.id);
      expect((await ownerPost(running, chainStartPath, { chains: [{ ticket: ticket.id, fingerprint: card?.fingerprint }] })).status).toBe(202);
    };
    sample(15);
    const active = chain(running, conversation, 10);
    await stated(running, [active]);
    await startTicket(active);
    event(pc.link, active.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    expect(current(running, active.id)).toMatchObject({ work: { machine: "pc", state: "running" } });
    const later = chain(running, conversation, 11);
    const pinned = chain(running, conversation, 12);
    const opened = await callBrainTool(running, "open_task_ticket", {
      title: { en: "Check the PC", zh: "检查 PC" }, summary: { en: "Check settings", zh: "核对设置" }, task: "Read the configuration.", kind: "operation",
    }, conversation);
    expect(opened.isError, opened.text).toBe(false);
    const task = running.tickets.list().find((ticket) => ticket.form === "task")!;
    await stated(running, [later, pinned, task]);
    expect((await ownerPost(running, chainChoicePath, { ticket: pinned.id, machine: "pc" })).status).toBe(202);
    expect((await ownerPost(running, chainChoicePath, { ticket: task.id, machine: "pc" })).status).toBe(202);
    for (let index = 0; index < 9; index++) sample(97);
    await startTicket(later);
    await startTicket(pinned);
    await startTicket(task);
    expect(mac.sent).toContainEqual(expect.objectContaining({ type: "work.start", task: expect.objectContaining({ ticket: later.id }) }));
    for (const ticket of [pinned, task]) {
      expect(current(running, ticket.id)).toMatchObject({ work: { state: "queued", machine: "pc", reason: expect.stringContaining("pc is under high load") } });
    }
    expect(pc.sent.filter((message) => message.type === "work.start" || message.type === "work.task" || message.type === "work.stop")).toMatchObject([{ type: "work.start", task: { ticket: active.id } }]);
    const allowance = await callBrainTool(running, "read_allowance", {});
    expect(allowance.text).toContain("Machine pc (win32), 8 free slot(s), CPU 85% (own 36%), GPU 97%, loaded since");
    expect(allowance.text).toContain("Machine mac (win32), 2 free slot(s), CPU unknown (own unknown), GPU unknown");
    const detail = await callBrainTool(running, "read_ticket", { ticket: pinned.code }, conversation);
    expect(detail.text).toContain("pc is under high load");
    for (let index = 0; index < 20; index++) sample(15);
    expect(current(running, pinned.id).work?.state).toBe("queued");
    sample(15);
    expect(current(running, pinned.id)).toMatchObject({ work: { state: "preparing", machine: "pc", reason: null, attempt: 1 } });
    expect(tasksSent(pc.sent, task.id)).toMatchObject([{ task: { ticket: task.id, attempt: 1 } }]);
    expect(current(running, active.id).work?.state).toBe("running");
  });

  it("places operations under their project and starts them in scratch", async () => {
    const { running, runners, conversation } = await start();
    const args = {
      title: { en: "Check service configuration", zh: "检查服务配置" },
      summary: { en: "Check the service settings", zh: "检查服务设置" },
      task: "Check the sandbox service configuration.",
      kind: "operation",
      project: repository,
    };
    expect(running.conversations.get(conversation)?.repository).toBeNull();
    const opened = await callBrainTool(running, "open_task_ticket", args, conversation);
    expect(opened.isError, opened.text).toBe(false);
    const first = running.tickets.list()[0]!;
    expect(first).toMatchObject({ project: repository, repository: null, conversation, commit: null });
    expect(running.conversations.get(conversation)?.repository).toBe(repository);

    const next = await callBrainTool(running, "open_task_ticket", { ...args, project: repository.toUpperCase() }, conversation);
    expect(next.isError, next.text).toBe(false);
    expect(running.tickets.list()[0]?.conversation).toBe(conversation);
    expect(running.conversations.get(conversation)?.repository).toBe(repository);
    expect((await callBrainTool(running, "set_topic_repository", { repository: null }, conversation)).isError).toBe(true);

    await stated(running, [first]);
    const card = (await cards(running)).find((candidate) => candidate.ticket.id === first.id);
    expect(card?.ticket.project).toBe(repository);
    expect((await ownerPost(running, chainStartPath, { chains: [{ ticket: first.id, fingerprint: card?.fingerprint }] })).status).toBe(202);
    const sent = [...runners.values()].flatMap((runner) => tasksSent(runner.sent, first.id));
    expect(sent).toMatchObject([{ task: { checkout: null, deploys: false, environment: {} } }]);
  });

  it("refuses what does not hold together, opening nothing", async () => {
    const { running } = await start();
    const base = { title: { en: "Do it", zh: "做" }, summary: { en: "Do it", zh: "做" }, task: "Do it.", kind: "operation" };
    const refusals = [
      [{ ...base, deploy: true }, "needs the repository"],
      [{ ...base, project: repository, deploy: true }, "needs the repository"],
      [{ ...base, project: repository, commit: "main" }, "needs the repository"],
      [{ ...base, project: repository, repository }, "without a checkout"],
      [{ ...base, commit: "main" }, "needs the repository"],
      [{ ...base, repository, commit: "merged" }, "name that chain's ticket in after"],
      [{ ...base, repository, after: ["zz"] }, "There is no ticket ZZ"],
      [{ ...base, kind: "writing", repository, deploy: true }, "a deployment is an operation"],
      [{ ...base, kind: "fix" }, "not valid"],
    ] as const;
    for (const [args, reason] of refusals) {
      const answer = await callBrainTool(running, "open_task_ticket", args);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(reason);
    }
    forge.file(repository, "head1", deploymentFile, JSON.stringify({ ...recipe, target: "hub" }));
    const invalid = await callBrainTool(running, "open_task_ticket", { ...base, repository, deploy: true });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("names no work machine");
    expect(running.tickets.list({})).toEqual([]);
  });

  it("keeps the brain's commands in the hub's container", async () => {
    const { running } = await start();
    const answer = await callBrainTool(running, "run_command", { target: "pc", command: "echo hi" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Nothing was run: pc is not where your commands run");
    expect(running.commands.list()).toEqual([]);
  });
});

describe("deployment eligibility in this installation", () => {
  const superAgent = "novan-xu/super-agent2";
  const superAgentTargets = ["mac-mini", "macbook-air", "pc"];

  function setRecipe(name: string, target: string | string[]): void {
    const commit = "deployment-head";
    forge.repository(name).mainline.push(commit);
    forge.file(name, commit, deploymentFile, JSON.stringify({ ...recipe, target }));
  }

  it("refuses Super Agent's NAS deployment when the only registered machine is local", async () => {
    const { running, conversation } = await start([machine("local")]);
    setRecipe(superAgent, superAgentTargets);
    const answer = await callBrainTool(running, "open_task_ticket", { ...deploymentRequest, repository: superAgent }, conversation);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("deployment targets: mac-mini, macbook-air, pc.");
    expect(answer.text).toContain("This installation's registered machines: local.");
    expect(answer.text).toContain("This deployment belongs to another installation. Tell the owner it must be arranged there.");
    expect(running.tickets.list()).toEqual([]);
  });

  it.each([
    { name: superAgent, target: superAgentTargets, constraints: { deploymentTargets: superAgentTargets, requiredMachine: null } },
    { name: "novan-xu/loom", target: "mac-mini", constraints: { requiredMachine: "mac-mini" } },
    { name: "novan-xu/Agent_wring", target: "mac-mini", constraints: { requiredMachine: "mac-mini" } },
  ])("opens the NAS deployment for $name with a registered target offline", async ({ name, target, constraints }) => {
    const { running, conversation } = await start([machine("outside")]);
    running.machines.add({ name: "mac-mini", accessClientId: "mac-mini.access", system: "macos" });
    setRecipe(name, target);
    const answer = await callBrainTool(running, "open_task_ticket", { ...deploymentRequest, repository: name }, conversation);
    expect(answer.isError, answer.text).toBe(false);
    expect(running.tickets.list()).toMatchObject([{ repository: name, deploys: true, ...constraints }]);
  });

  it("excludes revoked machines and reports an empty installation", async () => {
    const { running } = await start([]);
    running.machines.add({ name: "pc", accessClientId: "pc.access" });
    running.machines.revoke("pc");
    const answer = await callBrainTool(running, "open_task_ticket", deploymentRequest);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("deployment targets: pc.");
    expect(answer.text).toContain("This installation's registered machines: none.");
    expect(running.tickets.list()).toEqual([]);
  });

  it.each([
    { failure: "missing", note: "has no .superagent2/deployment.json on its default branch yet" },
    { failure: "unreadable", note: "GitHub could not be read" },
  ])("uses the requested platform when the manifest is $failure", async ({ failure, note }) => {
    const { running } = await start([machine("local")]);
    if (failure === "missing") forge.tree(repository, "head1", ["src/app.ts"]);
    else forge.failing = /\/contents\/\.superagent2\/deployment\.json/;
    const answer = await callBrainTool(running, "open_task_ticket", { ...deploymentRequest, platform: "macos" });
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).toContain(note);
    expect(running.tickets.list()).toMatchObject([{ requiredMachine: null, deploys: true, commitRef: null, platform: "macos" }]);
  });
});
