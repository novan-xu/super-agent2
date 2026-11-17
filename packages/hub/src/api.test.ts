import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandList, CommandResponse, OutputResponse, ServerMessage } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Hub, startHub } from "./hub.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { nodeScript, recordingTarget, testCredentials, testEnvironment, waitForFile, waitForOutput } from "./testing/commands.js";

let dataDir: string;
let workDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-api-"));
  workDir = mkdtempSync(join(tmpdir(), "hub-api-work-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

async function start(): Promise<Hub> {
  hub = await startHub({
    config: testConfig(dataDir),
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [recordingTarget("hub", testEnvironment())],
    credentials: testCredentials,
  });
  return hub;
}

async function call(running: Hub, path: string, init: RequestInit = {}, signedIn = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (signedIn) {
    headers.set("Cf-Access-Jwt-Assertion", await assertion({ key, clock }));
  }
  return fetch(`http://127.0.0.1:${running.address.port}${path}`, { ...init, headers });
}

function gatedCommand(gate: string): string {
  return nodeScript(
    workDir,
    `${waitForFile}
console.log("before");
await until(${JSON.stringify(gate)});
console.log("after");
`,
  );
}

class Inbox {
  private readonly messages: ServerMessage[] = [];
  private readonly waiting = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      this.messages.push(ServerMessage.parse(JSON.parse(String(data))));
      for (const wake of this.waiting) {
        wake();
      }
    });
  }

  all(): readonly ServerMessage[] {
    return this.messages;
  }

  until(predicate: (messages: readonly ServerMessage[]) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (predicate(this.messages)) {
          this.waiting.delete(check);
          resolve();
        }
      };
      this.waiting.add(check);
      check();
    });
  }
}

async function open(running: Hub): Promise<Inbox> {
  const token = await assertion({ key, clock });
  const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, { headers: { "Cf-Access-Jwt-Assertion": token } });
  const inbox = new Inbox(socket);
  await inbox.until((messages) => messages.some((message) => message.type === "hello"));
  return inbox;
}

function outputText(messages: readonly ServerMessage[], id: string): string {
  return messages
    .flatMap((message) => (message.type === "output" && message.chunk.command === id ? [message.chunk.data] : []))
    .join("");
}

describe("commands over HTTP", () => {
  it("lists a command, reads it and its output", async () => {
    const running = await start();
    const { id } = running.commands.start({ target: "hub", command: nodeScript(workDir, `console.log("listed");`) });
    await running.commands.finished(id);
    const list = CommandList.parse(await (await call(running, "/api/commands")).json());
    expect(list.commands.map((command) => command.id)).toEqual([id]);
    const one = CommandResponse.parse(await (await call(running, `/api/commands/${id}`)).json());
    expect(one.command).toMatchObject({ id, state: "exited", exitCode: 0 });
    const output = OutputResponse.parse(await (await call(running, `/api/commands/${id}/output`)).json());
    expect(output.chunks.map((chunk) => chunk.data).join("").trim()).toBe("listed");
    const later = OutputResponse.parse(await (await call(running, `/api/commands/${id}/output?after=1`)).json());
    expect(later.chunks).toEqual([]);
  });

  it("stops a running command", async () => {
    const running = await start();
    const { id } = running.commands.start({ target: "hub", command: gatedCommand(join(workDir, "never")) });
    await waitForOutput(running.commands, id, "before");
    const refused = await call(running, `/api/commands/${id}/stop`, { method: "POST" });
    expect(refused.status).toBe(415);
    expect(running.commands.get(id)?.state).toBe("running");
    const accepted = await call(running, `/api/commands/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(accepted.status).toBe(202);
    expect((await running.commands.finished(id))?.state).toBe("stopped");
  });

  it("answers not found for an unknown command or a bad parameter", async () => {
    const running = await start();
    const { id } = running.commands.start({ target: "hub", command: nodeScript(workDir, "") });
    await running.commands.finished(id);
    expect((await call(running, "/api/commands/unknown")).status).toBe(404);
    expect((await call(running, "/api/commands/unknown/output")).status).toBe(404);
    expect((await call(running, `/api/commands/${id}/output?after=x`)).status).toBe(404);
    expect((await call(running, "/api/commands?limit=-1")).status).toBe(404);
    expect((await call(running, `/api/commands/${id}/stop`)).status).toBe(404);
  });

  it("refuses everything without a sign-in", async () => {
    const running = await start();
    const { id } = running.commands.start({ target: "hub", command: nodeScript(workDir, "") });
    await running.commands.finished(id);
    for (const path of ["/api/commands", `/api/commands/${id}`, `/api/commands/${id}/output`]) {
      expect((await call(running, path, {}, false)).status).toBe(403);
    }
    expect((await call(running, `/api/commands/${id}/stop`, { method: "POST" }, false)).status).toBe(403);
  });
});

describe("commands over the WebSocket", () => {
  it("tells every page about commands and streams the output of a followed one as it is produced", async () => {
    const running = await start();
    const inbox = await open(running);
    const gate = join(workDir, "gate");
    const { id } = running.commands.start({ target: "hub", command: gatedCommand(gate) });
    await waitForOutput(running.commands, id, "before");
    await inbox.until((messages) =>
      messages.some((message) => message.type === "command" && message.command.id === id && message.command.state === "running"),
    );
    inbox.socket.send(JSON.stringify({ type: "follow", command: id }));
    await inbox.until((messages) => outputText(messages, id).includes("before"));
    expect(running.commands.get(id)?.state).toBe("running");
    writeFileSync(gate, "");
    await inbox.until((messages) =>
      messages.some((message) => message.type === "command" && message.command.id === id && message.command.state === "exited"),
    );
    expect(outputText(inbox.all(), id)).toMatch(/^before\r?\nafter\r?\n$/);
    inbox.socket.close();
  });

  it("closes a socket that sends something it does not understand", async () => {
    const running = await start();
    const inbox = await open(running);
    const closed = new Promise<number>((resolve) => inbox.socket.once("close", (code) => resolve(code)));
    inbox.socket.send(JSON.stringify({ type: "run", command: "anything" }));
    expect(await closed).toBe(1008);
  });
});

describe("restart", () => {
  it("records a command running when the hub stopped as interrupted, and keeps it", async () => {
    const first = await start();
    const { id } = first.commands.start({ target: "hub", command: gatedCommand(join(workDir, "never")) });
    await waitForOutput(first.commands, id, "before");
    await first.close();
    hub = undefined;
    const second = await start();
    expect(second.commands.get(id)).toMatchObject({ state: "interrupted" });
    expect(second.commands.output(id).map((chunk) => chunk.data).join("")).toContain("before");
  });
});
