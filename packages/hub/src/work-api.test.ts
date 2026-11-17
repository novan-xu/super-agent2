import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, type HubToRunner, type MachineReport, protocolVersion, ServerMessage, type Ticket, TicketResponse, type WorkEvent, WorkEventList } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Hub } from "./hub.js";
import type { RunnerLink } from "./runners.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

const sandbox = "novan-xu/super-agent-sandbox";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-work-api-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const report: MachineReport = {
  hostname: "pc",
  platform: "win32",
  release: "1",
  arch: "x64",
  user: "owner",
  slots: { total: 2, free: 2 },
  programs: [],
  allowances: [],
};

interface Started {
  readonly running: Hub;
  readonly ticket: Ticket;
  readonly runner: RunnerLink;
  readonly sent: HubToRunner[];
}

async function start(): Promise<Started> {
  const running = await startTestHub({ config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock, credentials: testCredentials });
  hub = running;
  running.machines.add({ name: "pc", accessClientId: "pc.access" });
  const machine = running.machines.get("pc");
  if (machine === undefined) {
    throw new Error("machine missing");
  }
  const sent: HubToRunner[] = [];
  const runner = running.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
  runner.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
  const summary = { en: "Print hello", zh: "打印问候" };
  const opened = running.tickets.open({
    repository: sandbox,
    issues: [{ repository: sandbox, number: 3, url: `https://github.com/${sandbox}/issues/3`, title: { en: "Greet", zh: "问候" }, summary }],
    title: { en: "Greet", zh: "问候" },
    summary,
    kind: "feature",
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
  return { running, ticket, runner, sent };
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function owner(running: Hub, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), ...(init.headers as Record<string, string> | undefined) },
  });
}

function post(running: Hub, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return owner(running, path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: base(running), ...headers } });
}

function event(runner: RunnerLink, ticket: number, seq: number, body: WorkEvent): void {
  runner.receive({ type: "work.event", ticket, attempt: 1, seq, at: clock.now(), event: body });
}

async function callTool(running: Hub, name: string, args: Record<string, unknown>): Promise<{ readonly isError: boolean; readonly text: string }> {
  const token = readFileSync(join(dataDir, "brain.token"), "utf8").trim();
  const response = await fetch(`${base(running)}${brainToolsPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
  return { isError: reply.result.isError, text: reply.result.content.map((part) => part.text).join("") };
}

describe("a ticket's worker for the page and the brain", () => {
  it("sends the runner its task, and serves the worker's output over HTTP and the page's socket", async () => {
    const { running, ticket, runner, sent } = await start();
    expect(sent.filter((message) => message.type === "work.start")).toHaveLength(1);
    event(runner, ticket.id, 1, { kind: "phase", phase: "started", detail: "Started" });
    event(runner, ticket.id, 2, { kind: "text", block: "b", delta: "Reading the issue" });
    const listed = WorkEventList.parse(await (await owner(running, `/api/tickets/${ticket.id}/work`)).json());
    expect(listed.events.map((entry) => entry.event.kind)).toEqual(["phase", "text"]);
    const after = WorkEventList.parse(await (await owner(running, `/api/tickets/${ticket.id}/work?after=${listed.events[0]?.id ?? 0}`)).json());
    expect(after.events.map((entry) => entry.seq)).toEqual([2]);
    expect((await owner(running, "/api/tickets/99/work")).status).toBe(404);
    const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    sockets.push(socket);
    const received: ServerMessage[] = [];
    const arrived = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (received.filter((message) => message.type === "work").length >= count) {
            socket.off("message", check);
            resolve();
          }
        };
        socket.on("message", check);
        check();
      });
    socket.on("message", (data) => received.push(ServerMessage.parse(JSON.parse(String(data)))));
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send(JSON.stringify({ type: "watch.ticket", ticket: ticket.id, after: 0 }));
    await arrived(2);
    event(runner, ticket.id, 3, { kind: "text", block: "b", delta: " and writing" });
    await arrived(3);
    const work = received.flatMap((message) => (message.type === "work" ? [message.event] : []));
    expect(work.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(received.some((message) => message.type === "tickets" && message.tickets.some((entry) => entry.work?.state === "running"))).toBe(true);
  });

  it("passes the owner's message to the running worker, with the owner's checks", async () => {
    const { running, ticket, sent } = await start();
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "hi" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "hi" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "" })).status).toBe(400);
    const answer = await post(running, `/api/tickets/${ticket.id}/messages`, { text: "Use the short greeting" });
    expect(answer.status).toBe(202);
    const { id } = (await answer.json()) as { id: string };
    expect(sent.filter((message) => message.type === "work.message")).toEqual([{ type: "work.message", ticket: ticket.id, attempt: 1, id, from: "owner", text: "Use the short greeting" }]);
  });

  it("lets the brain message the worker and read its output with the ticket", async () => {
    const { running, ticket, runner, sent } = await start();
    event(runner, ticket.id, 1, { kind: "text", block: "b", delta: "Looking at greet.ts" });
    const told = await callTool(running, "message_worker", { ticket: ticket.id, text: "Keep it to one line" });
    expect(told.isError).toBe(false);
    expect(sent.filter((message) => message.type === "work.message").map((message) => (message.type === "work.message" ? message.from : ""))).toEqual(["brain"]);
    const read = await callTool(running, "read_ticket", { ticket: ticket.id });
    expect(read.text).toContain("Worker: attempt 1 on pc with claude claude-haiku-5-5 low is preparing");
    expect(read.text).toContain("Looking at greet.ts");
  });

  it("stops the ticket for the owner, which stops the worker and removes its worktree", async () => {
    const { running, ticket, sent } = await start();
    const answer = await post(running, `/api/tickets/${ticket.id}/stop`, {});
    expect(answer.status).toBe(202);
    const stopped = TicketResponse.parse(await answer.json()).ticket;
    expect(stopped).toMatchObject({ state: "stopped", stopReason: { en: "The owner stopped it", zh: "你停止了它" }, work: { state: "stopped" } });
    expect(sent.filter((message) => message.type === "work.stop")).toEqual([{ type: "work.stop", ticket: ticket.id, save: false, remove: true }]);
    expect((await post(running, `/api/tickets/${ticket.id}/stop`, {})).status).toBe(409);
    expect((await post(running, `/api/tickets/${ticket.id}/messages`, { text: "hi" })).status).toBe(409);
  });
});
