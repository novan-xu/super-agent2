import { ticketReference } from "@super-agent2/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Decision, type MachineReport, protocolVersion, type Ticket, type WorkEvent } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import type { Hub } from "./hub.js";
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

const seqs = new Map<string, number>();

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-decisions-api-"));
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
  const runner = running.runners.attach(machine, { send: () => undefined, close: () => undefined });
  runner.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
  forge.woodpecker.set(repository, { id: 6, active: true, configFile: "", pipelines: [] });
  return { running, runner, conversation: running.conversations.create().id };
}

function decision(name: string): Decision {
  return {
    chosen: { en: `Chose ${name}`, zh: `选了${name}` },
    why: { en: `Because of ${name}`, zh: `因为${name}` },
    otherOptions: { en: `Not ${name}`, zh: `不选${name}` },
  };
}

function current(running: Hub, id: number): Ticket {
  const ticket = running.tickets.get(id);
  if (ticket === undefined) {
    throw new Error(`ticket ${id} missing`);
  }
  return ticket;
}

function working(running: Hub, ticket: Ticket): Ticket {
  running.tickets.change((writes) => {
    writes.choose(ticket.id, { machine: "pc", engine: "claude", model: "claude-haiku-5-5", effort: "low", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } });
    writes.move(ticket.id, "working");
  });
  const moved = current(running, ticket.id);
  if (running.work === undefined) {
    throw new Error("no work service");
  }
  running.work.begin(moved);
  return current(running, ticket.id);
}

function chain(running: Hub, conversation: string): Ticket {
  for (const issue of [7, 8]) {
    forge.repository(repository).issues.set(issue, "open");
  }
  return working(
    running,
    running.tickets.open({
      repository,
      issues: [7, 8].map((number) => ({
        repository,
        number,
        url: `https://github.com/${repository}/issues/${number}`,
        title: { en: `Step ${number}`, zh: `第 ${number} 步` },
        summary: { en: `Do step ${number}`, zh: `做第 ${number} 步` },
      })),
      title: { en: "Two steps", zh: "两步" },
      summary: { en: "Two steps in order", zh: "按顺序做两步" },
      kind: "feature",
      conversation,
    }),
  );
}

function task(running: Hub, conversation: string): Ticket {
  return working(
    running,
    running.tickets.open({
      repository: null,
      issues: [],
      title: { en: "A letter", zh: "一封信" },
      summary: { en: "Write a letter", zh: "写一封信" },
      kind: "writing",
      task: { task: "Write a short letter.", materials: [] },
      conversation,
    }),
  );
}

function event(runner: RunnerLink, ticket: number, attempt: number, body: WorkEvent): void {
  const id = `${ticket}:${attempt}`;
  const seq = (seqs.get(id) ?? 0) + 1;
  seqs.set(id, seq);
  runner.receive({ type: "work.event", ticket, attempt, seq, at: clock.now(), event: body });
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function review(running: Hub, ticket: number, id: number, body: unknown, options: { readonly origin?: string; readonly owner?: boolean } = {}): Promise<Response> {
  return fetch(`${base(running)}/api/tickets/${ticket}/decisions/${id}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Cf-Access-Jwt-Assertion": await assertion({ key, clock, claims: options.owner === false ? personClaims("someone@example.com") : personClaims() }),
      "content-type": "application/json",
      origin: options.origin ?? base(running),
    },
  });
}

const EntryRow = z.object({ body: z.string(), prompt: z.string().nullable() });

function entries(running: Hub, conversation: string, kind: "notice" | "delivery"): { readonly body: string; readonly prompt: string }[] {
  return running.database.connection
    .prepare("SELECT body, prompt FROM conversation_entries WHERE conversation_id = ? AND kind = ? ORDER BY seq")
    .all(conversation, kind)
    .map((row) => {
      const value = EntryRow.parse(row);
      return { body: value.body, prompt: value.prompt ?? "" };
    });
}

function notices(running: Hub, conversation: string): { readonly text: string; readonly prompt: string }[] {
  return entries(running, conversation, "notice").map((entry) => ({ text: z.object({ text: z.string() }).parse(JSON.parse(entry.body)).text, prompt: entry.prompt }));
}

async function settled(running: Hub): Promise<void> {
  await running.verification.idle();
  await running.chains.idle();
}

function pipeline(number: number, commit: string, pull: number): void {
  const found = forge.woodpecker.get(repository);
  if (found === undefined) {
    throw new Error("no Woodpecker repository");
  }
  found.pipelines.push({
    number,
    commit,
    ref: `refs/pull/${pull}/merge`,
    event: "pull_request",
    status: "success",
    workflows: [{ name: "check", state: "success", steps: [{ id: 900 + number, name: "test", state: "success", exitCode: 0 }] }],
    config: ["check"],
  });
}

function handIn(runner: RunnerLink, ticket: number, attempt: number, pull: number, head: string, branch: string, closes: readonly number[], decisions: readonly Decision[]): void {
  forge.pull(repository, pull, head, ["src/steps.ts"], branch, closes);
  forge.tree(repository, head, ["src/steps.ts", ".woodpecker/check.yaml"]);
  pipeline(pull, head, pull);
  event(runner, ticket, attempt, {
    kind: "finished",
    pullRequest: pull,
    url: `https://github.com/${repository}/pull/${pull}`,
    closes: [...closes],
    report: { en: `Pull request ${pull}`, zh: `交了 PR ${pull}` },
    ...(decisions.length === 0 ? {} : { decisions: [...decisions] }),
  });
}

describe("decisions made on the owner's behalf", () => {
  it("are recorded from the worker's hand-ins and from the brain, and the end report of a merged chain lists every one", async () => {
    const { running, runner, conversation } = await start();
    const ticket = chain(running, conversation);
    const recorded = await callBrainTool(running, "record_decision", { ticket: ticket.code, chosen: decision("one chain").chosen, why: decision("one chain").why, other_options: decision("one chain").otherOptions }, conversation);
    expect(recorded.isError, recorded.text).toBe(false);
    expect(recorded.text).toContain("Chosen: Chose one chain");
    const again = await callBrainTool(running, "record_decision", { ticket: ticket.code, chosen: decision("one chain").chosen, why: decision("one chain").why, other_options: decision("one chain").otherOptions }, conversation);
    expect(again.text).toContain("already has this decision recorded");
    expect((await callBrainTool(running, "record_decision", { ticket: "zz", ...decision("x"), other_options: decision("x").otherOptions })).isError).toBe(true);

    const first = current(running, ticket.id).branch ?? "";
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    handIn(runner, ticket.id, 1, 21, "aaa111", first, [7], [decision("local time")]);
    await settled(running);
    const second = current(running, ticket.id).branch ?? "";
    expect(current(running, ticket.id)).toMatchObject({ state: "working", work: { attempt: 2 } });
    event(runner, ticket.id, 2, { kind: "phase", phase: "resumed", detail: "Resumed" });
    handIn(runner, ticket.id, 2, 22, "bbb222", second, [8], [decision("local time"), decision("a new column")]);
    await settled(running);

    const merged = current(running, ticket.id);
    expect(merged.state).toBe("merged");
    expect(merged.decisions.map((entry) => [entry.source, entry.pullRequest, entry.chosen.en, entry.verdict])).toEqual([
      ["brain", null, "Chose one chain", null],
      ["worker", 21, "Chose local time", null],
      ["worker", 22, "Chose a new column", null],
    ]);
    const told = notices(running, conversation).at(-1);
    expect(told?.text).toBe(`工单 ${ticket.code.toUpperCase()} 已合并`);
    expect(told?.prompt).toContain("Decisions made on the owner's behalf, as recorded for this ticket (3):");
    expect(told?.prompt).toContain("recorded by you, the brain): Chosen: Chose one chain Why: Because of one chain Other options: Not one chain");
    expect(told?.prompt).toContain("recorded by the worker with pull request #22): Chosen: Chose a new column");
    expect(told?.prompt).toContain("Report every one of these decisions to the owner in Chinese");
    expect(running.tickets.reviews()).toEqual([{ ticket: ticket.id, count: 3 }]);

    const read = await callBrainTool(running, "read_ticket", { ticket: ticket.code }, conversation);
    expect(read.text).toContain("Chose a new column");
    expect(read.text).toContain("Not reviewed by the owner yet.");
  });

  it("travel with a task ticket's result, and the end report says when there are none", async () => {
    const { running, runner, conversation } = await start();
    const ticket = task(running, conversation);
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, 1, { kind: "delivered", outcome: "done", text: "Dear neighbours", files: [], report: { en: "Wrote it", zh: "写好了" }, decisions: [decision("a formal tone")] });
    expect(current(running, ticket.id)).toMatchObject({ state: "delivered", decisions: [expect.objectContaining({ source: "worker", attempt: 1, pullRequest: null })] });
    const delivered = entries(running, conversation, "delivery").at(-1)?.prompt ?? "";
    expect(delivered).toContain("Chosen: Chose a formal tone");
    expect(delivered).toContain("Report every one of these decisions");

    const other = task(running, conversation);
    event(runner, other.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, other.id, 1, { kind: "delivered", outcome: "done", text: "Thanks", files: [], report: { en: "Wrote it", zh: "写好了" } });
    expect(entries(running, conversation, "delivery").at(-1)?.prompt).toContain("Decisions made on the owner's behalf: none is recorded for this ticket.");
  });

  it("are listed when the owner stops a ticket, even with nothing merged", async () => {
    const { running, conversation } = await start();
    const ticket = chain(running, conversation);
    await callBrainTool(running, "record_decision", { ticket: ticket.code, chosen: decision("a cut").chosen, why: decision("a cut").why, other_options: decision("a cut").otherOptions }, conversation);
    const response = await fetch(`${base(running)}/api/tickets/${ticket.id}/stop`, {
      method: "POST",
      body: "{}",
      headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock, claims: personClaims() }), "content-type": "application/json", origin: base(running) },
    });
    expect(response.status).toBe(202);
    const told = notices(running, conversation);
    expect(told.map((entry) => entry.text)).toEqual([`你停止了工单 ${ticket.code.toUpperCase()}`]);
    expect(told[0]?.prompt).toContain("Chosen: Chose a cut");
  });

  it("are reviewed by the owner one by one, and go to the brain in one message once every one is settled", async () => {
    const { running, conversation } = await start();
    const ticket = chain(running, conversation);
    const ids: number[] = [];
    for (const name of ["one", "two", "three"]) {
      await callBrainTool(running, "record_decision", { ticket: ticket.code, chosen: decision(name).chosen, why: decision(name).why, other_options: decision(name).otherOptions }, conversation);
    }
    ids.push(...current(running, ticket.id).decisions.map((entry) => entry.id));
    const [one, two, three] = ids as [number, number, number];

    expect((await review(running, ticket.id, one, { verdict: "ok" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await review(running, ticket.id, one, { verdict: "ok" }, { owner: false })).status).toBe(403);
    expect((await review(running, ticket.id, one, { verdict: "opinion", opinion: "  " })).status).toBe(400);
    expect((await review(running, ticket.id, 9999, { verdict: "ok" })).status).toBe(404);

    expect((await review(running, ticket.id, one, { verdict: "ok" })).status).toBe(202);
    expect((await review(running, ticket.id, one, { verdict: "ok" })).status).toBe(409);
    const answered = await review(running, ticket.id, two, { verdict: "opinion", opinion: "应该用 UTC" });
    expect(answered.status).toBe(202);
    expect(((await answered.json()) as { ticket: Ticket }).ticket.decisions.map((entry) => entry.verdict)).toEqual(["ok", "opinion", null]);
    expect(notices(running, conversation)).toEqual([]);

    expect((await review(running, ticket.id, three, { verdict: "opinion", opinion: "这个也不对" })).status).toBe(202);
    const told = notices(running, conversation);
    expect(told.map((entry) => entry.text)).toEqual([`你看完了工单 ${ticket.code.toUpperCase()} 的决定，2 条意见交给了大脑`]);
    expect(told[0]?.prompt).toContain(`[hub] The owner went through the decisions recorded on ticket ${ticketReference(ticket)} (Two steps), which is working, and disagrees with 2 of them.`);
    expect(told[0]?.prompt).toContain("Chosen: Chose two");
    expect(told[0]?.prompt).toContain("The owner's opinion: 应该用 UTC");
    expect(told[0]?.prompt).toContain("The owner's opinion: 这个也不对");
    expect(told[0]?.prompt).toContain(`Accepted as they were: decision ${one}.`);
    expect(told[0]?.prompt).toContain("one issue may cover several opinions");
    expect(current(running, ticket.id).decisions.every((entry) => entry.sentAt !== null)).toBe(true);
    expect(current(running, ticket.id).state).toBe("working");

    await callBrainTool(running, "record_decision", { ticket: ticket.code, chosen: decision("four").chosen, why: decision("four").why, other_options: decision("four").otherOptions }, conversation);
    const four = current(running, ticket.id).decisions.at(-1)?.id ?? 0;
    expect((await review(running, ticket.id, four, { verdict: "opinion", opinion: "再想想" })).status).toBe(202);
    const later = notices(running, conversation);
    expect(later).toHaveLength(2);
    expect(later[1]?.prompt).toContain("disagrees with 1 of them");
    expect(later[1]?.prompt).not.toContain("Chose two");
    expect(later[1]?.prompt).not.toContain("Accepted as they were");

    const read = await callBrainTool(running, "read_ticket", { ticket: ticket.code }, conversation);
    expect(read.text).toContain("The owner reviewed it: OK.");
    expect(read.text).toContain("the owner's opinion, in their words: 应该用 UTC");
  });

  it("send nothing to the brain when the owner accepts every one, and are counted only for finished tickets", async () => {
    const { running, conversation } = await start();
    const ticket = chain(running, conversation);
    await callBrainTool(running, "record_decision", { ticket: ticket.code, chosen: decision("one").chosen, why: decision("one").why, other_options: decision("one").otherOptions }, conversation);
    expect(running.tickets.reviews()).toEqual([]);
    running.tickets.stop(ticket.id, { en: "Stopped for the test", zh: "测试停止" });
    expect(running.tickets.reviews()).toEqual([{ ticket: ticket.id, count: 1 }]);
    const id = current(running, ticket.id).decisions[0]?.id ?? 0;
    expect((await review(running, ticket.id, id, { verdict: "ok" })).status).toBe(202);
    expect(notices(running, conversation)).toEqual([]);
    expect(running.tickets.reviews()).toEqual([]);
    expect(current(running, ticket.id).decisions[0]).toMatchObject({ verdict: "ok", opinion: null });
  });
});
