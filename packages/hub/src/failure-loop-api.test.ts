import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HubToRunner, type MachineReport, protocolVersion, type Ticket, TicketDetail, TicketResponse, type WorkEvent } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import type { Hub } from "./hub.js";
import { payloadOf } from "./notifier.js";
import type { RunnerLink } from "./runners.js";
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

const report: MachineReport = { hostname: "pc", platform: "win32", release: "1", arch: "x64", user: "owner", slots: { total: 2, free: 2 }, programs: [], allowances: [] };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-loop-api-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  forge = fakeForge();
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

function begin(running: Hub, conversation: string, issue: number): Ticket {
  forge.repository(repository).issues.set(issue, "open");
  const summary = { en: "Add a greeting", zh: "加一句问候" };
  const opened = running.tickets.open({
    repository,
    issues: [{ repository, number: issue, url: `https://github.com/${repository}/issues/${issue}`, title: { en: "Greet", zh: "问候" }, summary }],
    title: { en: `Greet ${issue}`, zh: `问候 ${issue}` },
    summary,
    kind: "feature",
    conversation,
  });
  running.tickets.change((writes) => {
    writes.choose(opened.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } });
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

const seqs = new Map<string, number>();

function event(runner: RunnerLink, ticket: number, attempt: number, body: WorkEvent): void {
  const key = `${ticket}:${attempt}`;
  const seq = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, seq);
  runner.receive({ type: "work.event", ticket, attempt, seq, at: clock.now(), event: body });
}

beforeEach(() => {
  seqs.clear();
});

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function post(running: Hub, path: string, body: unknown, headers: Record<string, string> = {}, email?: string): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Cf-Access-Jwt-Assertion": await assertion({ key, clock, claims: personClaims(email) }),
      "content-type": "application/json",
      origin: base(running),
      ...headers,
    },
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

function pipeline(number: number, commit: string, pull: number, state: "success" | "failure" | "killed", log: readonly string[] = []): void {
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
    workflows: [{ name: "check", state, steps: [{ id: step, name: "test", state, exitCode: state === "killed" ? null : state === "failure" ? 1 : 0 }] }],
    config: ["check"],
  });
  forge.logs.set(step, [...log]);
}

function pullAt(pull: number, head: string, branch: string): void {
  const existing = forge.repository(repository).pulls.get(pull);
  if (existing === undefined) {
    forge.pull(repository, pull, head, ["src/greet.ts"], branch);
  } else {
    existing.head = head;
  }
  forge.tree(repository, head, ["src/greet.ts", ".woodpecker/check.yaml"]);
}

async function settled(running: Hub): Promise<void> {
  await running.verification.idle();
  await running.chains.idle();
}

const guidance = (round: number) => ({ en: `Round ${round}: the test expects "hello"; change greet() to return it.`, zh: `第 ${round} 轮：测试要的是 "hello"，把 greet() 改成返回它。` });

async function failThreeRounds(started: Started, issue: number): Promise<Ticket> {
  const { running, runner, conversation } = started;
  const ticket = begin(running, conversation, issue);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    event(runner, ticket.id, attempt, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, attempt, { kind: "text", block: "b", delta: `attempt ${attempt} could not find greet.ts` });
    event(runner, ticket.id, attempt, { kind: "tool.started", call: "t", name: "shell", input: "pnpm test" });
    event(runner, ticket.id, attempt, { kind: "tool.output", call: "t", delta: `FAIL greet.test.ts in attempt ${attempt}\n` });
    event(runner, ticket.id, attempt, { kind: "tool.finished", call: "t", output: null, ok: false });
    event(runner, ticket.id, attempt, { kind: "failed", failure: "no-pull-request", reason: "You have not handed back a pull request" });
    if (attempt < 4) {
      const guided = await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: guidance(attempt) }, conversation);
      expect(guided.isError, guided.text).toBe(false);
      expect(guided.text).toContain(`guided round ${attempt} of 3`);
    }
  }
  return current(running, ticket.id);
}

describe("the failure loop, unattended", () => {
  it("reports a killed step and its log and accepts a guided round", async () => {
    const { running, runner, conversation } = await start();
    const ticket = begin(running, conversation, 5);
    const branch = current(running, ticket.id).branch ?? "";
    pullAt(12, "abc123", branch);
    pipeline(1, "abc123", 12, "killed", ["test still running"]);
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, 1, { kind: "finished", pullRequest: 12, url: `https://github.com/${repository}/pull/12`, report: { en: "Done", zh: "做完了" } });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "verifying", verification: { state: "failed", failures: [{ workflow: "check", step: "test" }] } });
    const [told] = notices(running, conversation);
    expect(told?.prompt).toContain("workflow check, step test was killed");
    expect(told?.prompt).toContain("test still running");
    const guided = await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: guidance(1) }, conversation);
    expect(guided.isError, guided.text).toBe(false);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 1 });
  });

  it("fixes a ticket whose pipeline is red in one guided round, and merges it", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation, 4);
    const branch = current(running, ticket.id).branch ?? "";
    pullAt(12, "abc123", branch);
    const log = [...Array.from({ length: 3000 }, (_, index) => `ok ${index} a passing test with a long name`), "FAIL src/greet.test.ts: expected hello, got hi"];
    pipeline(1, "abc123", 12, "failure", log);
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, 1, { kind: "finished", pullRequest: 12, url: `https://github.com/${repository}/pull/12`, report: { en: "Done", zh: "做完了" } });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "verifying", round: 0, verification: { state: "failed" } });
    const [told] = notices(running, conversation);
    expect(told?.text).toBe(`工单 ${ticket.id} 没有通过验证，大脑会决定怎么处理`);
    expect(told?.prompt).toContain("a Woodpecker workflow on its pull request's head is red");
    expect(told?.prompt).toContain("FAIL src/greet.test.ts: expected hello, got hi");
    expect(told?.prompt).toMatch(/\[the first \d+ of \d+ characters are cut; this is the end, where the failure is\]/);
    expect(told?.prompt).toContain("Your guidance starts round 1");
    expect(told?.prompt).toContain("guide_ticket");

    const guided = await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: guidance(1) }, conversation);
    expect(guided.isError, guided.text).toBe(false);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 1, branch, work: { attempt: 2 } });
    const [, second] = starts(sent, ticket.id);
    expect(second?.task).toMatchObject({ attempt: 2, branch });
    expect(second?.task.note).toContain("Guided round 1 of 3.");
    expect(second?.task.note).toContain(guidance(1).en);
    expect(second?.task.note).toContain("hand back the same pull request #12");

    pullAt(12, "def456", branch);
    pipeline(2, "def456", 12, "success");
    event(runner, ticket.id, 2, { kind: "phase", phase: "resumed", detail: "Resumed" });
    event(runner, ticket.id, 2, { kind: "finished", pullRequest: 12, url: `https://github.com/${repository}/pull/12`, report: { en: "Fixed the greeting", zh: "改好了问候" } });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "merged", round: 1 });
    expect(forge.merges).toEqual([{ repository, number: 12, sha: "def456", method: "squash" }]);
    expect(notices(running, conversation).map((entry) => entry.text)).toEqual([`工单 ${ticket.id} 没有通过验证，大脑会决定怎么处理`, `工单 ${ticket.id} 已合并`]);

    const detail = TicketDetail.parse(await (await fetch(`${base(running)}/api/tickets/${ticket.id}`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } })).json());
    expect(detail.rounds).toEqual([{ seq: 1, round: 1, attempt: 2, failure: { kind: "workflow", detail: expect.stringContaining("failed") as unknown as string }, guidance: guidance(1), at: clock.now() }]);
    expect(detail.moves.map((move) => [move.from, move.to, move.reason?.zh ?? null])).toContainEqual(["verifying", "working", "第 1 轮引导"]);
  });

  it("sends a conflict back to the worker each time, with the files changed on both sides, and never counts it or tells the brain of a failure", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation, 5);
    const branch = current(running, ticket.id).branch ?? "";
    pullAt(13, "aaa111", branch);
    const pull = forge.repository(repository).pulls.get(13);
    if (pull === undefined) {
      throw new Error("pull missing");
    }
    pull.mergeable = false;
    pull.baseFiles = ["src/greet.ts", "README.md"];
    pipeline(1, "aaa111", 13, "success");
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, 1, { kind: "finished", pullRequest: 13, url: `https://github.com/${repository}/pull/13`, report: { en: "Done", zh: "做完了" } });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 0, work: { attempt: 2 } });
    expect(starts(sent, ticket.id)).toHaveLength(2);
    event(runner, ticket.id, 2, { kind: "phase", phase: "resumed", detail: "Resumed" });
    event(runner, ticket.id, 2, { kind: "finished", pullRequest: 13, url: `https://github.com/${repository}/pull/13`, report: { en: "Done", zh: "做完了" } });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 0, work: { attempt: 3 }, verification: { conflictReturns: 2 } });
    expect(starts(sent, ticket.id)).toHaveLength(3);
    expect(JSON.stringify(starts(sent, ticket.id).at(-1))).toContain("Files changed both by the pull request and on main since it branched: src/greet.ts");
    expect(notices(running, conversation).filter((entry) => entry.prompt.includes("failed"))).toEqual([]);
    const refused = await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: { en: "Merge main and keep both greetings.", zh: "合并 main，两句问候都留下。" } }, conversation);
    expect(refused.isError).toBe(true);
    const read = await callBrainTool(running, "read_ticket", { ticket: ticket.id }, conversation);
    expect(read.text).toContain("went back to its worker for a conflict 2 times");
    expect(current(running, ticket.id).round).toBe(0);
  });

  it("does not count one retry after the machine lost the worker, and counts the next", async () => {
    const { running, runner, conversation } = await start();
    const ticket = begin(running, conversation, 6);
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    runner.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
    expect(current(running, ticket.id)).toMatchObject({ work: { state: "failed", failure: "lost" } });
    expect(notices(running, conversation).at(-1)?.prompt).toContain("not counted as a guided round");
    const retried = await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: { en: "Start again from the branch.", zh: "从分支上重新开始。" } }, conversation);
    expect(retried.text).toContain("a retry not counted as a guided round");
    expect(current(running, ticket.id)).toMatchObject({ round: 0, freeRetry: true, work: { attempt: 2 } });
    event(runner, ticket.id, 2, { kind: "phase", phase: "started", detail: "Started" });
    runner.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
    expect(notices(running, conversation).at(-1)?.prompt).toContain("Your guidance starts round 1");
    await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: { en: "Start again from the branch.", zh: "从分支上重新开始。" } }, conversation);
    expect(current(running, ticket.id)).toMatchObject({ round: 1, freeRetry: false, work: { attempt: 3 } });
    expect(running.tickets.rounds(ticket.id).map((round) => [round.round, round.attempt, round.failure.kind])).toEqual([
      [null, 2, "lost"],
      [1, 3, "lost"],
    ]);
  });
});

describe("the retry cap", () => {
  it("stops a ticket after three guided rounds for the owner, keeps its work, and shows a card with a notification", async () => {
    const started = await start();
    const { running, sent, conversation } = started;
    const ticket = await failThreeRounds(started, 7);
    expect(ticket).toMatchObject({ state: "stuck", round: 3, stuck: { round: 3, from: "working", failure: { kind: "no-pull-request" }, where: null } });
    expect(ticket.branch).toMatch(/^sa2\/ticket-/);
    expect(sent.filter((message) => message.type === "work.stop")).toEqual([]);
    const told = notices(running, conversation).at(-1);
    expect(told?.text).toBe(`工单 ${ticket.id} 引导 3 轮还没通过，已停下等你决定`);
    expect(told?.prompt).toContain("describe_stuck");
    expect(told?.prompt).toContain("attempt 4 could not find greet.ts");
    expect(told?.prompt).toContain("FAIL greet.test.ts in attempt 4");
    const card = running.waiting.cards().find((entry) => entry.kind === "stuck");
    expect(card).toMatchObject({ kind: "stuck", key: `stuck:${ticket.id}-${ticket.stuck?.at ?? 0}`, ticket: { id: ticket.id }, guidance: guidance(3) });
    if (card === undefined) {
      throw new Error("no card");
    }
    expect(payloadOf(card)).toEqual({ title: "等你", body: `工单 ${ticket.id} 引导 3 轮还没通过，等你决定`, url: `/workbench?card=${encodeURIComponent(card.key)}`, tag: card.key });

    const described = await callBrainTool(running, "describe_stuck", { ticket: ticket.id, where: { en: "The worker cannot find greet.ts; the issue names a file that does not exist.", zh: "工作者找不到 greet.ts，问题里写的文件并不存在。" } });
    expect(described.isError, described.text).toBe(false);
    expect(running.waiting.cards().find((entry) => entry.kind === "stuck")).toMatchObject({ ticket: { stuck: { where: { zh: "工作者找不到 greet.ts，问题里写的文件并不存在。" } } } });
    const detail = TicketDetail.parse(await (await fetch(`${base(running)}/api/tickets/${ticket.id}`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } })).json());
    expect(detail.rounds.map((round) => [round.round, round.attempt, round.guidance.zh])).toEqual([
      [1, 2, guidance(1).zh],
      [2, 3, guidance(2).zh],
      [3, 4, guidance(3).zh],
    ]);
  });

  it("starts no fourth round by any path the brain can reach", async () => {
    const started = await start();
    const { running, sent, conversation } = started;
    const ticket = await failThreeRounds(started, 8);
    const attempts = starts(sent, ticket.id).length;
    const refused = async (name: string, args: Record<string, unknown>) => {
      const answer = await callBrainTool(running, name, args, conversation);
      expect(answer.isError, `${name}: ${answer.text}`).toBe(true);
      return answer.text;
    };
    expect(await refused("guide_ticket", { ticket: ticket.id, guidance: guidance(4) })).toContain("only the owner's answer on its card");
    expect(await refused("merge_ticket", { ticket: ticket.id, reason: "Merge it anyway" })).toContain(`Ticket ${ticket.id} is stuck`);
    expect(await refused("message_worker", { ticket: ticket.id, text: "Try again" })).toContain("has no running worker");
    expect(await refused("stop_ticket", { ticket: ticket.id, reason: { en: "Start over", zh: "重来" } })).toContain("only the owner decides now");
    expect(running.work?.again(ticket.id, "Resolve the conflict", { en: "Conflict", zh: "有冲突" })).toMatchObject({ ok: false });
    expect(running.work?.again(ticket.id, "Again", undefined, { guidance: guidance(4), failure: { kind: "lost", detail: "" } })).toMatchObject({ ok: false });
    expect(() => running.tickets.change((writes) => writes.startRound(ticket.id, { failure: { kind: "program", detail: "" }, guidance: guidance(4), attempt: 99 }))).toThrow();
    running.work?.reassign(current(running, ticket.id));
    expect((await post(running, `/api/tickets/${ticket.id}/reassign`, { machine: "pc" })).status).toBe(409);
    expect(starts(sent, ticket.id)).toHaveLength(attempts);
    expect(current(running, ticket.id)).toMatchObject({ state: "stuck", round: 3 });
  });

  it("refuses a fourth round even on a ticket the cap has not stopped", async () => {
    const { running, runner, conversation } = await start();
    const ticket = begin(running, conversation, 9);
    running.database.connection.prepare("UPDATE tickets SET round = 3 WHERE id = ?").run(ticket.id);
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    running.tickets.change((writes) => writes.touched(ticket.id));
    const failure = { kind: "program" as const, detail: "boom" };
    running.database.connection.prepare("UPDATE ticket_attempts SET state = 'failed', failure = 'program', reason = 'boom' WHERE ticket_id = ?").run(ticket.id);
    const answer = await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: guidance(4) }, conversation);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("the cap");
    expect(running.work?.again(ticket.id, "Again", undefined, { guidance: guidance(4), failure })).toMatchObject({ ok: false });
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 3, work: { attempt: 1 } });
  });

  it("resumes on the owner's answer only, with the count back at zero", async () => {
    const started = await start();
    const { running, sent, conversation } = started;
    const ticket = await failThreeRounds(started, 10);
    const at = ticket.stuck?.at ?? 0;
    const path = `/api/tickets/${ticket.id}/answer`;
    expect((await post(running, path, { at, answer: "resume" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post(running, path, { at, answer: "resume" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(running, path, { at, answer: "resume" }, {}, "someone@example.com")).status).toBe(403);
    expect((await fetch(`${base(running)}${path}`, { method: "POST", body: JSON.stringify({ at, answer: "resume" }), headers: { "content-type": "application/json", origin: base(running) } })).status).toBe(403);
    expect((await post(running, path, { at, answer: "again" })).status).toBe(400);
    expect((await post(running, path, { at: at - 1, answer: "resume" })).status).toBe(409);
    expect((await post(running, "/api/tickets/999/answer", { at, answer: "resume" })).status).toBe(404);
    expect(current(running, ticket.id)).toMatchObject({ state: "stuck", round: 3 });

    const answered = await post(running, path, { at, answer: "resume", words: "试试把文件名改成 greeting.ts" });
    expect(answered.status).toBe(202);
    expect(TicketResponse.parse(await answered.json()).ticket).toMatchObject({ state: "working", round: 0, freeRetry: false, stuck: null });
    expect((await post(running, path, { at, answer: "resume" })).status).toBe(409);
    expect(running.waiting.cards().some((card) => card.kind === "stuck")).toBe(false);
    const told = notices(running, conversation).at(-1);
    expect(told?.text).toBe(`你让工单 ${ticket.id} 继续，引导重新计数：试试把文件名改成 greeting.ts`);
    expect(told?.prompt).toContain("The owner's words to you: 试试把文件名改成 greeting.ts");
    expect(told?.prompt).toContain("guide_ticket");
    expect(starts(sent, ticket.id)).toHaveLength(4);
    const guided = await callBrainTool(running, "guide_ticket", { ticket: ticket.id, guidance: { en: "Rename the file to greeting.ts as the owner says.", zh: "按你说的把文件改名为 greeting.ts。" } }, conversation);
    expect(guided.text).toContain("guided round 1 of 3");
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 1, work: { attempt: 5 } });
    expect(running.tickets.moves(ticket.id).map((move) => [move.from, move.to])).toContainEqual(["stuck", "working"]);
  });

  it("ends the ticket when the owner gives it up, destroys nothing, and opens its repair", async () => {
    const started = await start();
    const { running, sent, conversation } = started;
    const ticket = await failThreeRounds(started, 11);
    const answered = await post(running, `/api/tickets/${ticket.id}/answer`, { at: ticket.stuck?.at ?? 0, answer: "give-up" });
    expect(answered.status).toBe(202);
    const ended = current(running, ticket.id);
    expect(ended).toMatchObject({ state: "stopped", stopReason: { zh: "引导到上限后，你放弃了它" } });
    const repair = current(running, ended.repairedBy ?? 0);
    expect(repair).toMatchObject({ state: "pending", repairs: ticket.id, branch: ticket.branch });
    expect(sent.filter((message) => message.type === "work.stop")).toEqual([{ type: "work.stop", ticket: ticket.id, save: true, remove: false }]);
    expect(notices(running, conversation).at(-1)?.text).toBe(`你放弃了工单 ${ticket.id}，已开补救工单 ${repair.id}，等你开始`);
  });
});
