import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AllowanceReading,
  brainToolsPath,
  type MachineReport,
  protocolVersion,
  PushPayload,
  ServerMessage,
  type StartCard,
  TicketList,
  unknownAllowance,
  type WaitingCard,
  WaitingList,
} from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import WebSocket from "ws";
import type { Hub } from "./hub.js";
import { createPushDevice, receivePush } from "./push-device.js";
import { generateVapidKeys, type VapidKeys } from "./push.js";
import { allowancePath, chainChoicePath, chainStartPath, engineTablePath } from "./server.js";
import { assertion, keySet, personClaims, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { testCredentials } from "./testing/commands.js";
import { type FakeGitHub, fakeGitHub } from "./testing/github.js";
import { startTestHub } from "./testing/http.js";
import type { TicketWork } from "./tickets.js";

const sandbox = "novan-xu/super-agent-sandbox";
const other = "novan-xu/other-sandbox";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let github: FakeGitHub;
let vapid: VapidKeys;
let hub: Hub | undefined;
const sockets: WebSocket[] = [];
const pushes: Buffer[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-chains-api-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  github = fakeGitHub();
  github.repositories.set(sandbox, []);
  github.repositories.set(other, []);
  vapid = generateVapidKeys();
  pushes.splice(0);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const begun: number[] = [];
const reassigned: string[] = [];

const work: TicketWork = {
  begin: (ticket) => {
    begun.push(ticket.id);
  },
  stop: () => undefined,
  reassign: (ticket) => {
    reassigned.push(`${ticket.id} ${ticket.machine ?? ""} ${ticket.engine ?? ""} ${ticket.model ?? ""} ${ticket.effort ?? ""}`);
  },
};

function machineReport(platform: MachineReport["platform"], allowances: readonly AllowanceReading[] = []): MachineReport {
  return {
    hostname: "test-machine",
    platform,
    release: "1",
    arch: "x64",
    user: "owner",
    slots: { total: 2, free: 2 },
    programs: [
      {
        id: "codex",
        installed: true,
        path: "codex",
        version: "1",
        models: [
          { id: "gpt-6.1-sol", efforts: ["medium", "high"] },
          { id: "gpt-6.1-terra", efforts: ["high"] },
          { id: "gpt-6-luna", efforts: ["medium"] },
        ],
        source: "program",
        problem: null,
      },
      {
        id: "claude",
        installed: true,
        path: "claude",
        version: "1",
        models: [
          { id: "claude-opus-5-5", efforts: ["high", "max"] },
          { id: "claude-sonnet-5-5", efforts: ["high"] },
        ],
        source: "program",
        problem: null,
      },
      { id: "dsh", installed: true, path: "dsh", version: "1", models: [{ id: "deepseek-flash", efforts: ["low", "high", "max"] }], source: "configuration", problem: null },
    ],
    allowances: [...allowances],
  };
}

const sent: unknown[] = [];

function connect(running: Hub, name: string, report: MachineReport): void {
  if (running.machines.get(name) === undefined) {
    running.machines.add({ name, accessClientId: `${name}.access` });
  }
  const machine = running.machines.get(name);
  if (machine === undefined) {
    throw new Error("machine missing");
  }
  running.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined }).receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
}

async function stateDefaults(running: Hub, engine: "codex" | "claude" = "codex"): Promise<void> {
  const pending = running.tickets.list({ open: true }).filter((ticket) => ticket.state === "pending" && ticket.difficultyReason === null);
  if (pending.length === 0) {
    return;
  }
  const stated = await callBrainTool(running, "choose_defaults", {
    chains: pending.map((ticket) => ({
      ticket: ticket.code,
      kind: ticket.kind,
      issues: ticket.issues.map((issue) => ({ number: issue.number, difficulty: "standard" })),
      reason: { en: "Bounded work in one module", zh: "限定在一个模块里的工作" },
      platform: "windows",
      engine,
    })),
  });
  expect(stated.isError, stated.text).toBe(false);
}

async function start(): Promise<Hub> {
  begun.splice(0);
  reassigned.splice(0);
  hub = await startTestHub({
    config: { ...testConfig(dataDir), vapid },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [github],
    credentials: testCredentials,
    ticketWork: work,
    pushFetch: (_input, init) => {
      pushes.push(Buffer.from(init?.body as Uint8Array));
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });
  connect(hub, "pc", machineReport("win32"));
  return hub;
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

function brainToken(): string {
  return readFileSync(join(dataDir, "brain.token"), "utf8").trim();
}

async function fileIssue(running: Hub, title: string, zh: string, repository = sandbox): Promise<void> {
  const filed = await callBrainTool(running, "file_issue", {
    repository,
    title: { en: title, zh },
    summary: { en: `${title}.`, zh: `${zh}。` },
    body: `## Goal\n\n${title}.`,
    kind: "feature",
  });
  expect(filed.isError).toBe(false);
}

interface StartCall {
  readonly token?: string | null;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

async function startCall(running: Hub, call: StartCall): Promise<Response> {
  const headers = new Headers({ origin: base(running), "content-type": "application/json", ...call.headers });
  const proof = call.token === undefined ? await assertion({ key, clock }) : call.token;
  if (proof !== null) {
    headers.set("Cf-Access-Jwt-Assertion", proof);
  }
  return fetch(`${base(running)}${chainStartPath}`, { method: "POST", headers, body: call.body ?? "{}" });
}

async function waitingCards(running: Hub): Promise<WaitingCard[]> {
  const response = await fetch(`${base(running)}/api/waiting`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
  return WaitingList.parse(await response.json()).cards;
}

async function startCards(running: Hub): Promise<StartCard[]> {
  return (await waitingCards(running)).flatMap((card) => (card.kind === "start" ? [card] : []));
}

async function startBody(running: Hub, ...tickets: number[]): Promise<string> {
  await stateDefaults(running);
  const cards = await startCards(running);
  return JSON.stringify({
    chains: tickets.map((ticket) => ({ ticket, fingerprint: cards.find((card) => card.ticket.id === ticket)?.fingerprint ?? "" })),
  });
}

async function fileThree(running: Hub): Promise<void> {
  await fileIssue(running, "Parse dates", "解析日期");
  await fileIssue(running, "Parse times", "解析时间");
  await fileIssue(running, "Write the guide", "写使用说明");
  const arranged = await callBrainTool(running, "arrange_chains", {
    chains: [
      { name: "parser", repository: sandbox, issues: [1, 2], title: { en: "Parse dates and times", zh: "解析日期和时间" }, summary: { en: "Both change the parser.", zh: "两件都改解析器。" } },
      { name: "guide", repository: sandbox, issues: [3] },
    ],
  });
  expect(arranged.isError).toBe(false);
  expect(arranged.text).toContain("Chain parser is ticket aa-2026-11-17");
  expect(arranged.text).toContain("Chain guide is ticket ac-2026-11-17");
  expect(arranged.text).toContain("Closed as joined into other chains: ticket ab-2026-11-17.");
}

class Inbox {
  readonly messages: ServerMessage[] = [];
  private readonly wakers = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.messages.push(ServerMessage.parse(JSON.parse(String(data))));
      for (const wake of [...this.wakers]) {
        wake();
      }
    });
  }

  until(predicate: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (predicate()) {
          this.wakers.delete(check);
          resolve();
        }
      };
      this.wakers.add(check);
      check();
    });
  }

  lastCards(): readonly WaitingCard[] {
    return this.messages.flatMap((message) => (message.type === "waiting" ? [message.cards] : [])).at(-1) ?? [];
  }

  ticketState(id: number): string | undefined {
    return this.messages.flatMap((message) => (message.type === "ticket" && message.ticket.id === id ? [message.ticket.state] : [])).at(-1);
  }
}

async function page(running: Hub): Promise<Inbox> {
  const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
  sockets.push(socket);
  const inbox = new Inbox(socket);
  await inbox.until(() => inbox.messages.some((message) => message.type === "tickets"));
  return inbox;
}

describe("chains from filing to start", () => {
  it("makes three issues two chains, shows them as start cards, and one start begins both", async () => {
    const running = await start();
    const inbox = await page(running);
    await fileThree(running);
    await inbox.until(() => inbox.lastCards().filter((card) => card.kind === "start").length === 2);
    const cards = await startCards(running);
    const shown = cards.map((card) => [card.ticket.id, card.ticket.issues.map((issue) => issue.title.zh), card.before, card.startable]);
    expect(shown.sort()).toEqual([
      [1, ["解析日期", "解析时间"], [], true],
      [3, ["写使用说明"], [], true],
    ]);
    const response = await startCall(running, { body: await startBody(running, 1, 3) });
    expect(response.status).toBe(202);
    const started = TicketList.parse(await response.json());
    expect(started.tickets.map((ticket) => [ticket.id, ticket.state])).toEqual([
      [1, "working"],
      [3, "working"],
    ]);
    await inbox.until(() => inbox.ticketState(1) === "working" && inbox.ticketState(3) === "working" && inbox.lastCards().length === 0);
    await running.chains.idle();
    expect(begun.sort()).toEqual([1, 3]);
    expect((await callBrainTool(running, "read_ticket", { ticket: "aa" })).text).toContain("pending -> working");
  });

  it("counts pending chains as waiting for the owner, and sends one notification when new chains are ready", async () => {
    const running = await start();
    const device = createPushDevice();
    const subscribed = await fetch(`${base(running)}/api/push/subscription`, {
      method: "POST",
      headers: { origin: base(running), "content-type": "application/json", "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:9/device", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: vapid.publicKey }),
    });
    expect(subscribed.status).toBe(200);
    await fileIssue(running, "Parse dates", "解析日期");
    await fileIssue(running, "Parse times", "解析时间");
    await running.push?.idle();
    expect(await waitingCards(running)).toHaveLength(2);
    const payloads = pushes.map((body) => PushPayload.parse(JSON.parse(receivePush(device, body))));
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    expect(payloads.length).toBeLessThanOrEqual(2);
    expect(payloads[0]).toMatchObject({ title: "等你", body: "有新的工单可以开始", tag: "start" });
    const before = pushes.length;
    await callBrainTool(running, "arrange_chains", { chains: [{ name: "a", repository: sandbox, issues: [1] }, { name: "b", repository: sandbox, issues: [2], after: ["a"] }] });
    await running.push?.idle();
    expect(pushes.length).toBe(before);
  });

  it("refuses an arrangement with a cycle, and changes nothing", async () => {
    const running = await start();
    await fileIssue(running, "Parse dates", "解析日期");
    await fileIssue(running, "Parse times", "解析时间");
    const cards = await startCards(running);
    const refused = await callBrainTool(running, "arrange_chains", {
      chains: [
        { name: "a", repository: sandbox, issues: [1], after: ["b"] },
        { name: "b", repository: sandbox, issues: [2], after: ["a"] },
      ],
    });
    expect(refused).toEqual({ isError: true, text: "Nothing was changed: it has a cycle: chain a waits for chain b waits for chain a" });
    expect(await startCards(running)).toEqual(cards);
    const missing = await callBrainTool(running, "arrange_chains", { chains: [{ name: "a", repository: sandbox, issues: [1, 5], title: { en: "x", zh: "某事" }, summary: { en: "x", zh: "某事" } }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("#5");
    expect(await startCards(running)).toEqual(cards);
  });

  it("cuts a chain between two repositories, and the second begins by itself when the first merges", async () => {
    const running = await start();
    const inbox = await page(running);
    await fileIssue(running, "Add the endpoint", "加接口");
    await fileIssue(running, "Call the endpoint", "调用接口", other);
    const arranged = await callBrainTool(running, "arrange_chains", {
      chains: [
        { name: "server", repository: sandbox, issues: [1] },
        { name: "client", repository: other, issues: [1], after: ["server"] },
      ],
    });
    expect(arranged.text).toContain("Chain client is ticket ab-2026-11-17 in novan-xu/other-sandbox: #1; after ticket aa-2026-11-17.");
    const cards = await startCards(running);
    expect(cards.find((card) => card.ticket.id === 2)).toMatchObject({ before: [{ id: 1, title: { zh: "加接口" }, state: "pending" }], startable: false });
    expect((await startCall(running, { body: await startBody(running, 1) })).status).toBe(202);
    expect(running.tickets.get(2)?.state).toBe("waiting");
    running.tickets.move(1, "verifying");
    running.tickets.move(1, "merged");
    await inbox.until(() => inbox.ticketState(2) === "working");
    await running.chains.idle();
    expect(begun).toEqual([1, 2]);
  });

  it("tells the brain in the waiting ticket's topic when its prerequisite stops", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    await fileIssue(running, "Add the endpoint", "加接口");
    await fileIssue(running, "Call the endpoint", "调用接口");
    await callBrainTool(running, "arrange_chains", {
      chains: [
        { name: "server", repository: sandbox, issues: [1] },
        { name: "client", repository: sandbox, issues: [2], after: ["server"] },
      ],
    });
    expect((await startCall(running, { body: await startBody(running, 1) })).status).toBe(202);
    await callBrainTool(running, "stop_ticket", { ticket: "aa", reason: { en: "Wrong approach", zh: "方法不对" } });
    const waitingTopic = running.tickets.get(2)?.conversation;
    expect(waitingTopic).toBeTruthy();
    const notices = running.conversations.entries(waitingTopic ?? "").filter((entry) => entry.kind === "notice");
    expect(notices.map((entry) => entry.kind === "notice" && entry.text)).toEqual(["工单 aa 停止了，排在它后面的工单 ab 由大脑决定是否继续"]);
    expect(running.conversations.entries(conversation.id)).toEqual([]);
    const proceeded = await callBrainTool(running, "proceed_ticket", { ticket: "ab" });
    expect(proceeded.isError).toBe(false);
    expect(running.tickets.get(2)?.state).toBe("working");
  });

  it("loses nothing to a restart between arranging and starting", async () => {
    const first = await start();
    await fileThree(first);
    const cards = await startCards(first);
    await first.close();
    hub = undefined;
    const second = await start();
    expect(await startCards(second)).toEqual(cards);
    const response = await startCall(second, { body: await startBody(second, 1, 3) });
    expect(response.status).toBe(202);
    expect([second.tickets.get(1)?.state, second.tickets.get(3)?.state]).toEqual(["working", "working"]);
  });
});

describe("only the owner starts a chain", () => {
  async function prepared(): Promise<{ running: Hub; body: string }> {
    const running = await start();
    await fileIssue(running, "Parse dates", "解析日期");
    return { running, body: await startBody(running, 1) };
  }

  async function unchanged(running: Hub): Promise<void> {
    expect(running.tickets.get(1)?.state).toBe("pending");
    await running.chains.idle();
    expect(begun).toEqual([]);
  }

  it("refuses the brain's token", async () => {
    const { running, body } = await prepared();
    const response = await startCall(running, { token: null, headers: { authorization: `Bearer ${brainToken()}` }, body });
    expect(response.status).toBe(403);
    await unchanged(running);
  });

  it("refuses the brain's token on the brain's own path", async () => {
    const { running, body } = await prepared();
    const response = await fetch(`${base(running)}/brain${chainStartPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json", origin: base(running) },
      body,
    });
    expect(response.status).toBe(404);
    await unchanged(running);
  });

  it("offers the brain no tool that starts a chain", async () => {
    const { running } = await prepared();
    const listed = await fetch(`${base(running)}${brainToolsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(names.filter((name) => /start|begin/.test(name))).toEqual(["start_light_task"]);
    expect((await callBrainTool(running, "start_light_task", { proposal: "aa" })).isError).toBe(true);
    expect((await callBrainTool(running, "start_chain", { ticket: "aa" })).text).toBe("Unknown tool: start_chain");
    expect((await callBrainTool(running, "proceed_ticket", { ticket: "aa" })).isError).toBe(true);
    await unchanged(running);
  });

  it("refuses a service token, and a person who is not the owner", async () => {
    const { running, body } = await prepared();
    const service = await assertion({ key, clock, claims: serviceClaims() });
    expect((await startCall(running, { token: service, body })).status).toBe(403);
    const stranger = await assertion({ key, clock, claims: personClaims("someone@example.com") });
    expect((await startCall(running, { token: stranger, body })).status).toBe(403);
    expect((await startCall(running, { token: null, body })).status).toBe(403);
    await unchanged(running);
  });

  it("refuses a request without the page's own origin", async () => {
    const { running, body } = await prepared();
    const headers = new Headers({ "content-type": "application/json", "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) });
    expect((await fetch(`${base(running)}${chainStartPath}`, { method: "POST", headers, body })).status).toBe(403);
    expect((await startCall(running, { headers: { origin: "https://elsewhere.example" }, body })).status).toBe(403);
    expect((await startCall(running, { headers: { "sec-fetch-site": "cross-site" }, body })).status).toBe(403);
    await unchanged(running);
  });

  it("refuses a body that is not JSON, and one without a fingerprint", async () => {
    const { running, body } = await prepared();
    expect((await startCall(running, { headers: { "content-type": "text/plain" }, body })).status).toBe(415);
    expect((await startCall(running, { body: JSON.stringify({ chains: [{ ticket: 1 }] }) })).status).toBe(400);
    expect((await startCall(running, { body: "not json" })).status).toBe(400);
    await unchanged(running);
  });

  it("refuses a start of an arrangement other than the one the page showed", async () => {
    const { running, body } = await prepared();
    await fileIssue(running, "Parse times", "解析时间");
    await callBrainTool(running, "arrange_chains", {
      chains: [{ name: "both", repository: sandbox, issues: [1, 2], title: { en: "Both", zh: "两件" }, summary: { en: "Both.", zh: "两件。" } }],
    });
    const response = await startCall(running, { body });
    expect(response.status).toBe(409);
    await unchanged(running);
  });

  it("applies a start once, however often it is sent", async () => {
    const { running, body } = await prepared();
    const answers = await Promise.all([startCall(running, { body }), startCall(running, { body })]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409]);
    expect((await startCall(running, { body })).status).toBe(409);
    await running.chains.idle();
    expect(begun).toEqual([1]);
  });
});

async function ownerSend(running: Hub, path: string, body: unknown, options: { readonly method?: string; readonly headers?: Record<string, string>; readonly token?: string | null } = {}): Promise<Response> {
  const headers = new Headers({ origin: base(running), "content-type": "application/json", ...options.headers });
  const proof = options.token === undefined ? await assertion({ key, clock }) : options.token;
  if (proof !== null) {
    headers.set("Cf-Access-Jwt-Assertion", proof);
  }
  return fetch(`${base(running)}${path}`, { method: options.method ?? "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function cardOf(running: Hub, ticket: number): Promise<StartCard> {
  const found = (await startCards(running)).find((card) => card.ticket.id === ticket);
  if (found === undefined) {
    throw new Error(`no card for ticket ${ticket}`);
  }
  return found;
}

async function stateOne(running: Hub, platform: "windows" | "macos" | "any", engine: "codex" | "claude", difficulty = "complex"): Promise<void> {
  const stated = await callBrainTool(running, "choose_defaults", {
    chains: [
      {
        ticket: "aa",
        kind: "feature",
        issues: [{ number: 1, difficulty }],
        reason: { en: "It changes state across the hub and the page", zh: "改动跨越 hub 和页面的状态" },
        platform,
        engine,
      },
    ],
  });
  expect(stated.isError, stated.text).toBe(false);
}

function reading(program: "codex" | "claude", state: "available" | "exhausted", readAt: number): import("@super-agent2/protocol").SubscriptionReading {
  return {
    program,
    readAt,
    state,
    remainingPercent: state === "exhausted" ? 0 : 50,
    resetsAt: readAt + 3_600_000,
    windows: [{ name: "primary", usedPercent: state === "exhausted" ? 100 : 50, resetsAt: readAt + 3_600_000 }],
    problem: null,
  };
}

describe("start defaults", () => {
  it("tells the conversation once when a runner reports new models", async () => {
    const running = await start();
    const report = machineReport("win32");
    report.programs[0]!.models.push({ id: "new-one", efforts: ["high"] }, { id: "new-two", efforts: ["low"] });
    connect(running, "pc", report);
    connect(running, "pc", report);
    const rows = running.database.connection.prepare("SELECT body, prompt FROM conversation_entries WHERE kind = 'notice' AND prompt LIKE ?").all("%New models were reported%");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("new-one");
    expect(JSON.stringify(rows)).toContain("new-two");
    expect(JSON.stringify(rows)).toContain("pc (efforts: high)");
  });

  it("changes an engine row through the brain tool only for offered changes", async () => {
    const running = await start();
    const before = running.defaults.table();
    const row = { ...before.claude, complex: { model: "claude-opus-5-5", effort: "max" } };
    expect((await callBrainTool(running, "set_engine_row", { engine: "claude", row })).isError).toBe(false);
    expect(running.defaults.table().claude).toEqual(row);
    const bad = { ...row, complex: { model: "unknown-model", effort: "high" } };
    expect((await callBrainTool(running, "set_engine_row", { engine: "claude", row: bad })).isError).toBe(true);
    expect(running.defaults.table().claude).toEqual(row);
  });

  it("offers a complex Windows chain on the runner with the complex row, its reason in Chinese, and starts what the card showed", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    const before = await cardOf(running, 1);
    expect(before.choice.missing).toEqual(["defaults"]);
    await stateOne(running, "windows", "claude");
    const card = await cardOf(running, 1);
    expect(card.ticket).toMatchObject({ difficulty: "complex", platform: "windows", brainEngine: "claude" });
    expect(card.ticket.difficultyReason?.zh).toBe("改动跨越 hub 和页面的状态");
    expect(card.choice).toEqual({
      machine: "pc",
      engine: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      by: { machine: "default", engine: "default", model: "default", effort: "default" },
      missing: [],
    });
    expect(card.machines.map((machine) => machine.name)).toEqual(["pc"]);
    const changed = await ownerSend(running, chainChoicePath, { ticket: 1, model: "claude-opus-5-5", effort: "max" });
    expect(changed.status).toBe(202);
    const after = await cardOf(running, 1);
    expect(after.choice).toMatchObject({ model: "claude-opus-5-5", effort: "max", by: { model: "owner", effort: "owner", engine: "default" } });
    expect(after.fingerprint).not.toBe(card.fingerprint);
    expect((await startCall(running, { body: JSON.stringify({ chains: [{ ticket: 1, fingerprint: card.fingerprint }] }) })).status).toBe(409);
    expect((await startCall(running, { body: JSON.stringify({ chains: [{ ticket: 1, fingerprint: after.fingerprint }] }) })).status).toBe(202);
    expect(running.tickets.get(1)).toMatchObject({
      state: "working",
      machine: "pc",
      engine: "claude",
      model: "claude-opus-5-5",
      effort: "max",
      chosenBy: { machine: "default", engine: "default", model: "owner", effort: "owner" },
      ran: null,
    });
    const read = await callBrainTool(running, "read_ticket", { ticket: "aa" });
    expect(read.text).toContain("chosen by: machine default, engine default, model owner, effort owner");
  });

  it("shows a writing ticket as a start card for a machine that has Antigravity, starts it from the card, and keeps Antigravity from code", async () => {
    const running = await start();
    const agy: MachineReport = {
      ...machineReport("darwin"),
      programs: [
        {
          id: "antigravity",
          installed: true,
          path: "agy",
          version: "1.5.10",
          models: [{ id: "gemini-3.8-flash", efforts: ["low", "medium", "high"] }],
          source: "program",
          problem: null,
        },
      ],
    };
    connect(running, "mac", agy);
    const opened = await callBrainTool(running, "open_task_ticket", {
      title: { en: "Translate a notice", zh: "翻译一则通知" },
      summary: { en: "Translate the notice into English", zh: "把通知译成英文" },
      task: "Translate the notice into English.",
      kind: "writing",
      material: [{ name: "notice.txt", source: "pasted by the owner in the conversation", text: "你好，世界。" }],
    });
    expect(opened.isError, opened.text).toBe(false);
    const before = await cardOf(running, 1);
    expect(before.choice.missing).toEqual(["defaults"]);
    const stated = await callBrainTool(running, "choose_defaults", {
      chains: [{ ticket: "aa", kind: "writing", reason: { en: "A short translation", zh: "一段很短的翻译" }, platform: "any" }],
    });
    expect(stated.isError, stated.text).toBe(false);
    const card = await cardOf(running, 1);
    expect(card.ticket).toMatchObject({ kind: "writing", repository: null, issues: [], difficulty: "standard" });
    expect(card.choice).toEqual({
      machine: "mac",
      engine: "antigravity",
      model: "gemini-3.8-flash",
      effort: "high",
      by: { machine: "default", engine: "default", model: "default", effort: "default" },
      missing: [],
    });
    expect(card.machines.find((machine) => machine.name === "pc")?.engines.some((engine) => engine.engine === "antigravity")).toBe(false);
    expect(card.machines.find((machine) => machine.name === "mac")?.engines.map((engine) => engine.engine)).toEqual(["antigravity"]);
    expect((await startCall(running, { body: JSON.stringify({ chains: [{ ticket: 1, fingerprint: card.fingerprint }] }) })).status).toBe(202);
    expect(running.tickets.get(1)).toMatchObject({ state: "working", machine: "mac", engine: "antigravity", model: "gemini-3.8-flash", effort: "high" });
    expect(begun).toEqual([1]);
    await fileIssue(running, "Move the state", "搬动状态");
    const refused = await ownerSend(running, chainChoicePath, { ticket: 2, engine: "antigravity" });
    expect(refused.status).toBe(422);
    expect(running.tickets.get(2)?.ownerChoice.engine).toBeNull();
  });

  it("refuses a model and effort the machine does not offer, and a chain that is not complete, before the start", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    await stateOne(running, "windows", "codex");
    const unsupported = await ownerSend(running, chainChoicePath, { ticket: 1, model: "gpt-6.1-sol", effort: "max" });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({ error: "unsupported" });
    expect(running.tickets.get(1)?.ownerChoice).toEqual({ machine: null, engine: null, model: null, effort: null });
    expect((await ownerSend(running, chainChoicePath, { ticket: 1, machine: "elsewhere" })).status).toBe(422);
    await stateOne(running, "macos", "codex");
    const card = await cardOf(running, 1);
    expect(card.choice.missing).toEqual(["machine"]);
    const refused = await startCall(running, { body: JSON.stringify({ chains: [{ ticket: 1, fingerprint: card.fingerprint }] }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "incomplete" });
    expect(running.tickets.get(1)?.state).toBe("pending");
    connect(running, "mini", machineReport("darwin"));
    expect((await cardOf(running, 1)).choice).toMatchObject({ machine: "mini", engine: "codex", model: "gpt-6.1-sol", effort: "high", missing: [] });
  });

  it("broadcasts fresh allowance windows and requests online runners to refresh", async () => {
    const running = await start();
    const inbox = await page(running);
    expect(inbox.messages.some((message) => message.type === "allowance")).toBe(true);
    expect((await ownerSend(running, allowancePath, {}, { headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
    expect((await ownerSend(running, allowancePath, {}, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    const response = await ownerSend(running, allowancePath, {});
    expect(await response.json()).toEqual({ requested: 1 });
    expect(sent).toContainEqual({ type: "allowance.refresh" });
    const window = { name: "primary", usedPercent: 15, durationMinutes: 10080, resetsAt: clock.now() + 10000 };
    connect(running, "pc", machineReport("win32", [{ ...reading("codex", "available", clock.now()), windows: [window] }]));
    await inbox.until(() => inbox.messages.some((message) => message.type === "allowance" && message.allowance.subscriptions.some((entry) => entry.windows?.some((item) => item.durationMinutes === 10080))));
    const latest = inbox.messages.filter((message) => message.type === "allowance").at(-1);
    expect(latest?.type === "allowance" && latest.allowance.subscriptions[0]?.windows).toEqual([window]);
  });

  it("chooses dsh only when both subscriptions are used up by a current reading", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    await stateOne(running, "windows", "codex", "standard");
    expect((await cardOf(running, 1)).choice).toMatchObject({ engine: "codex", model: "gpt-6.1-terra", effort: "high" });
    connect(running, "pc", machineReport("win32", [reading("codex", "exhausted", clock.now()), reading("claude", "exhausted", clock.now())]));
    expect((await cardOf(running, 1)).choice).toMatchObject({ engine: "dsh", model: "deepseek-flash", effort: "high", missing: [] });
    const allowance = await fetch(`${base(running)}${allowancePath}`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    expect(((await allowance.json()) as { subscriptions: { state: string }[] }).subscriptions.map((entry) => entry.state)).toEqual(["exhausted", "exhausted"]);
    const told = await callBrainTool(running, "read_allowance", {});
    expect(told.text).toContain("GPT subscription (codex): used up");
    connect(running, "pc", machineReport("win32", [reading("codex", "exhausted", clock.now()), reading("claude", "available", clock.now())]));
    expect((await cardOf(running, 1)).choice.engine).toBe("claude");
    connect(running, "pc", machineReport("win32", [reading("codex", "exhausted", clock.now() - 31 * 60_000), reading("claude", "exhausted", clock.now())]));
    expect((await cardOf(running, 1)).choice.engine).toBe("codex");
    connect(running, "pc", machineReport("win32"));
    expect((await cardOf(running, 1)).choice.engine).toBe("codex");
  });

  it("shows a provider a worker found unavailable in the allowance, the brain's tool and 设置, and starts new chains on the next one, with an unknown reading never counting", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    await stateOne(running, "windows", "claude", "standard");
    connect(running, "pc", machineReport("win32", [unknownAllowance("codex", clock.now(), "no machine could ask"), unknownAllowance("claude", clock.now(), "no machine could ask")]));
    expect((await cardOf(running, 1)).choice).toMatchObject({ engine: "claude" });
    expect(running.defaults.unavailable()).toEqual([]);
    running.defaults.markUnavailable("claude", "You've hit your limit", clock.now() + 3_600_000);
    expect((await cardOf(running, 1)).choice).toMatchObject({ engine: "codex", model: "gpt-6.1-terra" });
    const allowance = (await (await fetch(`${base(running)}${allowancePath}`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } })).json()) as {
      subscriptions: { program: string; state: string }[];
      unavailable: { program: string; reason: string; until: number; given: boolean }[];
    };
    expect(allowance.subscriptions.map((entry) => entry.state)).toEqual(["unknown", "unknown"]);
    expect(allowance.unavailable).toEqual([{ program: "claude", reason: "You've hit your limit", since: clock.now(), until: clock.now() + 3_600_000, given: true }]);
    const told = await callBrainTool(running, "read_allowance", {});
    expect(told.text).toContain("Claude Code (Claude): You've hit your limit; until");
    expect(told.text).toContain("An unknown reading is not used up.");
    expect(running.settings.snapshot().unavailable).toEqual(allowance.unavailable);
    clock.advance(3_600_000);
    expect(running.settings.snapshot().unavailable).toEqual([]);
    expect((await cardOf(running, 1)).choice.engine).toBe("claude");
    expect((await callBrainTool(running, "read_allowance", {})).text).toContain("No worker program is marked unavailable.");
  });

  it("keeps the table of models in the hub, read by the owner and changed only from the owner's page", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    await stateOne(running, "windows", "codex");
    const read = await fetch(`${base(running)}${engineTablePath}`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    const { table } = (await read.json()) as { table: { codex: { complex: { model: string; effort: string } } } };
    expect(table.codex.complex).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    const next = { ...table, codex: { ...table.codex, complex: { model: "gpt-6.1-sol", effort: "medium" } } };
    expect((await ownerSend(running, engineTablePath, { table: next }, { method: "PUT", headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
    expect((await ownerSend(running, engineTablePath, { table: next }, { method: "PUT", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await ownerSend(running, engineTablePath, { table: { codex: {} } }, { method: "PUT" })).status).toBe(400);
    expect((await cardOf(running, 1)).choice.effort).toBe("high");
    expect((await ownerSend(running, engineTablePath, { table: next }, { method: "PUT" })).status).toBe(200);
    expect((await cardOf(running, 1)).choice).toMatchObject({ model: "gpt-6.1-sol", effort: "medium", by: { effort: "default" } });
  });

  it("guards a change of the card as it guards the start", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    await stateOne(running, "windows", "codex");
    const change = { ticket: 1, engine: "claude" };
    expect((await ownerSend(running, chainChoicePath, change, { headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
    expect((await ownerSend(running, chainChoicePath, change, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await ownerSend(running, chainChoicePath, change, { token: null, headers: { authorization: `Bearer ${brainToken()}` } })).status).toBe(403);
    expect((await ownerSend(running, chainChoicePath, change, { token: await assertion({ key, clock, claims: serviceClaims() }) })).status).toBe(403);
    expect((await ownerSend(running, chainChoicePath, { ...change, extra: 1 })).status).toBe(400);
    expect((await ownerSend(running, chainChoicePath, { ticket: 9, engine: "claude" })).status).toBe(404);
    expect(running.tickets.get(1)?.ownerChoice.engine).toBeNull();
    expect((await ownerSend(running, chainChoicePath, change)).status).toBe(202);
    expect((await cardOf(running, 1)).choice).toMatchObject({ engine: "claude", model: "claude-opus-5-5", by: { engine: "owner", model: "default" } });
  });

  it("chooses again for a started ticket through 改派's route, and holds the choice otherwise", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    await stateOne(running, "windows", "claude");
    expect((await ownerSend(running, "/api/tickets/1/reassign", { engine: "codex" })).status).toBe(409);
    expect((await startCall(running, { body: JSON.stringify({ chains: [{ ticket: 1, fingerprint: (await cardOf(running, 1)).fingerprint }] }) })).status).toBe(202);
    expect(running.tickets.get(1)).toMatchObject({ engine: "claude", model: "claude-opus-5-5" });
    expect((await ownerSend(running, "/api/tickets/1/reassign", { engine: "codex", model: "gpt-6.1-sol", effort: "max" })).status).toBe(422);
    expect((await ownerSend(running, "/api/tickets/1/reassign", { engine: "codex" }, { headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
    expect((await ownerSend(running, "/api/tickets/1/reassign", { engine: "codex" })).status).toBe(202);
    expect(running.tickets.get(1)).toMatchObject({
      state: "working",
      machine: "pc",
      engine: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      chosenBy: { machine: "default", engine: "owner", model: "default", effort: "default" },
    });
    expect(reassigned).toEqual(["1 pc codex gpt-6.1-sol high"]);
  });

  it("refuses defaults that do not name every issue, or a code chain without its engine", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    const wrong = await callBrainTool(running, "choose_defaults", {
      chains: [{ ticket: "aa", kind: "feature", issues: [{ number: 2, difficulty: "complex" }], reason: { en: "x", zh: "某事" }, platform: "any", engine: "codex" }],
    });
    expect(wrong).toMatchObject({ isError: true });
    expect(wrong.text).toContain("give the difficulty of each of them");
    const noEngine = await callBrainTool(running, "choose_defaults", {
      chains: [{ ticket: "aa", kind: "feature", issues: [{ number: 1, difficulty: "complex" }], reason: { en: "x", zh: "某事" }, platform: "any" }],
    });
    expect(noEngine.text).toContain("choose its engine");
    const twoLines = await callBrainTool(running, "choose_defaults", {
      chains: [{ ticket: "aa", kind: "feature", issues: [{ number: 1, difficulty: "complex" }], reason: { en: "a\nb", zh: "某事" }, platform: "any", engine: "codex" }],
    });
    expect(twoLines.text).toContain("one line");
    expect(running.tickets.get(1)?.difficultyReason).toBeNull();
  });

  it("forgets what was stated when an arrangement changes a chain's issues", async () => {
    const running = await start();
    await fileIssue(running, "Move the state", "搬动状态");
    await fileIssue(running, "Show the state", "显示状态");
    await stateDefaults(running);
    expect(running.tickets.get(1)?.difficultyReason).not.toBeNull();
    await callBrainTool(running, "arrange_chains", { chains: [{ name: "one", repository: sandbox, issues: [1] }] });
    expect(running.tickets.get(1)?.difficultyReason).not.toBeNull();
    await callBrainTool(running, "arrange_chains", {
      chains: [{ name: "both", repository: sandbox, issues: [1, 2], title: { en: "Both", zh: "两件" }, summary: { en: "Both.", zh: "两件。" } }],
    });
    expect(running.tickets.get(1)).toMatchObject({ difficultyReason: null, brainEngine: null });
    expect((await cardOf(running, 1)).choice.missing).toEqual(["defaults"]);
  });
});
