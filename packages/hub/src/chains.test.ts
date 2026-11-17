import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AllowanceStates,
  type MachineChoice,
  type OwnerChoice,
  resolveStart,
  type StartCard,
  startingEngineTable,
  type Ticket,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessVerifier } from "./access.js";
import { type ChainDefaults, type Chains, type ChainSpec, chainFingerprint, createChains } from "./chains.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { TestClock } from "./testing/access.js";
import { createTicketService, type TicketService, type TicketWork } from "./tickets.js";

const sandbox = "novan-xu/super-agent-sandbox";
const other = "novan-xu/other";
const ownerEmail = "owner@example.com";
const ownerToken = "owner-assertion";

let dataDir: string;
let clock: TestClock;
const opened: HubDatabase[] = [];
const made: Chains[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-chains-"));
  clock = new TestClock();
  allowance = { codex: "available", claude: "available" };
});

afterEach(async () => {
  for (const chains of made.splice(0)) {
    chains.close();
    await chains.idle();
  }
  for (const database of opened.splice(0)) {
    database.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const verify: AccessVerifier = async (assertion) => {
  if (assertion === ownerToken) {
    return { ok: true, identity: { kind: "person", email: ownerEmail, subject: "owner" } };
  }
  if (assertion === "someone-else") {
    return { ok: true, identity: { kind: "person", email: "other@example.com", subject: "other" } };
  }
  if (assertion === "service") {
    return { ok: true, identity: { kind: "service", clientId: "runner.access" } };
  }
  return { ok: false, reason: "no assertion" };
};

const testMachines: MachineChoice[] = [
  {
    name: "pc",
    platform: "win32",
    free: 2,
    engines: [
      { engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["medium", "high"] }, { id: "gpt-6.1-terra", efforts: ["high"] }, { id: "gpt-6-luna", efforts: ["medium"] }] },
      { engine: "claude", models: [{ id: "claude-opus-5-5", efforts: ["high", "max"] }, { id: "claude-sonnet-5-5", efforts: ["high"] }] },
    ],
  },
  { name: "mini", platform: "darwin", free: 1, engines: [{ engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high"] }] }] },
];

let allowance: AllowanceStates = { codex: "available", claude: "available" };

function testDefaults(lenient: boolean): ChainDefaults {
  return {
    resolve: (ticket: Ticket, owner: OwnerChoice = ticket.ownerChoice) =>
      resolveStart(
        lenient
          ? { kind: ticket.kind, difficulty: ticket.difficulty ?? "standard", platform: ticket.platform ?? "any", brainEngine: ticket.brainEngine ?? "codex", stated: true, owner }
          : {
              kind: ticket.kind,
              difficulty: ticket.difficulty,
              platform: ticket.platform,
              brainEngine: ticket.brainEngine,
              stated: ticket.difficultyReason !== null && ticket.difficulty !== null && ticket.platform !== null,
              owner,
            },
        startingEngineTable,
        testMachines,
        allowance,
      ),
    machines: () => testMachines,
    machinesFor: () => testMachines,
  };
}

const lenientDefaults = testDefaults(true);

function shown(...list: readonly (Ticket | undefined)[]) {
  return list.flatMap((ticket) => (ticket === undefined ? [] : [{ ticket, choice: lenientDefaults.resolve(ticket) }]));
}

interface Told {
  readonly conversation: string | null;
  readonly notice: string;
  readonly prompt: string;
}

interface Setup {
  readonly tickets: TicketService;
  readonly chains: Chains;
  readonly begun: number[];
  readonly told: Told[];
}

function setup(work?: Partial<TicketWork>, strict = false): Setup {
  const database = openDatabase({ dataDir, clock });
  opened.push(database);
  const begun: number[] = [];
  const told: Told[] = [];
  const tickets = createTicketService({ database, clock });
  const chains = createChains({
    database,
    clock,
    tickets,
    verify,
    ownerEmail,
    defaults: strict ? testDefaults(false) : lenientDefaults,
    work: {
      begin: work?.begin ?? ((ticket) => void begun.push(ticket.id)),
      stop: work?.stop ?? (() => undefined),
      ...(work?.reassign === undefined ? {} : { reassign: work.reassign }),
    },
    tell: (conversation, notice, prompt) => told.push({ conversation, notice, prompt }),
  });
  made.push(chains);
  chains.resume();
  return { tickets, chains, begun, told };
}

function file(tickets: TicketService, number: number, repository = sandbox, extra: Partial<Parameters<TicketService["open"]>[0]> = {}): Ticket {
  const title = { en: `Issue ${number}`, zh: `问题 ${number}` };
  const summary = { en: `Do ${number}`, zh: `做 ${number}` };
  return tickets.open({
    repository,
    issues: [{ repository, number, url: `https://github.com/${repository}/issues/${number}`, title, summary }],
    title,
    summary,
    kind: "feature",
    conversation: "c-1",
    ...extra,
  });
}

function chain(name: string, issues: number[], extra: Partial<ChainSpec> = {}): ChainSpec {
  return { name, repository: sandbox, issues, ...extra };
}

const pairTitle = { title: { en: "Two together", zh: "两件一起做" }, summary: { en: "Both touch the parser", zh: "两件都改解析器" } };

function card(chains: Chains, ticket: number): StartCard {
  const found = chains.cards().find((entry) => entry.ticket.id === ticket);
  if (found === undefined) {
    throw new Error(`No card for ticket ${ticket}`);
  }
  return found;
}

function startOf(chains: Chains, ...ids: number[]) {
  return chains.starter.start({ assertion: ownerToken, chains: ids.map((id) => ({ ticket: id, fingerprint: card(chains, id).fingerprint })) });
}

function state(tickets: TicketService, id: number) {
  return tickets.get(id)?.state;
}

describe("arranging", () => {
  it("puts two issues that touch the same code on one chain and leaves the independent one on its own", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    file(tickets, 3);
    const outcome = chains.arranger.arrange([chain("parser", [1, 2], pairTitle), chain("docs", [3])]);
    expect(outcome.ok).toBe(true);
    const open = tickets.list({ open: true });
    expect(open.map((ticket) => ticket.id).sort()).toEqual([1, 3]);
    expect(tickets.get(1)).toMatchObject({ title: pairTitle.title, issues: [{ number: 1 }, { number: 2 }], state: "pending" });
    expect(tickets.get(2)).toMatchObject({ state: "stopped", stopReason: { en: "Joined ticket 1 by an arrangement", zh: "按新的安排并入了工单 1" } });
    expect(tickets.get(3)).toMatchObject({ issues: [{ number: 3 }], title: { zh: "问题 3" } });
    expect(chains.cards().map((entry) => [entry.ticket.id, entry.before.length, entry.startable])).toEqual([
      [3, 0, true],
      [1, 0, true],
    ]);
  });

  it("keeps the working order it is given and the highest difficulty", () => {
    const { tickets, chains } = setup();
    file(tickets, 1, sandbox, { difficulty: "mechanical" });
    file(tickets, 2, sandbox, { difficulty: "complex" });
    expect(chains.arranger.arrange([chain("pair", [2, 1], pairTitle)]).ok).toBe(true);
    expect(tickets.get(1)).toMatchObject({ issues: [{ number: 2 }, { number: 1 }], difficulty: "complex" });
  });

  it("cuts a chain between repositories, and the second waits for the first", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 9, other);
    const outcome = chains.arranger.arrange([chain("first", [1]), { name: "second", repository: other, issues: [9], after: ["first"] }]);
    expect(outcome.ok).toBe(true);
    expect(tickets.get(2)?.waits).toEqual([{ ticket: 1, deployment: false, waived: false }]);
    expect(card(chains, 2)).toMatchObject({ before: [{ id: 1, state: "pending" }], startable: false });
    expect(card(chains, 1)).toMatchObject({ before: [], startable: true });
  });

  it("splits a ticket into two chains, giving the second a new ticket", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    chains.arranger.arrange([chain("pair", [1, 2], pairTitle)]);
    const outcome = chains.arranger.arrange([chain("one", [1]), chain("two", [2], { after: ["one"] })]);
    expect(outcome).toMatchObject({ ok: true, chains: [{ name: "one", ticket: { id: 1 } }, { name: "two", ticket: { id: 3 } }] });
    expect(tickets.get(1)?.issues.map((issue) => issue.number)).toEqual([1]);
    expect(tickets.get(3)).toMatchObject({ issues: [{ number: 2 }], waitsFor: [1], title: { zh: "问题 2" } });
  });

  it("moves what waited for a joined ticket onto the chain that took its issues", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    file(tickets, 3, sandbox, { waitsFor: [2] });
    expect(chains.arranger.arrange([chain("pair", [1, 2], pairTitle)]).ok).toBe(true);
    expect(tickets.get(3)?.waitsFor).toEqual([1]);
  });

  const refusals: readonly [string, (setup: Setup) => ChainSpec[], RegExp][] = [
    ["a cycle", () => [chain("a", [1], { after: ["b"] }), chain("b", [2], { after: ["a"] })], /cycle: chain a waits for chain b waits for chain a/],
    ["an issue that does not exist", () => [chain("a", [1]), chain("b", [77])], /no pending ticket holds issue novan-xu\/super-agent-sandbox#77/],
    ["a ticket that does not exist", () => [chain("a", [1], { after: [99] })], /ticket 99, which does not exist/],
    ["a chain that is not in the arrangement", () => [chain("a", [1], { after: ["nowhere"] })], /nowhere, which is not a chain/],
    ["an issue named twice", () => [chain("a", [1]), chain("b", [1, 2], pairTitle)], /named in chain a and in chain b/],
    ["a chain of several issues without a title", () => [chain("a", [1, 2])], /needs its own title and summary/],
    ["a chain name used twice", () => [chain("a", [1]), chain("a", [2])], /used twice/],
    ["a chain after itself", () => [chain("a", [1], { after: ["a"] })], /cannot come after itself/],
  ];

  for (const [what, arrangement, reason] of refusals) {
    it(`refuses ${what} and changes nothing`, () => {
      const prepared = setup();
      file(prepared.tickets, 1);
      file(prepared.tickets, 2);
      const before = prepared.tickets.list({ open: true });
      const announced: Ticket[] = [];
      prepared.tickets.subscribe((ticket) => announced.push(ticket));
      const outcome = prepared.chains.arranger.arrange(arrangement(prepared));
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.reason).toMatch(reason);
      expect(outcome.ok ? "" : outcome.reason).toMatch(/^Nothing was changed/);
      expect(prepared.tickets.list({ open: true })).toEqual(before);
      expect(announced).toEqual([]);
    });
  }

  it("refuses a cycle through a pending ticket outside the arrangement", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2, sandbox, { waitsFor: [1] });
    const outcome = chains.arranger.arrange([chain("a", [1], { after: [2] })]);
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok ? "" : outcome.reason).toMatch(/cycle/);
    expect(tickets.get(1)?.waits).toEqual([]);
  });

  it("refuses to arrange an issue whose chain has started: a started chain is closed", async () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    await startOf(chains, 1);
    const outcome = chains.arranger.arrange([chain("a", [1, 2], pairTitle)]);
    expect(outcome.ok ? "" : outcome.reason).toMatch(/on ticket 1, which is working. A started chain is closed/);
    expect(tickets.get(1)?.issues.map((issue) => issue.number)).toEqual([1]);
    expect(chains.arranger.arrange([chain("later", [2], { after: [1] })]).ok).toBe(true);
    expect(card(chains, 2)).toMatchObject({ before: [{ id: 1, state: "working" }], startable: true });
  });

  it("refuses to leave an issue of a rearranged ticket unnamed", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    chains.arranger.arrange([chain("pair", [1, 2], pairTitle)]);
    expect(chains.arranger.arrange([chain("one", [1])])).toMatchObject({ ok: false });
  });

  it("refuses to come after a ticket that stopped", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    tickets.stop(2, { en: "No", zh: "不要了" });
    expect(chains.arranger.arrange([chain("a", [1], { after: [2] })])).toMatchObject({ ok: false });
  });

  it("refuses a chain that needs two platforms", () => {
    const { tickets, chains } = setup();
    file(tickets, 1, sandbox, { platform: "macos" });
    file(tickets, 2, sandbox, { platform: "windows" });
    expect(chains.arranger.arrange([chain("a", [1, 2], pairTitle)])).toMatchObject({ ok: false });
  });
});

describe("starting", () => {
  it("is refused to anyone but the owner, and starts nothing", async () => {
    const { tickets, chains, begun } = setup();
    file(tickets, 1);
    const fingerprint = card(chains, 1).fingerprint;
    for (const assertion of [undefined, "", "someone-else", "service", "forged"]) {
      expect(await chains.starter.start({ assertion, chains: [{ ticket: 1, fingerprint }] })).toEqual({ ok: false, error: "forbidden" });
    }
    expect(state(tickets, 1)).toBe("pending");
    expect(begun).toEqual([]);
  });

  it("begins two independent chains in parallel with one start", async () => {
    const { tickets, chains, begun } = setup();
    file(tickets, 1);
    file(tickets, 2);
    file(tickets, 3);
    chains.arranger.arrange([chain("parser", [1, 2], pairTitle), chain("docs", [3])]);
    const outcome = await startOf(chains, 1, 3);
    expect(outcome).toMatchObject({ ok: true });
    expect([state(tickets, 1), state(tickets, 3)]).toEqual(["working", "working"]);
    await chains.idle();
    expect(begun.sort()).toEqual([1, 3]);
    expect(chains.cards()).toEqual([]);
  });

  it("starts what is arranged after a chain, which waits and then begins by itself when the first merges", async () => {
    const { tickets, chains, begun } = setup();
    file(tickets, 1);
    file(tickets, 9, other);
    chains.arranger.arrange([chain("first", [1]), { name: "second", repository: other, issues: [9], after: ["first"] }]);
    await startOf(chains, 1);
    expect([state(tickets, 1), state(tickets, 2)]).toEqual(["working", "waiting"]);
    await chains.idle();
    expect(begun).toEqual([1]);
    tickets.move(1, "verifying");
    expect(state(tickets, 2)).toBe("waiting");
    tickets.move(1, "merged");
    expect(state(tickets, 2)).toBe("working");
    await chains.idle();
    expect(begun).toEqual([1, 2]);
  });

  it("begins a ticket after a deployment only when the brain reports the deployment", async () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    chains.arranger.arrange([chain("first", [1]), chain("second", [2], { after: ["first"], afterDeployment: true })]);
    await startOf(chains, 1);
    expect(chains.arranger.deployed(1)).toMatchObject({ ok: false });
    tickets.move(1, "verifying");
    tickets.move(1, "merged");
    expect(state(tickets, 2)).toBe("waiting");
    const reported = chains.arranger.deployed(1);
    expect(reported).toMatchObject({ ok: true, began: [{ id: 2 }] });
    expect(state(tickets, 2)).toBe("working");
  });

  it("waits for every ticket before it", async () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    file(tickets, 3);
    chains.arranger.arrange([chain("a", [1]), chain("b", [2]), chain("c", [3], { after: ["a", "b"] })]);
    await startOf(chains, 1, 2, 3);
    expect(state(tickets, 3)).toBe("waiting");
    tickets.move(1, "verifying");
    tickets.move(1, "merged");
    expect(state(tickets, 3)).toBe("waiting");
    tickets.move(2, "verifying");
    tickets.move(2, "merged");
    expect(state(tickets, 3)).toBe("working");
  });

  it("takes a chain behind two others along with the start of the second of them", async () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    file(tickets, 3);
    chains.arranger.arrange([chain("a", [1]), chain("b", [2]), chain("c", [3], { after: ["a", "b"] })]);
    expect(card(chains, 3)).toMatchObject({ startable: false, before: [{ id: 1 }, { id: 2 }] });
    await startOf(chains, 1);
    expect(state(tickets, 3)).toBe("pending");
    expect(card(chains, 2).fingerprint).toBe(chainFingerprint(shown(tickets.get(2), tickets.get(3))));
    await startOf(chains, 2);
    expect(state(tickets, 3)).toBe("waiting");
  });

  it("does not start a chain behind one that is not started with it", async () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    chains.arranger.arrange([chain("a", [1]), chain("b", [2], { after: ["a"] })]);
    expect(await startOf(chains, 2)).toEqual({ ok: false, error: "conflict" });
    expect([state(tickets, 1), state(tickets, 2)]).toEqual(["pending", "pending"]);
  });

  it("is refused when the arrangement changed after the page showed it", async () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    const seen = card(chains, 1).fingerprint;
    chains.arranger.arrange([chain("a", [1]), chain("b", [2], { after: ["a"] })]);
    expect(await chains.starter.start({ assertion: ownerToken, chains: [{ ticket: 1, fingerprint: seen }] })).toEqual({ ok: false, error: "conflict" });
    expect([state(tickets, 1), state(tickets, 2)]).toEqual(["pending", "pending"]);
    expect(card(chains, 1).fingerprint).not.toBe(seen);
  });

  it("is applied once: the same start again, or from a second device, starts nothing more", async () => {
    const { tickets, chains, begun } = setup();
    file(tickets, 1);
    const item = { ticket: 1, fingerprint: card(chains, 1).fingerprint };
    const [first, second] = await Promise.all([
      chains.starter.start({ assertion: ownerToken, chains: [item] }),
      chains.starter.start({ assertion: ownerToken, chains: [item] }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(await chains.starter.start({ assertion: ownerToken, chains: [item] })).toEqual({ ok: false, error: "conflict" });
    await chains.idle();
    expect(begun).toEqual([1]);
    expect(tickets.moves(1).map((move) => move.to)).toEqual(["pending", "working"]);
  });

  it("starts all of a request or none of it", async () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    const good = { ticket: 1, fingerprint: card(chains, 1).fingerprint };
    const stale = { ticket: 2, fingerprint: "0".repeat(64) };
    expect(await chains.starter.start({ assertion: ownerToken, chains: [good, stale] })).toEqual({ ok: false, error: "conflict" });
    expect([state(tickets, 1), state(tickets, 2)]).toEqual(["pending", "pending"]);
  });

  it("names what it starts by a fingerprint of the chain and everything arranged after it", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    file(tickets, 2);
    chains.arranger.arrange([chain("a", [1]), chain("b", [2], { after: ["a"] })]);
    const a = tickets.get(1);
    const b = tickets.get(2);
    if (a === undefined || b === undefined) {
      throw new Error("missing");
    }
    expect(card(chains, 1).fingerprint).toBe(chainFingerprint(shown(a, b)));
    expect(card(chains, 2).fingerprint).toBe(chainFingerprint(shown(b)));
  });
});

describe("a ticket that does not begin", () => {
  it("is kept, records why, and the brain is told", async () => {
    const { tickets, chains, told } = setup({
      begin: () => {
        throw new Error("No machine can take it");
      },
    });
    file(tickets, 1);
    await startOf(chains, 1);
    await chains.idle();
    expect(tickets.get(1)).toMatchObject({ state: "working", beginFailure: "No machine can take it" });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ conversation: "c-1", notice: "工单 1 没能开始，大脑会决定怎么处理" });
    expect(told[0]?.prompt).toMatch(/^\[hub\] The owner started ticket 1 \(Issue 1\), but its work could not begin: No machine can take it/);
  });

  it("is begun again after a restart that came between the start and the beginning", async () => {
    let release: () => void = () => undefined;
    const first = setup({ begin: () => new Promise<void>((resolve) => (release = resolve)) });
    file(first.tickets, 1);
    await startOf(first.chains, 1);
    first.chains.close();
    release();
    await first.chains.idle();
    const database = opened[0];
    database?.connection.exec("UPDATE ticket_begins SET done_at = NULL");
    const again = setup();
    await again.chains.idle();
    expect(again.begun).toEqual([1]);
    expect(again.tickets.get(1)?.state).toBe("working");
  });
});

describe("when a ticket before a waiting one stops", () => {
  it("tells the brain, which can let the waiting ticket go ahead", async () => {
    const { tickets, chains, told } = setup();
    file(tickets, 1);
    file(tickets, 2);
    file(tickets, 3);
    chains.arranger.arrange([chain("a", [1]), chain("b", [2]), chain("c", [3], { after: ["a", "b"] })]);
    await startOf(chains, 1, 2, 3);
    expect(chains.arranger.proceed(3)).toMatchObject({ ok: false });
    tickets.stop(1, { en: "Not needed", zh: "不需要了" });
    expect(told).toHaveLength(1);
    expect(told[0]?.notice).toBe("工单 1 停止了，排在它后面的工单 3 由大脑决定是否继续");
    expect(told[0]?.prompt).toContain("proceed_ticket");
    expect(chains.arranger.proceed(3)).toMatchObject({ ok: true, began: [] });
    expect(tickets.get(3)?.waits).toEqual([
      { ticket: 1, deployment: false, waived: true },
      { ticket: 2, deployment: false, waived: false },
    ]);
    tickets.move(2, "verifying");
    tickets.move(2, "merged");
    expect(state(tickets, 3)).toBe("working");
  });

  it("tells the brain, which can stop the waiting ticket", async () => {
    const { tickets, chains, told } = setup();
    file(tickets, 1);
    file(tickets, 2);
    chains.arranger.arrange([chain("a", [1]), chain("b", [2], { after: ["a"] })]);
    await startOf(chains, 1);
    tickets.stop(1, { en: "Not needed", zh: "不需要了" });
    expect(told).toHaveLength(1);
    expect(tickets.stop(2, { en: "Its base stopped", zh: "前面的停了" }).ok).toBe(true);
    expect(told).toHaveLength(1);
  });

  it("does not let the brain start a pending chain", () => {
    const { tickets, chains } = setup();
    file(tickets, 1);
    expect(chains.arranger.proceed(1)).toMatchObject({ ok: false, reason: expect.stringContaining("only the owner starts it") });
    expect(state(tickets, 1)).toBe("pending");
  });
});

describe("a restart of the hub", () => {
  it("between arranging and starting loses nothing", async () => {
    const first = setup();
    file(first.tickets, 1);
    file(first.tickets, 2);
    file(first.tickets, 9, other);
    first.chains.arranger.arrange([chain("pair", [1, 2], pairTitle), { name: "later", repository: other, issues: [9], after: ["pair"] }]);
    const cards = first.chains.cards();
    first.chains.close();
    for (const database of opened.splice(0)) {
      database.close();
    }
    const second = setup();
    expect(second.chains.cards()).toEqual(cards);
    expect(await startOf(second.chains, 1)).toMatchObject({ ok: true });
    expect([state(second.tickets, 1), state(second.tickets, 3)]).toEqual(["working", "waiting"]);
  });

  it("begins a waiting ticket whose ticket before it merged while nobody was listening", async () => {
    const first = setup();
    file(first.tickets, 1);
    file(first.tickets, 2);
    first.chains.arranger.arrange([chain("a", [1]), chain("b", [2], { after: ["a"] })]);
    await startOf(first.chains, 1);
    first.chains.close();
    first.tickets.move(1, "verifying");
    first.tickets.move(1, "merged");
    expect(state(first.tickets, 2)).toBe("waiting");
    for (const database of opened.splice(0)) {
      database.close();
    }
    const second = setup();
    expect(state(second.tickets, 2)).toBe("working");
    await second.chains.idle();
    expect(second.begun).toEqual([2]);
  });
});
