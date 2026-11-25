import { ticketReference } from "@super-agent2/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type HubToRunner, type MachineReport, protocolVersion, startingEngineTable, type Ticket, WaitingList, type WorkEvent } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import type { Hub } from "./hub.js";
import type { RunnerLink } from "./runners.js";
import { chainChoicePath, chainStartPath } from "./server.js";
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

const seqs = new Map<string, number>();

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-pieces-api-"));
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

async function start(programs: MachineReport["programs"] = [], forgeFetch = forge.fetch): Promise<Started> {
  const running = await startTestHub({
    config: testConfig(dataDir),
    keySource: staticKeySource(keySet(key)),
    clock,
    credentials,
    forgeFetch,
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
  runner.receive({ type: "hello", protocol: protocolVersion, machine: { ...report, programs }, works: [] });
  forge.woodpecker.set(repository, { id: 6, active: true, configFile: "", pipelines: [] });
  return { running, runner, sent, conversation: running.conversations.create().id };
}

const chainIssues = [7, 8, 9] as const;

function begin(running: Hub, conversation: string, pinned = false): Ticket {
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
    conversation,
  });
  running.tickets.change((writes) => {
    if (pinned) writes.pins(opened.id, { machine: "pc", ownerEngine: "claude", platform: "windows", kind: "feature" });
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

function event(runner: RunnerLink, ticket: number, attempt: number, body: WorkEvent): void {
  const key = `${ticket}:${attempt}`;
  const seq = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, seq);
  runner.receive({ type: "work.event", ticket, attempt, seq, at: clock.now(), event: body });
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
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
  forge.logs.set(step, state === "failure" ? ["FAIL src/steps.test.ts"] : []);
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

function closeOutside(number: number, reason: string, comment?: string): void {
  const repo = forge.repository(repository);
  const at = "2026-11-17T11:59:59Z";
  const user = { login: "novan-xu" };
  repo.issues.set(number, "closed");
  repo.issueClosures.set(number, {
    reason,
    at,
    timeline: [
      ...(comment === undefined ? [] : [{ event: "commented", created_at: "2026-11-17T11:59:57Z", user, body: comment }]),
      { event: "closed", created_at: at, actor: user },
      { event: "commented", created_at: at, user: { login: "someone-else" }, body: "Unrelated comment" },
    ],
  });
}

async function settled(running: Hub): Promise<void> {
  await running.verification.idle();
  await running.chains.idle();
}

describe("follow-ups of merged code tickets", () => {
  const programs: MachineReport["programs"] = (["claude", "codex"] as const).map((id) => ({
    id, installed: true, path: id, version: "1", source: "program", problem: null,
    models: [
      startingEngineTable[id].standard,
      ...(id === "claude" ? [{ model: "claude-haiku-5-5", effort: "low" }] : []),
    ].map(({ model, effort }) => ({ id: model, efforts: [effort] })),
  }));

  async function ownerCall(running: Hub, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base(running)}${path}`, {
      headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json", origin: base(running) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  }

  async function startFollowUp(running: Hub, id: number, engine: "claude" | "codex", machine = "pc"): Promise<void> {
    const cards = WaitingList.parse(await (await ownerCall(running, "/api/waiting")).json()).cards;
    const card = cards.find((item) => item.kind === "start" && item.ticket.id === id);
    if (card?.kind !== "start") throw new Error("No follow-up card");
    expect(card.choice).toMatchObject({ machine, engine, missing: [] });
    expect((await ownerCall(running, chainStartPath, { chains: [{ ticket: id, fingerprint: card.fingerprint }] })).status).toBe(202);
    await settled(running);
  }

  async function merge(running: Hub, runner: RunnerLink, ticket: Ticket, pull: number, closes: readonly number[]): Promise<Ticket> {
    const branch = current(running, ticket.id).branch ?? "";
    const head = pull.toString(16).padStart(40, "0");
    forge.pull(repository, pull, head, ["README.md"], branch, closes);
    handIn(runner, ticket.id, 1, pull, closes);
    await settled(running);
    const merged = current(running, ticket.id);
    expect(merged.state).toBe("merged");
    return merged;
  }

  it("records and reopens original issues, starts only by the owner, and uses the newest session for repeated adjustments", async () => {
    const { running, runner, sent, conversation } = await start(programs);
    const original = begin(running, conversation);
    const topic = running.conversations.create().id;
    const request = { ticket: ticketReference(original), issue: 7, comment: "Reduce the heading size." };
    expect(await callBrainTool(running, "follow_up_ticket", request, topic)).toMatchObject({ isError: true, text: expect.stringContaining("require a merged code ticket") });
    event(runner, original.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, original.id, 1, { kind: "session", session: "original-claude" });
    const merged = await merge(running, runner, original, 70, chainIssues);
    expect(await callBrainTool(running, "follow_up_ticket", { ...request, issue: 99 }, topic)).toMatchObject({ isError: true, text: expect.stringContaining("was not in ticket") });

    const opened = await callBrainTool(running, "follow_up_ticket", request, topic);
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain("/issues/7#issuecomment-1");
    const [first] = running.tickets.list({ open: true });
    if (first === undefined) throw new Error("No follow-up");
    expect(first).toMatchObject({ state: "pending", followUpOf: ticketReference(original), conversation: topic, issues: [{ number: 7 }] });
    const repo = forge.repository(repository);
    expect(repo.issues.get(7)).toBe("open");
    expect(repo.issueComments.get(7)).toEqual([{ body: expect.stringContaining("Follow-up from Super Agent"), html_url: expect.stringContaining("#issuecomment-1") }]);
    expect(starts(sent, first.id)).toEqual([]);
    expect(await callBrainTool(running, "follow_up_ticket", request, topic)).toEqual(opened);
    expect(await callBrainTool(running, "follow_up_ticket", { ...request, issue: 8 }, topic)).toMatchObject({ isError: true, text: expect.stringContaining("open follow-up") });
    await startFollowUp(running, first.id, "claude");
    expect(starts(sent, first.id)[0]?.task).toMatchObject({
      session: "original-claude", folder: original.id, note: expect.stringContaining(request.comment),
      followUp: { workspaceOf: original.id, fromCommit: merged.pullRequests[0]?.mergeCommit, resumeOriginal: true },
    });
    expect(current(running, first.id).branch).not.toBe(merged.branch);
    event(runner, first.id, 1, { kind: "follow-up", outcome: "resumed" });
    await merge(running, runner, first, 71, [7]);
    expect(repo.issues.get(7)).toBe("closed");
    expect(notices(running, topic).at(-1)?.prompt).toContain("The worker resumed the original session.");

    expect((await callBrainTool(running, "follow_up_ticket", { ...request, issue: 8, comment: "Adjust the spacing." }, topic)).isError).toBe(false);
    const [second] = running.tickets.list({ open: true });
    if (second === undefined) throw new Error("No second follow-up");
    expect((await ownerCall(running, chainChoicePath, { ticket: second.id, engine: "codex" })).status).toBe(202);
    await startFollowUp(running, second.id, "codex");
    expect(starts(sent, second.id)[0]?.task).toMatchObject({
      session: null, folder: original.id, takeover: true,
      followUp: { resumeOriginal: false, workspaceOf: first.id, takeoverNote: expect.stringContaining("Adjust the spacing.") },
    });
    expect(starts(sent, second.id)[0]?.task.followUp?.takeoverNote).toContain("#70");
    event(runner, second.id, 1, { kind: "follow-up", outcome: "takeover" });
    event(runner, second.id, 1, { kind: "session", session: "new-codex" });
    await merge(running, runner, second, 72, [8]);
    expect(notices(running, topic).at(-1)?.prompt).toContain("A takeover worker completed the adjustment.");
    expect((await callBrainTool(running, "follow_up_ticket", { ...request, issue: 9 }, topic)).isError).toBe(false);
    const [third] = running.tickets.list({ open: true });
    if (third === undefined) throw new Error("No third follow-up");
    await startFollowUp(running, third.id, "codex");
    expect(starts(sent, third.id)[0]?.task).toMatchObject({
      session: "new-codex", folder: original.id, followUp: { workspaceOf: second.id, resumeOriginal: true },
    });
  });

  it("keeps explicit assignment on a follow-up when the original runner is offline", async () => {
    const { running, runner, conversation } = await start(programs);
    const original = begin(running, conversation, true);
    await merge(running, runner, original, 70, chainIssues);
    runner.closed();
    const request = { ticket: ticketReference(original), issue: 7, comment: "Adjust the heading." };
    const opened = await callBrainTool(running, "follow_up_ticket", request, conversation);
    expect(opened.isError, opened.text).toBe(false);
    const [followUp] = running.tickets.list({ open: true });
    expect(followUp).toMatchObject({ requiredMachine: "pc", machinePinned: true, enginePin: "claude" });
    const card = running.chains.cards().find((card) => card.ticket.id === followUp?.id);
    expect(card?.choice).toMatchObject({ machine: "pc", engine: "claude", missing: ["machine"] });
  });

  it("reuses the comment if the response was lost before the issue could be reopened", async () => {
    let lost = true;
    const forgeFetch: typeof fetch = async (input, init) => {
      const response = await forge.fetch(input, init);
      if (lost && init?.method === "POST" && String(input).endsWith("/issues/7/comments")) {
        lost = false;
        throw new Error("Lost the comment response");
      }
      return response;
    };
    const { running, runner, conversation } = await start(programs, forgeFetch);
    const original = begin(running, conversation);
    await merge(running, runner, original, 70, chainIssues);
    const request = { ticket: ticketReference(original), issue: 7, comment: "Keep this request once." };
    expect((await callBrainTool(running, "follow_up_ticket", request, conversation)).isError).toBe(true);
    expect(running.tickets.list({ open: true })).toEqual([]);
    expect(forge.repository(repository).issues.get(7)).toBe("closed");
    expect((await callBrainTool(running, "follow_up_ticket", request, conversation)).isError).toBe(false);
    expect(forge.repository(repository).issues.get(7)).toBe("open");
    expect(forge.repository(repository).issueComments.get(7)).toHaveLength(1);
  });

  it("starts a takeover on a machine that can work when the original machine is offline", async () => {
    const { running, runner, conversation } = await start(programs);
    const original = begin(running, conversation);
    event(runner, original.id, 1, { kind: "session", session: "original-claude" });
    await merge(running, runner, original, 70, chainIssues);
    runner.closed();
    running.machines.add({ name: "spare", accessClientId: "spare.access" });
    const machine = running.machines.get("spare");
    if (machine === undefined) throw new Error("Spare machine missing");
    const sent: HubToRunner[] = [];
    const spare = running.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
    spare.receive({ type: "hello", protocol: protocolVersion, machine: { ...report, hostname: "spare", programs: programs.filter(({ id }) => id === "codex") }, works: [] });
    const request = { ticket: ticketReference(original), issue: 7, comment: "Adjust the heading." };
    expect((await callBrainTool(running, "follow_up_ticket", request, conversation)).isError).toBe(false);
    const [followUp] = running.tickets.list({ open: true });
    if (followUp === undefined) throw new Error("No follow-up");
    await startFollowUp(running, followUp.id, "codex", "spare");
    expect(starts(sent, followUp.id)[0]?.task).toMatchObject({ session: null, takeover: true, followUp: { resumeOriginal: false } });
    expect(starts(sent, followUp.id)[0]?.task.followUp?.workspaceOf).toBeUndefined();

    expect((await callBrainTool(running, "stop_ticket", { ticket: ticketReference(followUp), reason: original.summary }, conversation)).isError).toBe(false);
    expect((await callBrainTool(running, "follow_up_ticket", { ...request, issue: 8 }, conversation)).isError).toBe(false);
    expect(await callBrainTool(running, "open_repair_ticket", { ticket: ticketReference(followUp) }, conversation)).toMatchObject({
      isError: true, text: expect.stringContaining("Wait for open follow-up ticket"),
    });
  });
});

describe("a chain handed in as several pull requests", () => {
  it("merges each pull request as it is handed in, continues the same worker after each merge, and is merged when every issue is closed", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    const first = current(running, ticket.id).branch ?? "";
    expect(first).toMatch(/^sa2\/[a-z]{2}-2026-11-17-[0-9a-f]{4}$/);
    expect(starts(sent, ticket.id)[0]?.task).toMatchObject({ attempt: 1, branch: first, merged: [] });

    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, 1, { kind: "session", session: "session-1" });
    pullAt(21, "aaa111", first, [7, 8]);
    pipeline(1, "aaa111", 21, "failure");
    handIn(runner, ticket.id, 1, 21, [7, 8]);
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "verifying", pullRequest: 21, verification: { state: "failed" } });
    const guided = await callBrainTool(running, "guide_ticket", { ticket: ticket.code, guidance: { en: "Fix the failing step test.", zh: "修好失败的步骤测试。" } }, conversation);
    expect(guided.isError, guided.text).toBe(false);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", round: 1, work: { attempt: 2 } });

    event(runner, ticket.id, 2, { kind: "phase", phase: "resumed", detail: "Resumed" });
    pullAt(21, "bbb222", first, [7, 8]);
    pipeline(2, "bbb222", 21, "success");
    handIn(runner, ticket.id, 2, 21, [7, 8]);
    await settled(running);

    const continued = current(running, ticket.id);
    const second = continued.branch ?? "";
    expect(continued).toMatchObject({ state: "working", round: 0, freeRetry: false, pullRequest: 21, verification: null, work: { attempt: 3 } });
    expect(second).not.toBe(first);
    expect(second).toMatch(/^sa2\/[a-z]{2}-2026-11-17-[0-9a-f]{4}$/);
    expect(continued.pullRequests).toEqual([
      expect.objectContaining({ number: 21, branch: first, state: "merged", closes: [7, 8], mergeCommit: "merge-of-bbb222" }),
    ]);
    expect(forge.merges).toEqual([{ repository, number: 21, sha: "bbb222", method: "squash" }]);
    expect([...forge.repository(repository).issues]).toEqual([
      [7, "closed"],
      [8, "closed"],
      [9, "open"],
    ]);
    expect(forge.repository(repository).branches.has(first)).toBe(false);
    const third = starts(sent, ticket.id)[2]?.task;
    expect(third).toMatchObject({ attempt: 3, branch: second, merged: [7, 8], session: "session-1" });
    expect(third?.note).toContain("Pull request #21 is merged into main as commit merge-of-bbb222. It closed #7, #8.");
    expect(third?.note).toContain("- #9 Step 9");
    expect(third?.note).toContain(`Your folder is now on a new branch, ${second}, made from the updated main`);
    expect(notices(running, conversation).map((entry) => entry.text)).toEqual([`工单 ${ticket.code.toUpperCase()} 没有通过验证，大脑会决定怎么处理`]);
    const moves = running.tickets.moves(ticket.id).map((move) => [move.from, move.to, move.reason?.zh ?? null]);
    expect(moves).toContainEqual(["verifying", "working", "PR #21 已合并，接着做 #9"]);

    event(runner, ticket.id, 3, { kind: "phase", phase: "resumed", detail: "Resumed" });
    pullAt(22, "ccc333", second, [9]);
    pipeline(3, "ccc333", 22, "success");
    handIn(runner, ticket.id, 3, 22, [9]);
    await settled(running);

    const merged = current(running, ticket.id);
    expect(merged).toMatchObject({ state: "merged", round: 0, pullRequest: 22 });
    expect(merged.pullRequests.map((pull) => [pull.number, pull.branch, pull.state, pull.closes])).toEqual([
      [21, first, "merged", [7, 8]],
      [22, second, "merged", [9]],
    ]);
    expect(forge.merges.map((merge) => merge.number)).toEqual([21, 22]);
    expect(forge.repository(repository).issues.get(9)).toBe("closed");
    const told = notices(running, conversation);
    expect(told.map((entry) => entry.text)).toEqual([`工单 ${ticket.code.toUpperCase()} 没有通过验证，大脑会决定怎么处理`, `工单 ${ticket.code.toUpperCase()} 已合并`]);
    expect(told.at(-1)?.prompt).toContain("Pull requests merged in novan-xu/super-agent-sandbox, in order: #21 (closed #7, #8, commit merge-of-bbb222); #22 (closed #9, commit merge-of-ccc333).");
    expect(told.at(-1)?.prompt).toContain("That is the final merge commit");

    const read = await callBrainTool(running, "read_ticket", { ticket: ticket.code }, conversation);
    expect(read.text).toContain("#7 merged, #8 merged, #9 merged; pull requests #21 merged, #22 merged");
    expect(read.text).toContain(`#22 merged from ${second}`);
  });

  it("continues with every issue still open when a merged pull request closed none of them", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    const branch = current(running, ticket.id).branch ?? "";
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    pullAt(31, "ddd444", branch, []);
    pipeline(1, "ddd444", 31, "success");
    handIn(runner, ticket.id, 1, 31, [7]);
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", pullRequests: [expect.objectContaining({ number: 31, state: "merged", closes: [] })] });
    const note = starts(sent, ticket.id)[1]?.task.note ?? "";
    expect(note).toContain("It closed no issue of the chain.");
    expect(note).toContain("Closed so far: none.");
    expect([...forge.repository(repository).issues.values()]).toEqual(["open", "open", "open"]);
  });

  it("ends after the second merge when the third issue was dropped before it merged", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    pullAt(21, "aaa111", ticket.branch ?? "", [7]);
    pipeline(1, "aaa111", 21, "success");
    handIn(runner, ticket.id, 1, 21, [7]);
    await settled(running);
    const second = current(running, ticket.id);
    pullAt(22, "bbb222", second.branch ?? "", [8, 9]);
    handIn(runner, ticket.id, 2, 22, [8, 9]);
    await settled(running);
    expect(current(running, ticket.id).state).toBe("verifying");

    closeOutside(9, "not_planned", "We dropped the final step.");
    pipeline(2, "bbb222", 22, "success");
    await running.verification.check(ticket.id);
    await settled(running);

    expect(current(running, ticket.id)).toMatchObject({
      state: "merged",
      closedOutside: [{ number: 9, stateReason: "NOT_PLANNED", comment: "We dropped the final step." }],
      pullRequests: [{ number: 21, closes: [7] }, { number: 22, closes: [8] }],
      verification: { mergeCommit: "merge-of-bbb222" },
    });
    expect(starts(sent, ticket.id)).toHaveLength(2);
    expect(notices(running, conversation).at(-1)?.prompt).toContain('Issue #9 was closed on GitHub without a pull request of this chain (stateReason: NOT_PLANNED). Closing comment: "We dropped the final step."');
  });

  it("confirms a running worker's settlement on GitHub and preserves the final commit and deployment", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    pullAt(21, "aaa111", ticket.branch ?? "", [7, 8]);
    forge.file(repository, "aaa111", ".superagent2/deployment.json", "{}");
    pipeline(1, "aaa111", 21, "success");
    handIn(runner, ticket.id, 1, 21, [7, 8]);
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", verification: null });
    const deployment = running.tickets.open({
      form: "task",
      repository,
      issues: [],
      title: { en: "Deploy the chain", zh: "部署工单" },
      summary: { en: "Deploy its final commit", zh: "部署最后一次合并的提交" },
      kind: "operation",
      waitsFor: [ticket.id],
      task: { task: "Deploy the final merge commit.", materials: [], commitRef: "merged", deploys: true },
    });
    running.tickets.change((writes) => {
      writes.choose(deployment.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } });
      writes.move(deployment.id, "waiting");
    });

    closeOutside(9, "completed");
    forge.failing = /\/issues\/9$/;
    event(runner, ticket.id, 2, { kind: "settled" });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", work: { state: "finished" } });
    expect(notices(running, conversation)).toHaveLength(0);

    forge.failing = undefined;
    await running.verification.poll();
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({
      state: "merged",
      closedOutside: [{ number: 9, stateReason: "COMPLETED", comment: null }],
      pullRequest: 21,
      verification: { state: "merged", mergeCommit: "merge-of-aaa111", deployment: true },
    });
    expect(starts(sent, ticket.id)).toHaveLength(2);
    const told = notices(running, conversation);
    expect(told).toHaveLength(1);
    expect(told[0]?.prompt).toContain("The last, #21, was merged as commit merge-of-aaa111.");
    expect(told[0]?.prompt).toContain("Issue #9 was closed on GitHub without a pull request of this chain (stateReason: COMPLETED).");
    expect(told[0]?.prompt).toContain(`task ticket ${ticketReference(deployment)} deploys it`);
    expect(current(running, deployment.id)).toMatchObject({ state: "working", commit: "merge-of-aaa111" });
  });

  it("settles an otherwise finished chain when its last handed-in pull request was abandoned", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    pullAt(21, "aaa111", ticket.branch ?? "", [7]);
    pipeline(1, "aaa111", 21, "success");
    handIn(runner, ticket.id, 1, 21, [7]);
    await settled(running);
    const branch = current(running, ticket.id).branch ?? "";
    const pull = forge.pull(repository, 22, "bbb222", ["src/unneeded.ts"], branch, [8, 9]);
    forge.tree(repository, "bbb222", ["src/unneeded.ts", ".woodpecker/check.yaml"]);
    handIn(runner, ticket.id, 2, 22, [8, 9]);
    await settled(running);
    expect(current(running, ticket.id).state).toBe("verifying");

    pull.open = false;
    closeOutside(8, "not_planned");
    closeOutside(9, "not_planned");
    await running.verification.check(ticket.id);
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({
      state: "merged",
      pullRequest: 21,
      pullRequests: [{ number: 21, state: "merged" }, { number: 22, state: "closed" }],
      verification: { state: "merged", mergeCommit: "merge-of-aaa111" },
    });
    expect(starts(sent, ticket.id)).toHaveLength(2);
    expect(forge.merges.map((merge) => merge.number)).toEqual([21]);
  });

  it("retries the same branch when an issue reopens before settlement is confirmed", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    closeOutside(7, "not_planned");
    closeOutside(8, "not_planned");
    event(runner, ticket.id, 1, { kind: "settled" });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", work: { attempt: 2 }, closedOutside: [{ number: 7 }, { number: 8 }] });
    expect(starts(sent, ticket.id)[1]?.task).toMatchObject({ branch: ticket.branch, closedOutside: [7, 8], note: expect.stringContaining("#9") });

    forge.repository(repository).issues.set(7, "open");
    closeOutside(9, "not_planned");
    event(runner, ticket.id, 2, { kind: "settled" });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", work: { attempt: 3 }, closedOutside: [{ number: 8 }, { number: 9 }] });
    expect(starts(sent, ticket.id)[2]?.task.note).toContain("#7");
  });

  it("stops and reports a chain dropped without any merged pull request", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    chainIssues.forEach((number) => closeOutside(number, "not_planned"));
    event(runner, ticket.id, 1, { kind: "settled" });
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({
      state: "stopped",
      stopReason: { en: "Every issue was closed on GitHub without a pull request" },
      closedOutside: [{ number: 7 }, { number: 8 }, { number: 9 }],
    });
    expect(starts(sent, ticket.id)).toHaveLength(1);
    expect(notices(running, conversation)[0]?.prompt).toContain("Every issue was closed on GitHub without a pull request.");
  });

  it("keeps what is merged when the owner stops the chain, records what remains, and tells the brain once", async () => {
    const { running, runner, conversation } = await start();
    const ticket = begin(running, conversation);
    const first = current(running, ticket.id).branch ?? "";
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    pullAt(41, "eee555", first, [7]);
    forge.file(repository, "eee555", ".superagent2/deployment.json", "{}");
    pipeline(1, "eee555", 41, "success");
    handIn(runner, ticket.id, 1, 41, [7]);
    await settled(running);
    const second = current(running, ticket.id).branch ?? "";
    event(runner, ticket.id, 2, { kind: "phase", phase: "resumed", detail: "Resumed" });
    pullAt(42, "fff666", second, [8]);
    handIn(runner, ticket.id, 2, 42, [8]);
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "verifying", verification: { state: "waiting", waiting: "pipeline" } });

    const response = await fetch(`${base(running)}/api/tickets/${ticket.id}/stop`, {
      method: "POST",
      body: "{}",
      headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock, claims: personClaims() }), "content-type": "application/json", origin: base(running) },
    });
    expect(response.status).toBe(202);
    const stopped = current(running, ticket.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.pullRequests.map((pull) => [pull.number, pull.state, pull.closes])).toEqual([
      [41, "merged", [7]],
      [42, "open", [8]],
    ]);
    expect(forge.repository(repository).issues.get(7)).toBe("closed");
    const told = notices(running, conversation);
    expect(told.map((entry) => entry.text)).toEqual([`你停止了工单 ${ticket.code.toUpperCase()}，已合并的部分保留`]);
    expect(told[0]?.prompt).toContain("Pull requests merged, in order: #41 (closed #7, commit merge-of-eee555).");
    expect(told[0]?.prompt).toContain(`Still open: #8, #9; open pull request: #42 from ${second}.`);
    expect(told[0]?.prompt).toContain("the repository has a deployment");
  });
});

describe("a message for a chain's worker between two pieces", () => {
  it("is kept while the ticket waits on verification and reaches the next attempt, with its attachment, once", async () => {
    const { running, runner, sent, conversation } = await start();
    const ticket = begin(running, conversation);
    const branch = current(running, ticket.id).branch ?? "";
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    pullAt(41, "eee555", branch, [7]);
    pipeline(1, "eee555", 41, "failure");
    handIn(runner, ticket.id, 1, 41, [7]);
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "verifying" });

    const upload = running.attachments.create({ name: "screenshot.png", size: 3, mediaType: "image/png" });
    await running.attachments.write(upload.attachment.id, 0, Readable.from([Buffer.from([1, 2, 3])]));
    const work = running.work;
    if (work === undefined) {
      throw new Error("no work service");
    }
    const kept = work.message(ticket.id, "Look at this too", "owner", [upload.attachment]);
    expect(kept).toMatchObject({ ok: true, delivered: false });
    const id = kept.ok ? kept.id : "";
    expect(sent.filter((message) => message.type === "work.message")).toEqual([]);

    const guided = await callBrainTool(running, "guide_ticket", { ticket: ticket.code, guidance: { en: "Fix the failing test.", zh: "修好失败的测试。" } }, conversation);
    expect(guided.isError, guided.text).toBe(false);
    const after = sent.findIndex((message) => message.type === "work.start" && message.task.attempt === 2);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(sent.slice(after).filter((message) => message.type === "work.message")).toEqual([
      { type: "work.message", ticket: ticket.id, attempt: 2, id, from: "owner", text: "Look at this too", attachments: [upload.attachment] },
    ]);

    const part = new Promise<HubToRunner>((resolve) => {
      const before = sent.length;
      runner.receive({ type: "work.attachment", ticket: ticket.id, attempt: 2, attachment: upload.attachment.id, offset: 0, length: 3 });
      const check = () => {
        const found = sent.slice(before).find((message) => message.type === "work.attachment.part");
        if (found === undefined) {
          setImmediate(check);
        } else {
          resolve(found);
        }
      };
      check();
    });
    expect(await part).toMatchObject({ data: Buffer.from([1, 2, 3]).toString("base64"), problem: null });

    event(runner, ticket.id, 2, { kind: "message", id, from: "owner", text: "Look at this too", attachments: [upload.attachment], delivery: "steered" });
    pullAt(41, "fff666", branch, [7]);
    pipeline(2, "fff666", 41, "success");
    handIn(runner, ticket.id, 2, 41, [7]);
    await settled(running);
    expect(current(running, ticket.id)).toMatchObject({ state: "working", work: { attempt: 3 } });
    const third = sent.findIndex((message) => message.type === "work.start" && message.task.attempt === 3);
    expect(third).toBeGreaterThanOrEqual(0);
    expect(sent.slice(third).filter((message) => message.type === "work.message")).toEqual([]);
  });
});
