import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, PushPayload, ServerMessage, type StartCard, TicketList, type WaitingCard, WaitingList } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Hub } from "./hub.js";
import { createPushDevice, receivePush } from "./push-device.js";
import { generateVapidKeys, type VapidKeys } from "./push.js";
import { chainStartPath } from "./server.js";
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

const work: TicketWork = {
  begin: (ticket) => {
    begun.push(ticket.id);
  },
  stop: () => undefined,
};

async function start(): Promise<Hub> {
  begun.splice(0);
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
  return hub;
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

function brainToken(): string {
  return readFileSync(join(dataDir, "brain.token"), "utf8").trim();
}

async function callTool(running: Hub, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const response = await fetch(`${base(running)}${brainToolsPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${brainToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { message: string } };
  if (reply.result === undefined) {
    return { isError: true, text: reply.error?.message ?? "" };
  }
  return { isError: reply.result.isError, text: reply.result.content.map((part) => part.text).join("") };
}

async function fileIssue(running: Hub, title: string, zh: string, repository = sandbox): Promise<void> {
  const filed = await callTool(running, "file_issue", {
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
  const cards = await startCards(running);
  return JSON.stringify({
    chains: tickets.map((ticket) => ({ ticket, fingerprint: cards.find((card) => card.ticket.id === ticket)?.fingerprint ?? "" })),
  });
}

async function fileThree(running: Hub): Promise<void> {
  await fileIssue(running, "Parse dates", "解析日期");
  await fileIssue(running, "Parse times", "解析时间");
  await fileIssue(running, "Write the guide", "写使用说明");
  const arranged = await callTool(running, "arrange_chains", {
    chains: [
      { name: "parser", repository: sandbox, issues: [1, 2], title: { en: "Parse dates and times", zh: "解析日期和时间" }, summary: { en: "Both change the parser.", zh: "两件都改解析器。" } },
      { name: "guide", repository: sandbox, issues: [3] },
    ],
  });
  expect(arranged.isError).toBe(false);
  expect(arranged.text).toContain("Chain parser is ticket 1");
  expect(arranged.text).toContain("Chain guide is ticket 3");
  expect(arranged.text).toContain("Closed as joined into other chains: ticket 2.");
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
    expect((await callTool(running, "read_ticket", { ticket: 1 })).text).toContain("pending -> working");
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
    await callTool(running, "arrange_chains", { chains: [{ name: "a", repository: sandbox, issues: [1] }, { name: "b", repository: sandbox, issues: [2], after: ["a"] }] });
    await running.push?.idle();
    expect(pushes.length).toBe(before);
  });

  it("refuses an arrangement with a cycle, and changes nothing", async () => {
    const running = await start();
    await fileIssue(running, "Parse dates", "解析日期");
    await fileIssue(running, "Parse times", "解析时间");
    const cards = await startCards(running);
    const refused = await callTool(running, "arrange_chains", {
      chains: [
        { name: "a", repository: sandbox, issues: [1], after: ["b"] },
        { name: "b", repository: sandbox, issues: [2], after: ["a"] },
      ],
    });
    expect(refused).toEqual({ isError: true, text: "Nothing was changed: it has a cycle: chain a waits for chain b waits for chain a" });
    expect(await startCards(running)).toEqual(cards);
    const missing = await callTool(running, "arrange_chains", { chains: [{ name: "a", repository: sandbox, issues: [1, 5], title: { en: "x", zh: "某事" }, summary: { en: "x", zh: "某事" } }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("#5");
    expect(await startCards(running)).toEqual(cards);
  });

  it("cuts a chain between two repositories, and the second begins by itself when the first merges", async () => {
    const running = await start();
    const inbox = await page(running);
    await fileIssue(running, "Add the endpoint", "加接口");
    await fileIssue(running, "Call the endpoint", "调用接口", other);
    const arranged = await callTool(running, "arrange_chains", {
      chains: [
        { name: "server", repository: sandbox, issues: [1] },
        { name: "client", repository: other, issues: [1], after: ["server"] },
      ],
    });
    expect(arranged.text).toContain("Chain client is ticket 2 in novan-xu/other-sandbox: #1; after ticket 1.");
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

  it("tells the brain, in the conversation the work was filed in, when a ticket before a waiting one stops", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    await fileIssue(running, "Add the endpoint", "加接口");
    await fileIssue(running, "Call the endpoint", "调用接口");
    await callTool(running, "arrange_chains", {
      chains: [
        { name: "server", repository: sandbox, issues: [1] },
        { name: "client", repository: sandbox, issues: [2], after: ["server"] },
      ],
    });
    expect((await startCall(running, { body: await startBody(running, 1) })).status).toBe(202);
    await callTool(running, "stop_ticket", { ticket: 1, reason: { en: "Wrong approach", zh: "方法不对" } });
    const notices = running.conversations.entries(conversation.id).filter((entry) => entry.kind === "notice");
    expect(notices.map((entry) => entry.kind === "notice" && entry.text)).toEqual(["工单 1 停止了，排在它后面的工单 2 由大脑决定是否继续"]);
    const proceeded = await callTool(running, "proceed_ticket", { ticket: 2 });
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
    expect(names.filter((name) => /start|begin/.test(name))).toEqual([]);
    expect((await callTool(running, "start_chain", { ticket: 1 })).text).toBe("Unknown tool: start_chain");
    expect((await callTool(running, "proceed_ticket", { ticket: 1 })).isError).toBe(true);
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
    await callTool(running, "arrange_chains", {
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
