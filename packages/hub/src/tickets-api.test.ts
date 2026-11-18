import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, ServerMessage, TicketDetail, TicketHistory, TicketList } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import WebSocket from "ws";
import type { Hub } from "./hub.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { testCredentials } from "./testing/commands.js";
import { type FakeGitHub, fakeGitHub } from "./testing/github.js";
import { startTestHub } from "./testing/http.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let github: FakeGitHub;
let hub: Hub | undefined;
const sockets: WebSocket[] = [];

const sandbox = "novan-xu/super-agent-sandbox";

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-tickets-api-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  github = fakeGitHub();
  github.repositories.set(sandbox, []);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(): Promise<Hub> {
  hub = await startTestHub({
    config: testConfig(dataDir),
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [github],
    credentials: testCredentials,
  });
  return hub;
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function owner(running: Hub, path: string): Promise<Response> {
  return fetch(`${base(running)}${path}`, { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
}

async function pageSocket(running: Hub): Promise<ServerMessage[]> {
  const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, {
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) },
  });
  sockets.push(socket);
  const received: ServerMessage[] = [];
  socket.on("message", (data) => received.push(ServerMessage.parse(JSON.parse(String(data)))));
  await until(socket, () => received.some((message) => message.type === "tickets"));
  return Object.assign(received, { socket });
}

function until(socket: WebSocket, check: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (check()) {
      resolve();
      return;
    }
    const listener = () => {
      if (check()) {
        socket.off("message", listener);
        resolve();
      }
    };
    socket.on("message", listener);
  });
}

const fileArguments = {
  repository: sandbox,
  title: { en: "Print a greeting on start", zh: "启动时打印问候" },
  summary: { en: "The program greets the user when it starts.", zh: "程序启动时向用户问好。" },
  body: "## Goal\n\nPrint hello on start.\n\n## Assumptions\n\n- The greeting is in English.",
  kind: "feature",
};

describe("the brain's ticket tools", () => {
  it("are listed beside the command tools", async () => {
    const running = await start();
    const token = readFileSync(join(dataDir, "brain.token"), "utf8").trim();
    const response = await fetch(`${base(running)}${brainToolsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listed = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "run_command",
      "read_command",
      "stop_command",
      "read_quote",
      "set_topic_repository",
      "handover",
      "file_issue",
      "open_ticket",
      "open_task_ticket",
      "list_tickets",
      "read_ticket",
      "message_worker",
      "record_decision",
      "stop_ticket",
      "open_repair_ticket",
      "arrange_chains",
      "report_deployment",
      "proceed_ticket",
      "set_engine_row", "read_allowance",
      "choose_defaults",
      "merge_ticket",
      "guide_ticket",
      "describe_stuck",
      "remember",
      "recall",
      "forget",
      "read_topic_board",
      "read_topic_history",
      "search_topic_history",
      "read_seed_material",
    ]);
  });

  it("file an issue, list it, read it and stop it, and the page sees each change", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    const page = await pageSocket(running);
    expect(page.find((message) => message.type === "tickets")).toEqual({ type: "tickets", tickets: [], reviews: [] });

    const filed = await callBrainTool(running, "file_issue", fileArguments, conversation.id);
    expect(filed.isError).toBe(false);
    expect(filed.text).toContain(`Filed ${sandbox}#1`);
    expect(filed.text).toContain("opened ticket 1");
    expect(github.repositories.get(sandbox)?.[0]?.body).toBe(fileArguments.body);

    const socket = sockets[0]!;
    await until(socket, () => page.some((message) => message.type === "ticket" && message.ticket.id === 1));
    const update = page.find((message) => message.type === "ticket");
    expect(update?.type === "ticket" && update.ticket).toMatchObject({ state: "pending", title: { zh: "启动时打印问候" }, conversation: conversation.id });

    const listed = await callBrainTool(running, "list_tickets", {});
    expect(listed.text).toBe(`Ticket 1 [pending] feature in ${sandbox} (issues #1): Print a greeting on start`);

    const read = await callBrainTool(running, "read_ticket", { ticket: 1 });
    expect(read.text).toContain("Chinese title: 启动时打印问候");
    expect(read.text).toContain(`${sandbox}#1 Print a greeting on start (https://github.com/${sandbox}/issues/1)`);
    expect(read.text).toContain("filed -> pending");

    const stopped = await callBrainTool(running, "stop_ticket", { ticket: 1, reason: { en: "Only a test", zh: "只是测试" } });
    expect(stopped.isError).toBe(false);
    await until(socket, () => page.some((message) => message.type === "ticket" && message.ticket.state === "stopped"));
    expect((await callBrainTool(running, "stop_ticket", { ticket: 1, reason: { en: "Again", zh: "再一次" } })).text).toContain("is stopped and cannot be stopped");
    expect((await callBrainTool(running, "list_tickets", {})).text).toBe("There are no tickets.");
    expect((await callBrainTool(running, "list_tickets", { all: true })).text).toContain("Ticket 1 [stopped]");
    expect((await callBrainTool(running, "read_ticket", { ticket: 1 })).text).toContain("Stopped because: Only a test");
  });

  it("refuses arguments without a Chinese copy, and an unknown ticket", async () => {
    const running = await start();
    const bad = await callBrainTool(running, "file_issue", { ...fileArguments, title: { en: "Print a greeting", zh: "Print a greeting" } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("The arguments are not valid");
    expect(github.jobs).toEqual([]);
    expect((await callBrainTool(running, "read_ticket", { ticket: 5 })).text).toBe("There is no ticket 5.");
    expect((await callBrainTool(running, "stop_ticket", { ticket: 5, reason: { en: "x", zh: "停" } })).isError).toBe(true);
  });

  it("opens a ticket for an issue filed some other way", async () => {
    const running = await start();
    github.repositories.set(sandbox, [{ number: 1, title: "Fix the typo", body: "It says teh.", state: "open", pullRequest: false }]);
    const opened = await callBrainTool(running, "open_ticket", {
      repository: sandbox,
      issue: 1,
      title_zh: "修正错字",
      summary: { en: "Fix one typo.", zh: "修一个错字。" },
      kind: "parameter",
    });
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain("Used the existing issue");
    expect(running.tickets.get(1)).toMatchObject({ title: { en: "Fix the typo", zh: "修正错字" }, kind: "parameter" });
  });
});

describe("the brain's tool for task tickets", () => {
  const writingArguments = {
    title: { en: "Translate a notice", zh: "翻译一则通知" },
    summary: { en: "Translate the notice into English", zh: "把通知译成英文" },
    task: "Translate the notice into English.",
    kind: "writing",
    material: [
      { name: "notice.txt", source: "pasted by the owner in the conversation", text: "你好，世界。" },
      { name: "terms", source: "https://example.com/terms" },
    ],
  };

  it("opens a pending ticket with no repository and no issue, keeping the task and the material, and shows them on read", async () => {
    const running = await start();
    const conversation = running.conversations.create();
    const opened = await callBrainTool(running, "open_task_ticket", writingArguments, conversation.id);
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain("Opened task ticket 1");
    expect(github.jobs).toEqual([]);
    expect(running.tickets.get(1)).toMatchObject({ form: "task", kind: "writing", repository: null, issues: [], state: "pending", conversation: conversation.id, title: { zh: "翻译一则通知" } });
    expect(running.tickets.task(1)?.materials).toEqual([
      { name: "notice.txt", source: "pasted by the owner in the conversation", text: "你好，世界。" },
      { name: "terms", source: "https://example.com/terms", text: null },
    ]);
    const read = await callBrainTool(running, "read_ticket", { ticket: 1 });
    expect(read.text).toContain("Task: Translate the notice into English.");
    expect(read.text).toContain("Material notice.txt, from pasted by the owner in the conversation (6 characters given)");
    expect(read.text).toContain("Material terms, from https://example.com/terms (by its source only)");
    expect((await callBrainTool(running, "list_tickets", {})).text).toBe("Ticket 1 [pending] writing task in no repository: Translate a notice");
  });

  it("refuses a missing Chinese copy, an unsafe material name and repeated names, opening nothing", async () => {
    const running = await start();
    const refused = [
      { ...writingArguments, title: { en: "Translate a notice", zh: "Translate a notice" } },
      { ...writingArguments, material: [{ name: "../notice.txt", source: "pasted" }] },
      { ...writingArguments, material: [{ name: "a.txt", source: "pasted" }, { name: "a.txt", source: "pasted again" }] },
      { ...writingArguments, task: "  " },
    ];
    for (const args of refused) {
      expect((await callBrainTool(running, "open_task_ticket", args)).isError).toBe(true);
    }
    expect(running.tickets.list({})).toEqual([]);
  });

  it("takes any amount of material and a task of any length", async () => {
    const running = await start();
    const material = Array.from({ length: 25 }, (_, index) => ({ name: `piece-${index}.txt`, source: `pasted part ${index} ${"of a long source ".repeat(60)}`, text: "字".repeat(30_000) }));
    const opened = await callBrainTool(running, "open_task_ticket", { ...writingArguments, task: "Translate everything. ".repeat(2_000), material });
    expect(opened.isError, opened.text).toBe(false);
    expect(running.tickets.task(1)?.materials).toHaveLength(25);
  });
});

describe("tickets for the page", () => {
  it("lists the open tickets, or all, and reads one with its history", async () => {
    const running = await start();
    await callBrainTool(running, "file_issue", fileArguments);
    await callBrainTool(running, "file_issue", { ...fileArguments, body: "Another piece of work." });
    running.tickets.stop(1, { en: "Not needed", zh: "不需要了" });
    const open = TicketList.parse(await (await owner(running, "/api/tickets")).json());
    expect(open.tickets.map((ticket) => ticket.id)).toEqual([2]);
    const all = TicketList.parse(await (await owner(running, "/api/tickets?scope=all")).json());
    expect(all.tickets.map((ticket) => ticket.id).sort()).toEqual([1, 2]);
    const detail = TicketDetail.parse(await (await owner(running, "/api/tickets/1")).json());
    expect(detail.moves.map((move) => move.to)).toEqual(["pending", "stopped"]);
    expect(detail.ticket.stopReason?.zh).toBe("不需要了");
    expect((await owner(running, "/api/tickets/9")).status).toBe(404);
    expect((await owner(running, "/api/tickets/abc")).status).toBe(404);
    expect((await owner(running, "/api/tickets?scope=some")).status).toBe(404);
    expect((await fetch(`${base(running)}/api/tickets`)).status).toBe(403);
  });

  it("reads the history a page at a time, searches it, and refuses what it does not understand", async () => {
    const running = await start();
    for (let number = 1; number <= 5; number += 1) {
      const title = { en: `Piece ${number}`, zh: `第${number}件` };
      const summary = { en: number === 4 ? "Mentions the watering can" : "Plain work", zh: number === 4 ? "提到了浇水壶" : "普通工作" };
      const ticket = running.tickets.open({ repository: sandbox, issues: [{ repository: sandbox, number, url: `https://github.com/${sandbox}/issues/${number}`, title, summary }], title, summary, kind: "fix" });
      clock.advance(1000);
      running.tickets.stop(ticket.id, { en: "Not needed", zh: "不需要了" });
    }
    running.tickets.open({ repository: null, issues: [], title: { en: "Still open", zh: "还开着" }, summary: { en: "Open", zh: "开着" }, kind: "writing" });
    const read = async (query: string) => TicketHistory.parse(await (await owner(running, `/api/tickets?scope=ended${query}`)).json());
    const first = await read("&limit=2");
    expect(first.tickets.map((ticket) => ticket.id)).toEqual([5, 4]);
    expect(first.next).not.toBeNull();
    const second = await read(`&limit=2&before=${first.next}`);
    expect(second.tickets.map((ticket) => ticket.id)).toEqual([3, 2]);
    const last = await read(`&limit=2&before=${second.next}`);
    expect(last).toMatchObject({ next: null });
    expect(last.tickets.map((ticket) => ticket.id)).toEqual([1]);
    expect((await read("")).tickets.map((ticket) => ticket.id)).toEqual([5, 4, 3, 2, 1]);
    expect((await read(`&q=${encodeURIComponent("浇水壶")}`)).tickets.map((ticket) => ticket.id)).toEqual([4]);
    expect((await read(`&q=${encodeURIComponent("WATERING")}`)).tickets.map((ticket) => ticket.id)).toEqual([4]);
    expect((await read(`&q=${encodeURIComponent("super-agent-sandbox 第3")}`)).tickets.map((ticket) => ticket.id)).toEqual([3]);
    expect((await read(`&q=${encodeURIComponent("没有这个")}`)).tickets).toEqual([]);
    for (const bad of ["&limit=0", "&limit=x", "&before=abc", "&before=1.2.3", `&q=${"x".repeat(201)}`]) {
      expect((await owner(running, `/api/tickets?scope=ended${bad}`)).status).toBe(404);
    }
    expect((await fetch(`${base(running)}/api/tickets?scope=ended`)).status).toBe(403);
  });

  it("tells the page which tickets ended and when, so that it can place them in the history", async () => {
    const running = await start();
    await callBrainTool(running, "file_issue", fileArguments);
    const page = await pageSocket(running);
    const socket = sockets[0]!;
    running.tickets.move(1, "working");
    clock.advance(5000);
    running.tickets.move(1, "verifying");
    running.tickets.move(1, "merged");
    await until(socket, () => page.some((message) => message.type === "ticket" && message.ticket.state === "merged"));
    const ended = page.flatMap((message) => (message.type === "ticket" && message.ticket.state === "merged" ? [message.ticket] : []))[0];
    expect(ended).toMatchObject({ endedAt: clock.now(), joinedInto: null });
  });

  it("keeps a ticket and its state across a restart of the hub", async () => {
    const first = await start();
    await callBrainTool(first, "file_issue", fileArguments);
    first.tickets.move(1, "working");
    await first.close();
    hub = undefined;
    const second = await start();
    const page = await pageSocket(second);
    const snapshot = page.find((message) => message.type === "tickets");
    expect(snapshot?.type === "tickets" && snapshot.tickets.map((ticket) => [ticket.id, ticket.state, ticket.title.zh])).toEqual([[1, "working", "启动时打印问候"]]);
    expect((await callBrainTool(second, "file_issue", fileArguments)).text).toContain("already has ticket 1");
    expect(github.created).toBe(1);
  });
});
