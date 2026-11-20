import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningTurn, type TurnOutcome } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrainLink } from "./conversations.js";
import type { GitHubIssue, HostResult, IssueHost } from "./filing.js";
import type { Hub } from "./hub.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { attachBrain, requestBrainTool, startToolTurn } from "./testing/brain-tools.js";
import { startTestHub } from "./testing/http.js";

const repository = "novan-xu/super-agent-sandbox";
const title = { en: "Fix a bug", zh: "修复问题" };
const rationale = { en: "It is simpler", zh: "做法更简单" };
let dir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-ticket-versions-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(issueHost?: IssueHost): Promise<Hub> {
  hub = await startTestHub({ config: testConfig(dir), clock, keySource: staticKeySource(keySet(key)), ...(issueHost === undefined ? {} : { issueHost }) });
  return hub;
}

function open(running: Hub, number = 1, waitsFor?: readonly number[]): number {
  return running.tickets.open({
    repository,
    kind: "fix",
    title,
    summary: title,
    issues: [{ number, repository, title, summary: title, url: `https://github.com/${repository}/issues/${number}` }],
    ...(waitsFor === undefined ? {} : { waitsFor }),
  }).id;
}

function topic(running: Hub, brain: BrainLink, name: string): RunningTurn {
  const conversation = running.conversations.create();
  running.conversations.send(conversation.id, name);
  return startToolTurn(brain, conversation.id);
}

function read(running: Hub, scope: RunningTurn, ticket: number) {
  return requestBrainTool(running, "read_ticket", { ticket: running.tickets.reference(ticket) }, scope);
}

function record(running: Hub, scope: RunningTurn | undefined, ticket: number, choice: string) {
  return requestBrainTool(running, "record_decision", { ticket: running.tickets.reference(ticket), chosen: { en: choice, zh: "已作选择" }, why: rationale, other_options: rationale }, scope);
}

function end(brain: BrainLink, scope: RunningTurn, outcome: TurnOutcome = "completed"): void {
  brain.receive({ type: "turn.finished", ...scope, outcome, reason: null });
}

function lockedTickets(running: Hub, scope: RunningTurn): unknown[] {
  return running.database.connection.prepare("SELECT ticket_id FROM ticket_locks WHERE turn_id = ? ORDER BY ticket_id").all(scope.turn).map((row) => row["ticket_id"]);
}

async function owner(running: Hub, path: string, body: unknown): Promise<Response> {
  const origin = `http://127.0.0.1:${running.address.port}`;
  return fetch(origin + path, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("topic turn ticket writes", () => {
  it("permits just one concurrent writer and checks versions after release and after owner and hub writes", async () => {
    const running = await start();
    const ticket = open(running);
    const brain = attachBrain(running);
    const first = topic(running, brain, "First topic");
    const second = topic(running, brain, "Second topic");

    expect(await record(running, undefined, ticket, "Unscoped")).toMatchObject({ isError: true, text: expect.stringContaining("active topic turn") });
    expect(await record(running, first, ticket, "No read")).toMatchObject({ isError: true, text: expect.stringContaining("Read ticket") });
    expect(lockedTickets(running, first)).toEqual([]);
    await Promise.all([read(running, first, ticket), read(running, second, ticket)]);
    const results = await Promise.all([record(running, first, ticket, "One"), record(running, second, ticket, "Two")]);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    const [holding, waiting] = results[0]?.isError ? [second, first] : [first, second];
    expect(results.find((result) => result.isError)?.text).toContain(`locked by topic "${holding === first ? "First topic" : "Second topic"}"`);
    expect(lockedTickets(running, holding)).toEqual([ticket]);
    expect(await read(running, waiting, ticket)).toMatchObject({ isError: false });

    const decision = running.tickets.get(ticket)!.decisions[0]!;
    expect((await owner(running, `/api/tickets/${ticket}/decisions/${decision.id}`, { verdict: "ok" })).status).toBe(202);
    expect(running.tickets.get(ticket)?.decisions[0]?.verdict).toBe("ok");
    expect(await record(running, holding, ticket, "After owner edit")).toMatchObject({ isError: true, text: expect.stringContaining("changed since") });
    await read(running, holding, ticket);
    running.database.connection.prepare("UPDATE tickets SET branch = ? WHERE id = ?").run("from-hub", ticket);
    expect(await record(running, holding, ticket, "After hub edit")).toMatchObject({ isError: true, text: expect.stringContaining("changed since") });
    await read(running, holding, ticket);
    expect(await record(running, holding, ticket, "After rereading")).toMatchObject({ isError: false });
    expect(await record(running, holding, ticket, "After own write")).toMatchObject({ isError: false });
    end(brain, holding, "failed");

    expect(lockedTickets(running, holding)).toEqual([]);
    expect(await record(running, waiting, ticket, "Stale after release")).toMatchObject({ isError: true, text: expect.stringContaining("changed since") });
    await read(running, waiting, ticket);
    expect(await record(running, waiting, ticket, "After release and reread")).toMatchObject({ isError: false });
    end(brain, waiting);
    expect(lockedTickets(running, waiting)).toEqual([]);
    expect(running.tickets.get(ticket)?.decisions).toHaveLength(4);
  });

  it("rolls back a repair and every lock when a dependent ticket is locked", async () => {
    const running = await start();
    const original = open(running);
    const follower = open(running, 2, [original]);
    expect(running.tickets.stop(original, rationale).ok).toBe(true);
    const brain = attachBrain(running);
    const first = topic(running, brain, "Repair topic");
    const second = topic(running, brain, "Follower topic");
    await read(running, second, follower);
    expect(await record(running, second, follower, "Keep the dependency")).toMatchObject({ isError: false });
    await Promise.all([read(running, first, original), read(running, first, follower)]);

    const repair = () => requestBrainTool(running, "open_repair_ticket", { ticket: running.tickets.reference(original) }, first);
    expect(await repair()).toMatchObject({ isError: true, text: expect.stringContaining(`Ticket ${running.tickets.reference(follower)} is locked by topic "Follower topic"`) });
    expect(lockedTickets(running, first)).toEqual([]);
    expect(running.tickets.get(original)?.repairedBy).toBeNull();
    expect(running.tickets.get(follower)?.waits[0]?.ticket).toBe(original);
    expect(running.tickets.list()).toHaveLength(2);
    end(brain, second);

    expect(await repair()).toMatchObject({ isError: false });
    const repaired = running.tickets.get(original)?.repairedBy;
    expect(repaired).toBe(3);
    expect(running.tickets.get(follower)?.waits[0]?.ticket).toBe(repaired);
    expect(lockedTickets(running, first)).toEqual([original, follower, repaired]);
  });

  it("revokes an interrupted turn before it finishes and refuses its requests during a later turn of the same topic", async () => {
    const running = await start();
    const ticket = open(running);
    const brain = attachBrain(running);
    const interrupted = topic(running, brain, "Interrupted topic");
    await read(running, interrupted, ticket);
    expect(await record(running, interrupted, ticket, "Before interruption")).toMatchObject({ isError: false });

    expect((await owner(running, `/api/conversations/${interrupted.conversation}/interrupt`, {})).status).toBe(202);
    expect(await record(running, interrupted, ticket, "While interrupting")).toMatchObject({ isError: true, text: expect.stringContaining("no longer active") });
    expect(lockedTickets(running, interrupted)).toEqual([ticket]);
    end(brain, interrupted, "interrupted");
    expect(lockedTickets(running, interrupted)).toEqual([]);

    const current = startToolTurn(brain, interrupted.conversation);
    expect(await record(running, interrupted, ticket, "Late")).toMatchObject({ isError: true, text: expect.stringContaining("no longer active") });
    expect(await record(running, current, ticket, "Next turn")).toMatchObject({ isError: false });
    expect(running.tickets.get(ticket)?.decisions.map((decision) => decision.chosen.en)).toEqual(["Before interruption", "Next turn"]);
  });

  it("keeps locks across a hub restart until the brain identifies which turns survived", async () => {
    const before = await start();
    const ticket = open(before);
    const brain = attachBrain(before);
    const lost = topic(before, brain, "Lost topic");
    await read(before, lost, ticket);
    expect(await record(before, lost, ticket, "Before restart")).toMatchObject({ isError: false });
    await before.close();
    hub = undefined;

    const running = await start();
    expect(lockedTickets(running, lost)).toEqual([ticket]);
    expect(await record(running, lost, ticket, "While disconnected")).toMatchObject({ isError: true, text: expect.stringContaining("no longer active") });
    const survived = attachBrain(running, [lost]);
    expect(await record(running, lost, ticket, "After reconnect")).toMatchObject({ isError: false });
    survived.detach();

    const replacement = attachBrain(running);
    expect(lockedTickets(running, lost)).toEqual([]);
    expect(running.conversations.detail(lost.conversation)?.turns[0]?.state).toBe("interrupted");
    expect(await record(running, lost, ticket, "Former turn")).toMatchObject({ isError: true, text: expect.stringContaining("no longer active") });
    const current = topic(running, replacement, "New topic");
    await read(running, current, ticket);
    expect(await record(running, current, ticket, "After recovery")).toMatchObject({ isError: false });
  });

  it("refuses an in-flight ticket opening if its turn is lost during the GitHub request", async () => {
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<HostResult<GitHubIssue>>();
    const running = await start({
      recent: async () => ({ ok: true, value: [] }),
      create: async () => ({ ok: false, reason: "Unexpected issue creation" }),
      read: () => {
        asked.resolve();
        return answer.promise;
      },
    });
    const brain = attachBrain(running);
    const lost = topic(running, brain, "Lost opening");
    const args = { repository, issue: 1, title_zh: title.zh, summary: title, kind: "fix" };
    const pending = requestBrainTool(running, "open_ticket", args, lost);
    await asked.promise;
    brain.detach();
    const replacement = attachBrain(running);
    answer.resolve({ ok: true, value: { number: 1, title: title.en, body: "", url: `https://github.com/${repository}/issues/1`, open: true, pullRequest: false } });
    expect(await pending).toMatchObject({ isError: true, text: expect.stringContaining("no longer active") });
    expect(running.tickets.list()).toEqual([]);

    const current = startToolTurn(replacement, lost.conversation);
    expect(await requestBrainTool(running, "open_ticket", args, current)).toMatchObject({ isError: false });
    expect(lockedTickets(running, current)).toEqual([1]);
  });

  it("reuses a filed GitHub issue when its original turn ended before the hub could open a ticket", async () => {
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<HostResult<GitHubIssue>>();
    let created = 0;
    const running = await start({
      recent: async () => ({ ok: true, value: [] }),
      create: () => {
        created += 1;
        asked.resolve();
        return answer.promise;
      },
      read: async () => ({ ok: false, reason: "Unexpected issue lookup" }),
    });
    const brain = attachBrain(running);
    const first = topic(running, brain, "Issue filing");
    const args = { repository, title, summary: title, kind: "fix", body: "Fix the bug." };
    const file = (scope: RunningTurn) => requestBrainTool(running, "file_issue", args, scope);
    const pending = file(first);
    await asked.promise;
    end(brain, first, "interrupted");
    const url = `https://github.com/${repository}/issues/1`;
    answer.resolve({ ok: true, value: { number: 1, title: title.en, body: args.body, url, open: true, pullRequest: false } });

    const refused = await pending;
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining(`The GitHub issue was filed at ${url}. No ticket was opened`) });
    expect(running.tickets.list()).toEqual([]);
    const current = startToolTurn(brain, first.conversation);
    expect(await file(current)).toMatchObject({ isError: false, text: expect.stringContaining("opened ticket AA-2026-11-17") });
    expect(lockedTickets(running, current)).toEqual([1]);
    expect(created).toBe(1);
  });
});
