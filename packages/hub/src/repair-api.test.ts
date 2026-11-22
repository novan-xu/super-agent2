import { ticketReference } from "@super-agent2/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HubToRunner, type MachineReport, mergedCommit, protocolVersion, type Ticket, type WaitingCard, WaitingList, type WorkEvent } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import type { Hub } from "./hub.js";
import type { RunnerLink } from "./runners.js";
import { chainStartPath } from "./server.js";
import { assertion, keySet, personClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
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

const report: MachineReport = {
  hostname: "pc",
  platform: "win32",
  release: "1",
  arch: "x64",
  user: "owner",
  slots: { total: 4, free: 4 },
  programs: [
    {
      id: "claude",
      installed: true,
      path: "claude",
      version: "1",
      models: [
        { id: "claude-haiku-5-5", efforts: ["low", "medium"] },
        { id: "claude-sonnet-5-5", efforts: ["high"] },
        { id: "claude-opus-5-5", efforts: ["high", "max"] },
      ],
      source: "program",
      problem: null,
    },
    {
      id: "codex",
      installed: true,
      path: "codex",
      version: "1",
      models: [
        { id: "gpt-6.1-terra", efforts: ["high"] },
        { id: "gpt-6.1-sol", efforts: ["high"] },
      ],
      source: "program",
      problem: null,
    },
  ],
  allowances: [],
};

const seqs = new Map<string, number>();

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-repair-api-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  forge = fakeForge();
  seqs.clear();
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

interface Started {
  readonly running: Hub;
  readonly runner: RunnerLink;
  readonly sent: HubToRunner[];
  readonly conversation: string;
}

async function start(): Promise<Started> {
  const running = await startTestHub({
    config: testConfig(dataDir),
    keySource: staticKeySource(keySet(key)),
    clock,
    credentials,
    forgeFetch: forge.fetch,
    gitHubBase: fakeGitHubBase,
  });
  hub = running;
  running.machines.add({ name: "pc", accessClientId: "pc.access" });
  const machine = running.machines.get("pc");
  if (machine === undefined) {
    throw new Error("machine missing");
  }
  const sent: HubToRunner[] = [];
  const runner = running.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
  runner.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
  forge.woodpecker.set(repository, { id: 6, active: true, configFile: "", pipelines: [] });
  return { running, runner, sent, conversation: running.conversations.create().id };
}

const chainIssues = [7, 8, 9] as const;

const owner = { machine: "owner", engine: "owner", model: "owner", effort: "owner" } as const;

function openChain(running: Hub, conversation: string): Ticket {
  for (const issue of chainIssues) {
    forge.repository(repository).issues.set(issue, "open");
  }
  const opened = running.tickets.open({
    repository,
    issues: chainIssues.map((number) => ({
      repository,
      number,
      url: `https://github.com/${repository}/issues/${number}`,
      title: { en: `Step ${number}`, zh: `第 ${number} 步` },
      summary: { en: `Do step ${number}`, zh: `做第 ${number} 步` },
    })),
    title: { en: "Three steps", zh: "三步" },
    summary: { en: "Three steps in order", zh: "按顺序做三步" },
    kind: "feature",
    difficulty: "standard",
    platform: "windows",
    conversation,
  });
  running.tickets.change((writes) => {
    writes.choose(opened.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: owner });
    writes.move(opened.id, "working");
  });
  const ticket = running.tickets.get(opened.id);
  if (ticket === undefined || running.work === undefined) {
    throw new Error("setup failed");
  }
  running.work.begin(ticket);
  return current(running, opened.id);
}

function current(running: Hub, id: number): Ticket {
  const ticket = running.tickets.get(id);
  if (ticket === undefined) {
    throw new Error(`ticket ${id} missing`);
  }
  return ticket;
}

function event(runner: RunnerLink, ticket: number, attempt: number, body: WorkEvent): void {
  const name = `${ticket}:${attempt}`;
  const seq = (seqs.get(name) ?? 0) + 1;
  seqs.set(name, seq);
  runner.receive({ type: "work.event", ticket, attempt, seq, at: clock.now(), event: body });
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function post(running: Hub, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock, claims: personClaims() }), "content-type": "application/json", origin: base(running) },
  });
}

const NoticeRow = z.object({ body: z.string(), prompt: z.string().nullable() });

function notices(running: Hub, conversation: string): { readonly text: string; readonly prompt: string }[] {
  return running.database.connection
    .prepare("SELECT body, prompt FROM conversation_entries WHERE conversation_id = ? AND kind = 'notice' ORDER BY seq")
    .all(conversation)
    .map((row) => {
      const value = NoticeRow.parse(row);
      return { text: z.object({ text: z.string() }).parse(JSON.parse(value.body)).text, prompt: value.prompt ?? "" };
    });
}

function starts(sent: readonly HubToRunner[], ticket: number): Extract<HubToRunner, { readonly type: "work.start" }>[] {
  return sent.flatMap((message) => (message.type === "work.start" && message.task.ticket === ticket ? [message] : []));
}

function stops(sent: readonly HubToRunner[], ticket: number): Extract<HubToRunner, { readonly type: "work.stop" }>[] {
  return sent.flatMap((message) => (message.type === "work.stop" && message.ticket === ticket ? [message] : []));
}

function pipeline(number: number, commit: string, pull: number, state: "success" | "failure"): void {
  const found = forge.woodpecker.get(repository);
  if (found === undefined) {
    throw new Error("no Woodpecker repository");
  }
  const step = 900 + number;
  found.pipelines.push({
    number,
    commit,
    ref: `refs/pull/${pull}/merge`,
    event: "pull_request",
    status: state,
    workflows: [{ name: "check", state, steps: [{ id: step, name: "test", state, exitCode: state === "failure" ? 1 : 0 }] }],
    config: ["check"],
  });
  forge.logs.set(step, state === "failure" ? ["FAIL src/steps.test.ts: expected 8"] : []);
}

function pullAt(pull: number, head: string, branch: string, closes: readonly number[]): void {
  const existing = forge.repository(repository).pulls.get(pull);
  if (existing === undefined) {
    forge.pull(repository, pull, head, ["src/steps.ts"], branch, closes);
  } else {
    existing.head = head;
  }
  forge.tree(repository, head, ["src/steps.ts", ".woodpecker/check.yaml"]);
}

function handIn(runner: RunnerLink, ticket: number, attempt: number, pull: number, closes: readonly number[]): void {
  event(runner, ticket, attempt, { kind: "finished", pullRequest: pull, url: `https://github.com/${repository}/pull/${pull}`, closes: [...closes], report: { en: `Pull request ${pull}`, zh: `交了 PR ${pull}` } });
}

async function settled(running: Hub): Promise<void> {
  await running.verification.idle();
  await running.chains.idle();
}

const decision = {
  chosen: { en: "Steps are numbered from 7.", zh: "步骤从 7 开始编号。" },
  why: { en: "The issues are numbered that way.", zh: "问题就是这么编号的。" },
  otherOptions: { en: "Renumbering from 1.", zh: "从 1 重新编号。" },
};

interface Stuck {
  readonly started: Started;
  readonly chain: Ticket;
  readonly first: string;
  readonly second: string;
  readonly deployment: number;
  readonly waiting: number;
  readonly afterDeployment: number;
}

async function stuckOnSecondPull(): Promise<Stuck> {
  const started = await start();
  const { running, runner, conversation } = started;
  const chain = openChain(running, conversation);
  const first = current(running, chain.id).branch ?? "";
  event(runner, chain.id, 1, { kind: "phase", phase: "started", detail: "Started" });
  pullAt(21, "aaa111", first, [7]);
  pipeline(1, "aaa111", 21, "success");
  handIn(runner, chain.id, 1, 21, [7]);
  await settled(running);
  const second = current(running, chain.id).branch ?? "";
  expect(second).not.toBe(first);
  running.tickets.change((writes) => writes.recordDecisions(chain.id, "brain", [decision]));
  const deployment = running.tickets.open({
    form: "task",
    repository,
    issues: [],
    title: { en: "Deploy the steps", zh: "部署步骤" },
    summary: { en: "Deploy what the chain merged", zh: "部署链合并的内容" },
    kind: "operation",
    task: { task: "Deploy the repository.", materials: [], commitRef: mergedCommit, deploys: true },
    waitsFor: [chain.id],
    conversation,
  });
  const waiting = running.tickets.open({
    repository,
    issues: [{ repository, number: 30, url: `https://github.com/${repository}/issues/30`, title: { en: "Later", zh: "以后" }, summary: { en: "Later work", zh: "以后的工作" } }],
    title: { en: "Later work", zh: "以后的工作" },
    summary: { en: "Later work", zh: "以后的工作" },
    kind: "feature",
    waitsFor: [chain.id],
    conversation,
  });
  running.tickets.change((writes) => {
    writes.choose(waiting.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: owner });
    writes.move(waiting.id, "waiting");
  });
  const afterDeployment = running.tickets.open({
    repository,
    issues: [{ repository, number: 31, url: `https://github.com/${repository}/issues/31`, title: { en: "After deployment", zh: "部署之后" }, summary: { en: "After the deployment", zh: "部署之后的工作" } }],
    title: { en: "After deployment", zh: "部署之后" },
    summary: { en: "After the deployment", zh: "部署之后的工作" },
    kind: "feature",
    conversation,
  });
  running.tickets.change((writes) => writes.setWaits(afterDeployment.id, [{ ticket: chain.id, deployment: true }]));
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    event(runner, chain.id, attempt, { kind: "phase", phase: attempt === 2 ? "started" : "resumed", detail: "Working" });
    event(runner, chain.id, attempt, { kind: "text", block: "b", delta: `attempt ${attempt} could not make step 8 pass` });
    pullAt(22, `sha-${attempt}`, second, [8]);
    pipeline(attempt, `sha-${attempt}`, 22, "failure");
    handIn(runner, chain.id, attempt, 22, [8]);
    await settled(running);
    if (attempt < 5) {
      const guided = await callBrainTool(running, "guide_ticket", { ticket: chain.code, guidance: { en: `Round ${attempt - 1}: step 8 expects the number 8.`, zh: `第 ${attempt - 1} 轮：第 8 步要的是数字 8。` } }, conversation);
      expect(guided.isError, guided.text).toBe(false);
    }
  }
  const stuck = current(running, chain.id);
  expect(stuck).toMatchObject({ state: "stuck", round: 3, stuck: { from: "verifying", failure: { kind: "workflow" } } });
  const described = await callBrainTool(running, "describe_stuck", { ticket: chain.code, where: { en: "Step 8 keeps failing its own test.", zh: "第 8 步一直过不了自己的测试。" } });
  expect(described.isError, described.text).toBe(false);
  return { started, chain: stuck, first, second, deployment: deployment.id, waiting: waiting.id, afterDeployment: afterDeployment.id };
}

async function giveUp(running: Hub, ticket: Ticket, words?: string): Promise<Response> {
  const stuck = current(running, ticket.id).stuck;
  return post(running, `/api/tickets/${ticket.id}/answer`, { at: stuck?.at ?? 0, answer: "give-up", ...(words === undefined ? {} : { words }) });
}

describe("giving up a stuck chain", () => {
  it("stops the ticket in one press and opens a pending repair ticket that continues the work, with everything that waited on it", async () => {
    const { started, chain, second, deployment, waiting, afterDeployment } = await stuckOnSecondPull();
    const { running, sent, conversation } = started;
    const before = starts(sent, chain.id).length;
    const answered = await giveUp(running, chain, "换个更强的模型试试");
    expect(answered.status).toBe(202);

    const ended = current(running, chain.id);
    expect(ended).toMatchObject({ state: "stopped", stopReason: { zh: "引导到上限后，你放弃了它" }, repairs: null });
    const repair = current(running, ended.repairedBy ?? 0);
    expect(repair).toMatchObject({
      state: "pending",
      form: "code",
      repository,
      kind: "feature",
      difficulty: "standard",
      platform: "windows",
      repairs: chain.id,
      repairedBy: null,
      branch: second,
      round: 0,
      machine: null,
      work: null,
      conversation,
    });
    expect(repair.issues.map((issue) => issue.number)).toEqual([8, 9]);
    expect(repair.title).toEqual(chain.title);
    expect(starts(sent, chain.id)).toHaveLength(before);
    expect(starts(sent, repair.id)).toEqual([]);

    expect(running.tickets.repairRecord(repair.id)).toMatchObject({
      repairs: chain.id,
      openedBy: "owner",
      words: "换个更强的模型试试",
      round: 3,
      failure: { kind: "workflow" },
      where: { en: "Step 8 keeps failing its own test." },
    });

    expect(current(running, deployment).waits.map((wait) => [wait.ticket, wait.deployment])).toEqual([[repair.id, false]]);
    expect(current(running, waiting)).toMatchObject({ state: "waiting" });
    expect(current(running, waiting).waits.map((wait) => [wait.ticket, wait.deployment])).toEqual([[repair.id, false]]);
    expect(current(running, afterDeployment).waits.map((wait) => [wait.ticket, wait.deployment])).toEqual([[repair.id, true]]);

    expect(stops(sent, chain.id)).toEqual([{ type: "work.stop", ticket: chain.id, save: true, remove: false }]);

    const told = notices(running, conversation).at(-1);
    expect(told?.text).toBe(`你放弃了工单 ${chain.code.toUpperCase()}，已开补救工单 ${repair.code.toUpperCase()}，等你开始`);
    expect(told?.prompt).toContain(`A repair ticket was opened for ticket ${ticketReference(chain)} in the same step: ticket ${ticketReference(repair)}. It is pending: the hub does not start it`);
    expect(told?.prompt).toContain(`It continues on branch ${second}`);
    expect(told?.prompt).toContain("the issues still open: #8, #9");
    expect(told?.prompt).toContain(`What waited for ticket ${ticketReference(chain)} now waits for ticket ${ticketReference(repair)}`);
    expect(told?.prompt).toContain("choose_defaults");
    expect(told?.prompt).toContain("Consider a higher difficulty if the failed run warrants it.");
    expect(told?.prompt).toContain("with a fresh round count");
    expect(told?.prompt).toContain("The owner's words, which the repair's worker is given as well: 换个更强的模型试试");
    expect(told?.prompt).toContain(chain.decisions[0]?.chosen.en ?? "missing");
    expect(notices(running, conversation).map((entry) => entry.text)).not.toContain(`工单 ${chain.code.toUpperCase()} 停止了，排在它后面的工单 ${deployment} 由大脑决定是否继续`);

    expect(running.waiting.cards().some((card) => card.kind === "stuck")).toBe(false);
    expect(running.waiting.cards().map((card) => [card.kind, card.kind === "start" ? card.ticket.id : 0])).toContainEqual(["start", repair.id]);
    expect((await post(running, `/api/tickets/${chain.id}/answer`, { at: 1, answer: "give-up" })).status).toBe(409);

    const read = await callBrainTool(running, "read_ticket", { ticket: repair.code }, conversation);
    expect(read.text).toContain(`[repair of ticket ${ticketReference(chain)}]`);
    expect(read.text).toContain(`This is a repair ticket: it carries on the work of ticket ${ticketReference(chain)}`);
    const readEnded = await callBrainTool(running, "read_ticket", { ticket: chain.code }, conversation);
    expect(readEnded.text).toContain(`[repaired by ticket ${ticketReference(repair)}]`);
    expect(readEnded.text).toContain(`Its work goes on in repair ticket ${ticketReference(repair)}`);
    const listed = await callBrainTool(running, "list_tickets", { all: true }, conversation);
    expect(listed.text).toContain(`Ticket ${ticketReference(repair)} [pending] feature in ${repository} (issues #8, #9)`);
    expect(listed.text).toContain(`[repair of ticket ${ticketReference(chain)}]`);
  });

  it("starts the repair and what waits on it together, gives its worker the account of the failure, and removes the old folder only when the repair ends", async () => {
    const { started, chain, second, deployment, waiting, afterDeployment } = await stuckOnSecondPull();
    const { running, runner, sent, conversation } = started;
    expect((await giveUp(running, chain, "换个更强的模型试试")).status).toBe(202);
    const repair = current(running, current(running, chain.id).repairedBy ?? 0);

    event(runner, chain.id, 5, { kind: "stopped", saved: true, detail: "Committed the uncommitted changes and pushed the branch" });
    expect(running.tickets.repairRecord(repair.id)).toMatchObject({ saved: true, savedDetail: "Committed the uncommitted changes and pushed the branch" });
    expect(stops(sent, chain.id).filter((stop) => stop.remove)).toEqual([]);
    runner.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [{ ticket: chain.id, attempt: 5, last: 0, live: false, ended: true }] });
    expect(stops(sent, chain.id).filter((stop) => stop.remove)).toEqual([]);

    const stated = await callBrainTool(
      running,
      "choose_defaults",
      {
        chains: [
          { ticket: repair.code, kind: "feature", issues: [{ number: 8, difficulty: "complex" }, { number: 9, difficulty: "standard" }], reason: { en: "A stronger model for the step that kept failing", zh: "换个更强的模型来做一直失败的那一步" }, platform: "windows", engine: "codex" },
          { ticket: running.tickets.reference(deployment), kind: "operation", difficulty: "standard", reason: { en: "A deployment", zh: "一次部署" }, platform: "windows", engine: "claude" },
          { ticket: running.tickets.reference(afterDeployment), kind: "feature", issues: [{ number: 31, difficulty: "standard" }], reason: { en: "Small", zh: "很小" }, platform: "windows", engine: "claude" },
        ],
      },
      conversation,
    );
    expect(stated.isError, stated.text).toBe(false);
    const cards = (await (await fetch(`${base(running)}/api/waiting`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } })).json()) as unknown;
    const startCards = WaitingList.parse(cards).cards.flatMap((card: WaitingCard) => (card.kind === "start" ? [card] : []));
    const card = startCards.find((entry) => entry.ticket.id === repair.id);
    expect(card).toMatchObject({ ticket: { repairs: chain.id }, choice: { engine: "codex", model: "gpt-6.1-sol", missing: [] } });
    expect(card?.ticket.difficultyReason?.zh).toBe("换个更强的模型来做一直失败的那一步");
    expect(startCards.map((entry) => entry.ticket.id).sort()).toEqual([repair.id, deployment, afterDeployment].sort());
    const response = await post(running, chainStartPath, { chains: [{ ticket: repair.id, fingerprint: card?.fingerprint ?? "" }] });
    expect(response.status).toBe(202);
    await settled(running);

    expect(current(running, repair.id)).toMatchObject({ state: "working", machine: "pc", engine: "codex", work: { attempt: 1, state: "preparing" } });
    expect(current(running, deployment).state).toBe("waiting");
    expect(current(running, afterDeployment).state).toBe("waiting");
    expect(current(running, waiting).state).toBe("waiting");

    const [message] = starts(sent, repair.id);
    expect(message?.task).toMatchObject({ ticket: repair.id, attempt: 1, branch: second, takeover: true, folder: chain.id, merged: [], engine: "codex", model: "gpt-6.1-sol" });
    expect(message?.task.issues.map((issue) => issue.number)).toEqual([8, 9]);
    const note = message?.task.note ?? "";
    expect(note).toContain(`You are working on ticket ${ticketReference(repair)}, a repair ticket opened when the owner gave up ticket ${ticketReference(chain)}`);
    expect(note).toContain("Guided round 1: the attempt it answered failed because a Woodpecker workflow");
    expect(note).toContain("Round 3: step 8 expects the number 8.");
    expect(note).toContain("It stopped for the owner after 3 guided rounds");
    expect(note).toContain("Where it was stuck, in the brain's words: Step 8 keeps failing its own test.");
    expect(note).toContain("The owner's words when they gave it up: 换个更强的模型试试");
    expect(note).toContain("Pull requests of this chain so far: #21 (merged, closes #7); #22 (open, closes #8).");
    expect(note).toContain("Issues closed by merged pull requests, which stay closed: #7. Still open, and your chain: #8, #9.");
    expect(note).toContain("Pull request #22 is open from the branch.");
    expect(note).toContain("You work in the same folder the earlier worker left on pc, on the same branch");
    expect(note).toContain("They were also committed and pushed to the branch when the ticket ended.");
    expect(note).toContain("Steps are numbered from 7.");
    expect(note).toContain("attempt 5 could not make step 8 pass");

    event(runner, repair.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    pullAt(22, "rrr-1", second, [8]);
    pipeline(10, "rrr-1", 22, "success");
    handIn(runner, repair.id, 1, 22, [8]);
    await settled(running);
    const next = current(running, repair.id);
    expect(next).toMatchObject({ state: "working", work: { attempt: 2 } });
    expect(next.pullRequests.map((pull) => [pull.number, pull.state, pull.closes])).toEqual([[22, "merged", [8]]]);
    expect(next.branch).not.toBe(second);
    const third = starts(sent, repair.id)[1];
    expect(third?.task).toMatchObject({ folder: chain.id, merged: [8] });
    expect(stops(sent, chain.id).filter((stop) => stop.remove)).toEqual([]);

    event(runner, repair.id, 2, { kind: "phase", phase: "resumed", detail: "Resumed" });
    pullAt(23, "rrr-2", next.branch ?? "", [9]);
    pipeline(11, "rrr-2", 23, "success");
    handIn(runner, repair.id, 2, 23, [9]);
    await settled(running);
    const done = current(running, repair.id);
    expect(done).toMatchObject({ state: "merged" });
    expect(stops(sent, repair.id).filter((stop) => stop.remove)).toEqual([{ type: "work.stop", ticket: repair.id, save: false, remove: true }]);
    expect(stops(sent, chain.id).filter((stop) => stop.remove)).toEqual([{ type: "work.stop", ticket: chain.id, save: false, remove: true }]);

    const mergeCommit = done.verification?.mergeCommit ?? done.pullRequests.at(-1)?.mergeCommit ?? "";
    expect(mergeCommit).not.toBe("");
    const deploy = sent.flatMap((entry) => (entry.type === "work.task" && entry.task.ticket === deployment ? [entry] : []));
    expect(deploy).toHaveLength(1);
    expect(deploy[0]?.task.checkout).toMatchObject({ repository, commit: mergeCommit });
    expect(current(running, deployment).state).toBe("working");
    expect(current(running, waiting).state).toBe("working");
    expect(current(running, afterDeployment).state).toBe("waiting");
  });

  it("opens a repair of a repair, with the whole lineage in the note and in one folder", async () => {
    const { started, chain } = await stuckOnSecondPull();
    const { running, sent, conversation } = started;
    expect((await giveUp(running, chain)).status).toBe(202);
    const first = current(running, current(running, chain.id).repairedBy ?? 0);
    running.tickets.change((writes) => {
      writes.choose(first.id, { machine: "pc", engine: "claude", model: "claude-opus-5-5", effort: "high", by: owner });
      writes.move(first.id, "working");
    });
    const begun = current(running, first.id);
    running.work?.begin(begun);
    expect(starts(sent, first.id)).toHaveLength(1);
    running.tickets.change((writes) => {
      writes.stick(first.id, { kind: "program", detail: "boom" });
      writes.describeStuck(first.id, { en: "The program keeps crashing.", zh: "程序一直崩溃。" });
    });
    const at = current(running, first.id).stuck?.at ?? 0;
    expect((await post(running, `/api/tickets/${first.id}/answer`, { at, answer: "give-up", words: "again" })).status).toBe(202);
    const second = current(running, current(running, first.id).repairedBy ?? 0);
    expect(second).toMatchObject({ state: "pending", repairs: first.id });
    expect(running.tickets.lineage(second.id).map((ticket) => ticket.id)).toEqual([chain.id, first.id]);
    expect(second.issues.map((issue) => issue.number)).toEqual([8, 9]);
    expect(second.branch).toBe(first.branch);

    running.tickets.change((writes) => {
      writes.choose(second.id, { machine: "pc", engine: "claude", model: "claude-opus-5-5", effort: "high", by: owner });
      writes.move(second.id, "working");
    });
    running.work?.begin(current(running, second.id));
    const message = starts(sent, second.id)[0];
    expect(message?.task).toMatchObject({ takeover: true, folder: chain.id });
    const note = message?.task.note ?? "";
    expect(note).toContain(`Ticket ${ticketReference(chain)} (Three steps) ended stopped`);
    expect(note).toContain(`Ticket ${ticketReference(first)} (Three steps) ended stopped`);
    expect(note).toContain("Round 3: step 8 expects the number 8.");
    expect(note).toContain("the worker's program failed");
    expect(note).toContain("Where it was stuck, in the brain's words: The program keeps crashing.");
    expect(note).toContain("The owner's words when they gave it up: again");
    expect(note).toContain("You work in the same folder the earlier worker left on pc, on the same branch");
    expect(note).toContain("Whether they were committed and pushed was not reported.");
    expect(stops(sent, first.id)).toEqual([{ type: "work.stop", ticket: first.id, save: true, remove: false }]);
    expect(stops(sent, chain.id).filter((stop) => stop.remove)).toEqual([]);

    const recorded = running.tickets.change((writes) => writes.recordDecisions(second.id, "worker", [decision, { ...decision, chosen: { en: "A new choice.", zh: "新的选择。" } }]));
    expect(recorded.map((entry) => entry.chosen.en)).toEqual(["A new choice."]);
    expect(notices(running, conversation).at(-1)?.text).toBe(`你放弃了工单 ${first.code.toUpperCase()}，已开补救工单 ${second.code.toUpperCase()}，等你开始`);
  });
});

describe("repairing a stopped ticket in conversation", () => {
  it("opens nothing when the owner stops a running ticket, and opens a repair when the brain is asked to, once", async () => {
    const { running, runner, conversation } = await start();
    const chain = openChain(running, conversation);
    const branch = current(running, chain.id).branch ?? "";
    event(runner, chain.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    pullAt(21, "aaa111", branch, [7]);
    pipeline(1, "aaa111", 21, "success");
    handIn(runner, chain.id, 1, 21, [7]);
    await settled(running);
    const next = current(running, chain.id).branch ?? "";
    const waits = running.tickets.open({
      repository,
      issues: [{ repository, number: 30, url: `https://github.com/${repository}/issues/30`, title: { en: "Later", zh: "以后" }, summary: { en: "Later work", zh: "以后的工作" } }],
      title: { en: "Later work", zh: "以后的工作" },
      summary: { en: "Later work", zh: "以后的工作" },
      kind: "feature",
      waitsFor: [chain.id],
      conversation,
    });
    running.tickets.change((writes) => {
      writes.choose(waits.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: owner });
      writes.move(waits.id, "waiting");
    });
    expect((await post(running, `/api/tickets/${chain.id}/stop`, {})).status).toBe(202);
    const stopped = current(running, chain.id);
    expect(stopped).toMatchObject({ state: "stopped", repairedBy: null });
    expect(running.tickets.list({ open: true }).filter((ticket) => ticket.repairs !== null)).toEqual([]);
    expect(notices(running, conversation).map((entry) => entry.text)).toContain(`你停止了工单 ${chain.code.toUpperCase()}，已合并的部分保留`);
    expect(notices(running, conversation).map((entry) => entry.text)).toContain(`工单 ${chain.code.toUpperCase()} 停止了，排在它后面的工单 ${waits.code.toUpperCase()} 由大脑决定是否继续`);

    const missing = await callBrainTool(running, "open_repair_ticket", { ticket: "zz" }, conversation);
    expect(missing).toMatchObject({ isError: true });
    const working = await callBrainTool(running, "open_repair_ticket", { ticket: waits.code }, conversation);
    expect(working.isError).toBe(true);
    expect(working.text).toContain("only a stopped ticket");

    const opened = await callBrainTool(running, "open_repair_ticket", { ticket: chain.code }, conversation);
    expect(opened.isError, opened.text).toBe(false);
    const repair = current(running, current(running, chain.id).repairedBy ?? 0);
    expect(repair).toMatchObject({ state: "pending", repairs: chain.id, branch: next });
    expect(repair.issues.map((issue) => issue.number)).toEqual([8, 9]);
    expect(opened.text).toContain(`Opened repair ticket ${ticketReference(repair)}.`);
    expect(opened.text).toContain("choose_defaults");
    expect(running.tickets.repairRecord(repair.id)).toMatchObject({ openedBy: "brain", words: "", failure: null, where: null });
    expect(current(running, waits.id).waits.map((wait) => wait.ticket)).toEqual([repair.id]);
    expect(current(running, waits.id).state).toBe("waiting");

    const again = await callBrainTool(running, "open_repair_ticket", { ticket: chain.code }, conversation);
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already has a repair ticket");
  });

  it("refuses a stuck ticket, a joined ticket and a ticket with nothing left", async () => {
    const { running, conversation } = await start();
    const chain = openChain(running, conversation);
    running.tickets.change((writes) => writes.stick(chain.id, { kind: "program", detail: "boom" }));
    const stuck = await callBrainTool(running, "open_repair_ticket", { ticket: chain.code }, conversation);
    expect(stuck.isError).toBe(true);
    expect(stuck.text).toContain("only the owner decides now");

    const done = openChain(running, conversation);
    running.tickets.change((writes) => {
      writes.setPullRequest(done.id, 150, { en: "Done", zh: "做完了" }, { closes: [7, 8, 9] });
      writes.pullRequestMerged(done.id, { number: 150, closes: [7, 8, 9], mergeCommit: "mm", deployment: null });
      writes.move(done.id, "stopped", { en: "Stopped", zh: "停止" });
    });
    const nothing = await callBrainTool(running, "open_repair_ticket", { ticket: done.code }, conversation);
    expect(nothing.isError).toBe(true);
    expect(nothing.text).toContain("nothing remains");

    const joined = openChain(running, conversation);
    running.tickets.change((writes) => writes.join(joined.id, chain.id, { en: "Joined", zh: "并入" }));
    const refused = await callBrainTool(running, "open_repair_ticket", { ticket: joined.code }, conversation);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("joined into another ticket");
  });

  it("refuses to regroup a repair ticket, and says a stopped ticket's repair is what to come after", async () => {
    const { running, conversation } = await start();
    const chain = openChain(running, conversation);
    running.tickets.change((writes) => writes.move(chain.id, "stopped", { en: "Stopped", zh: "停止" }));
    const repaired = running.tickets.repair(chain.id, "brain", "");
    if (!repaired.ok) {
      throw new Error(repaired.reason);
    }
    const arranged = await callBrainTool(running, "arrange_chains", { chains: [{ name: "again", repository, issues: [7, 8, 9] }] }, conversation);
    expect(arranged.isError).toBe(true);
    expect(arranged.text).toContain("a repair ticket that continues the work");
    const later = await callBrainTool(running, "open_task_ticket", { title: { en: "Deploy", zh: "部署" }, summary: { en: "Deploy it", zh: "部署它" }, task: "Deploy it.", kind: "operation", repository, after: [chain.code] }, conversation);
    expect(later.isError).toBe(true);
    expect(later.text).toContain(`ticket ${ticketReference(repaired.ticket)} repairs it, so come after that`);
  });
});

describe("giving up a stuck task ticket", () => {
  it("opens the same task again, keeps its pinned machine and commit, and pins nothing else", async () => {
    const { running, sent, conversation } = await start();
    const opened = running.tickets.open({
      form: "task",
      repository,
      issues: [],
      title: { en: "Deploy the sandbox", zh: "部署沙盒" },
      summary: { en: "Deploy it", zh: "部署它" },
      kind: "operation",
      difficulty: "standard",
      platform: "windows",
      requiredMachine: "pc",
      task: { task: "Deploy the sandbox.", materials: [{ name: "notes.txt", source: "the owner", text: "careful" }], commitRef: "main", deploys: true },
      conversation,
    });
    running.tickets.change((writes) => {
      writes.choose(opened.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: owner });
      writes.setCommit(opened.id, "abc1234");
      writes.move(opened.id, "working");
    });
    running.work?.begin(current(running, opened.id));
    expect(sent.filter((message) => message.type === "work.task")).toHaveLength(1);
    running.tickets.change((writes) => writes.stick(opened.id, { kind: "task-failed", detail: "the health check never passed" }));
    const stuck = current(running, opened.id);
    expect((await post(running, `/api/tickets/${opened.id}/answer`, { at: stuck.stuck?.at ?? 0, answer: "give-up" })).status).toBe(202);
    const repair = current(running, current(running, opened.id).repairedBy ?? 0);
    expect(repair).toMatchObject({ state: "pending", form: "task", kind: "operation", repository, requiredMachine: "pc", deploys: true, commitRef: "main", commit: "abc1234", repairs: opened.id, issues: [], branch: null });
    expect(running.tickets.task(repair.id)).toMatchObject({ task: "Deploy the sandbox.", materials: [{ name: "notes.txt", text: "careful" }], deploys: true });
    expect(stops(sent, opened.id)).toEqual([]);

    running.tickets.change((writes) => {
      writes.choose(repair.id, { machine: "pc", engine: "claude", model: "claude-sonnet-5-5", effort: "high", by: owner });
      writes.move(repair.id, "working");
    });
    running.work?.begin(current(running, repair.id));
    const message = sent.flatMap((entry) => (entry.type === "work.task" && entry.task.ticket === repair.id ? [entry] : []))[0];
    expect(message?.task).toMatchObject({ takeover: true, folder: opened.id, task: "Deploy the sandbox.", checkout: { repository, commit: "abc1234" } });
    expect(message?.task.note).toContain("The task and its material are given to you again in full.");
    expect(message?.task.note).toContain("the worker handed back that its task failed (the health check never passed)");
  });
});
