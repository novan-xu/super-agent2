import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { brainToolsPath, type HubToBrain, type HubToRunner, type MachineReport, protocolVersion, storedName, type Ticket } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-attachments-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
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

async function started(): Promise<Hub> {
  const running = await startTestHub({ config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock, credentials: testCredentials });
  hub = running;
  return running;
}

function base(running: Hub): string {
  return `http://127.0.0.1:${running.address.port}`;
}

async function owner(running: Hub, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base(running)}${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), origin: base(running), ...(init.headers as Record<string, string> | undefined) },
  });
}

function json(running: Hub, path: string, body: unknown, method = "POST"): Promise<Response> {
  return owner(running, path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function part(running: Hub, id: string, offset: number, data: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return owner(running, `/api/attachments/${id}/upload?offset=${offset}`, { method: "PUT", body: data, headers: { "content-type": "application/octet-stream", ...headers } });
}

async function created(running: Hub, name: string, data: Uint8Array, mediaType: string): Promise<string> {
  const response = await json(running, "/api/attachments", { name, size: data.length, mediaType });
  expect(response.status).toBe(201);
  return ((await response.json()) as { attachment: { id: string } }).attachment.id;
}

async function uploaded(running: Hub, name: string, data: Uint8Array, mediaType: string): Promise<string> {
  const id = await created(running, name, data, mediaType);
  expect((await part(running, id, 0, data)).status).toBe(200);
  return id;
}

describe("attachments for the owner", () => {
  it("are uploaded in parts, resume where they stopped, and keep the owner's name out of the path", async () => {
    const running = await started();
    const data = new TextEncoder().encode("abcdefghij");
    const name = "..\\..\\evil:name?.txt";
    const id = await created(running, name, data, "text/plain");
    expect((await part(running, id, 0, data.subarray(0, 4))).status).toBe(200);
    const gap = await part(running, id, 6, data.subarray(6));
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ received: 4 });
    const state = await owner(running, `/api/attachments/${id}/upload`);
    expect(await state.json()).toMatchObject({ received: 4, attachment: { id, name, size: 10 } });
    expect((await owner(running, `/api/attachments/${id}`)).status).toBe(404);
    expect((await part(running, id, 2, data.subarray(2, 8))).status).toBe(200);
    const beyond = await part(running, id, 8, new TextEncoder().encode("0123"));
    expect(beyond.status).toBe(400);
    expect(running.attachments.received(id)).toBe(8);
    expect((await part(running, id, 8, data.subarray(8))).status).toBe(200);
    const attachment = running.attachments.get(id);
    if (attachment === undefined) {
      throw new Error("missing");
    }
    const file = running.attachments.path(attachment);
    expect(readFileSync(file, "utf8")).toBe("abcdefghij");
    expect(relative(running.attachments.root, file).split(/[\\/]/)).toEqual([id, storedName(name)]);
    expect(storedName(name)).not.toMatch(/[\\/:?]/);
  });

  it("are only uploaded from the page itself, as raw bytes", async () => {
    const running = await started();
    const data = new Uint8Array([1, 2, 3]);
    const id = await created(running, "a.bin", data, "");
    expect((await part(running, id, 0, data, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await part(running, id, 0, data, { "content-type": "text/plain" })).status).toBe(415);
    expect((await owner(running, "/api/attachments", { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "https://elsewhere.example" } })).status).toBe(403);
    const anonymous = await fetch(`${base(running)}/api/attachments/${id}/upload?offset=0`, { method: "PUT", body: data, headers: { "content-type": "application/octet-stream", origin: base(running) } });
    expect(anonymous.status).toBe(403);
    expect(running.attachments.get(id)?.mediaType).toBe("application/octet-stream");
  });

  it("are served as downloads that never run as a page, images shown as images", async () => {
    const running = await started();
    const page = await uploaded(running, "page.html", new TextEncoder().encode("<script>alert(1)</script>"), "text/html");
    const served = await owner(running, `/api/attachments/${page}`);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toContain("attachment;");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(await served.text()).toBe("<script>alert(1)</script>");
    const image = await uploaded(running, "照片.png", new Uint8Array([137, 80, 78, 71]), "image/png");
    const shown = await owner(running, `/api/attachments/${image}`);
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect(shown.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("照片.png")}`);
  });

  it("go with a message to the brain, which learns where each one is, and a message may be attachments alone", async () => {
    const running = await started();
    const sentToBrain: HubToBrain[] = [];
    const link = running.conversations.attach({ send: (message) => void sentToBrain.push(message), close: () => undefined });
    link.receive({ type: "hello", protocol: protocolVersion, running: [] });
    const conversation = running.conversations.create();
    const half = await created(running, "half.txt", new Uint8Array([1, 2]), "text/plain");
    expect((await json(running, `/api/conversations/${conversation.id}/messages`, { text: "", attachments: [] })).status).toBe(400);
    expect((await json(running, `/api/conversations/${conversation.id}/messages`, { text: "看", attachments: [half] })).status).toBe(409);
    const photo = await uploaded(running, "photo.jpg", new Uint8Array([255, 216, 255]), "image/jpeg");
    const answer = await json(running, `/api/conversations/${conversation.id}/messages`, { text: "", attachments: [photo] });
    expect(answer.status).toBe(202);
    const { entry } = (await answer.json()) as { entry: { text: string; attachments: { id: string }[] } };
    expect(entry).toMatchObject({ text: "", attachments: [{ id: photo, name: "photo.jpg", size: 3, mediaType: "image/jpeg" }] });
    expect(running.conversations.get(conversation.id)?.title).toBe("photo.jpg");
    const input = sentToBrain.find((message) => message.type === "input");
    expect(input).toMatchObject({ type: "input", input: { text: "", attachments: [{ id: photo, path: `${photo}/photo.jpg` }] } });
  });
});

describe("attachments for a ticket's worker", () => {
  async function working(running: Hub): Promise<{ readonly ticket: Ticket; readonly runner: RunnerLink; readonly sent: HubToRunner[] }> {
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
    return { ticket, runner, sent };
  }

  it("reach the worker's machine in parts it asks for, only for the ticket they were given to", async () => {
    const running = await started();
    const { ticket, runner, sent } = await working(running);
    const data = new TextEncoder().encode("the code word");
    const id = await uploaded(running, "note.txt", data, "text/plain");
    const other = await uploaded(running, "other.txt", data, "text/plain");
    const answer = await json(running, `/api/tickets/${ticket.id}/messages`, { text: "", attachments: [id] });
    expect(answer.status).toBe(202);
    const message = sent.find((item) => item.type === "work.message");
    expect(message).toMatchObject({ type: "work.message", ticket: ticket.id, attempt: 1, text: "", attachments: [{ id, name: "note.txt", size: data.length }] });
    const reply = (asked: string, offset: number, length: number) =>
      new Promise<HubToRunner>((resolve) => {
        const before = sent.length;
        runner.receive({ type: "work.attachment", ticket: ticket.id, attempt: 1, attachment: asked, offset, length });
        const check = () => {
          const found = sent.slice(before).find((item) => item.type === "work.attachment.part");
          if (found !== undefined) {
            resolve(found);
          } else {
            setImmediate(check);
          }
        };
        check();
      });
    const first = await reply(id, 0, 4);
    expect(first).toMatchObject({ type: "work.attachment.part", attachment: id, offset: 0, data: Buffer.from("the ").toString("base64"), problem: null });
    const rest = await reply(id, 4, 1000);
    expect(rest).toMatchObject({ data: Buffer.from("code word").toString("base64") });
    const refused = await reply(other, 0, 4);
    expect(refused).toMatchObject({ data: null });
  });

  it("keep a message for a machine that is away and give it again when the machine is back, until the worker has it", async () => {
    const running = await started();
    const { ticket, runner, sent } = await working(running);
    runner.closed();
    const id = await uploaded(running, "photo.png", new Uint8Array([137, 80]), "image/png");
    const answer = await json(running, `/api/tickets/${ticket.id}/messages`, { text: "look", attachments: [id] });
    expect(answer.status).toBe(202);
    const { id: messageId } = (await answer.json()) as { id: string };
    const machine = running.machines.get("pc");
    if (machine === undefined) {
      throw new Error("machine missing");
    }
    const back: HubToRunner[] = [];
    const again = running.runners.attach(machine, { send: (message) => void back.push(message), close: () => undefined });
    again.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [{ ticket: ticket.id, attempt: 1, last: 0, live: true, ended: false }] });
    expect(back.filter((message) => message.type === "work.message")).toMatchObject([{ id: messageId, text: "look", attachments: [{ id }] }]);
    again.receive({ type: "work.event", ticket: ticket.id, attempt: 1, seq: 1, at: clock.now(), event: { kind: "message", id: messageId, from: "owner", text: "look", attachments: [running.attachments.get(id) ?? { id, name: "", size: 0, mediaType: "" }], delivery: "steered" } });
    const later: HubToRunner[] = [];
    const third = running.runners.attach(machine, { send: (message) => void later.push(message), close: () => undefined });
    third.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [{ ticket: ticket.id, attempt: 1, last: 1, live: true, ended: false }] });
    expect(later.filter((message) => message.type === "work.message")).toEqual([]);
    expect(sent.filter((message) => message.type === "work.message")).toEqual([]);
  });

  it("can be named by the brain as a writing ticket's material, so the file itself reaches the worker", async () => {
    const running = await started();
    const conversation = running.conversations.create();
    const id = await uploaded(running, "合同.pdf", new Uint8Array([37, 80, 68, 70]), "application/pdf");
    const token = readFileSync(join(dataDir, "brain.token"), "utf8").trim();
    const response = await fetch(`${base(running)}${brainToolsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-super-agent-conversation": conversation.id },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "open_writing_ticket",
          arguments: {
            title: { en: "Summarise the contract", zh: "总结合同" },
            summary: { en: "A summary", zh: "一份总结" },
            task: "Summarise input/contract.pdf in Chinese.",
            material: [{ name: "contract.pdf", source: "attached by the owner in the conversation", attachment: id }],
          },
        },
      }),
    });
    const reply = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(reply.result.isError).toBe(false);
    expect(running.tickets.writing(1)?.materials).toEqual([{ name: "contract.pdf", source: "attached by the owner in the conversation", text: null, attachment: running.attachments.get(id) }]);
    expect(running.attachments.granted(1, id)).toBe(true);
    expect(existsSync(running.attachments.root)).toBe(true);
  });
});
