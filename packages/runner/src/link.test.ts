import {
  accessClientIdHeader,
  accessClientSecretHeader,
  type MachineReport,
  protocolVersion,
  runnerCloseCodes,
  RunnerToHub,
  runnerTokenHeader,
} from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { RunnerConfig } from "./config.js";
import { type Connect, createRunnerLink, type LinkEvent, type LinkSocketEvents, linkUrl } from "./link.js";
import type { ShellEnd, ShellJob, ShellSink } from "./shell.js";

const config: RunnerConfig = {
  hub: "https://agent.example.com",
  name: "pc",
  accessClientId: "id.access",
  accessClientSecret: "client-secret",
  runnerToken: "t".repeat(43),
  slots: 2,
  models: {},
};

const report: MachineReport = {
  hostname: "pc",
  platform: "win32",
  release: "10",
  arch: "x64",
  user: "owner",
  slots: { total: 2, free: 2 },
  programs: [],
  allowances: [],
};

interface FakeSocket {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly events: LinkSocketEvents;
  readonly sent: RunnerToHub[];
  closed: boolean;
}

function fakeHub() {
  const sockets: FakeSocket[] = [];
  const waiting = new Set<() => void>();
  const wake = () => {
    for (const check of [...waiting]) {
      check();
    }
  };
  const connect: Connect = (url, headers, events) => {
    const socket: FakeSocket = { url, headers, events, sent: [], closed: false };
    sockets.push(socket);
    wake();
    return {
      send: (text) => {
        socket.sent.push(RunnerToHub.parse(JSON.parse(text)));
        wake();
      },
      close: () => {
        socket.closed = true;
        wake();
      },
      terminate: () => {
        socket.closed = true;
        wake();
      },
    };
  };
  const until = <T>(find: () => T | undefined): Promise<T> =>
    new Promise((resolve) => {
      const check = () => {
        const found = find();
        if (found !== undefined) {
          waiting.delete(check);
          resolve(found);
        }
      };
      waiting.add(check);
      check();
    });
  return { sockets, connect, until, wake };
}

interface FakeRun {
  readonly job: ShellJob;
  readonly sink: ShellSink;
  stopped: boolean;
  finish(end: ShellEnd): void;
}

function fakeShell() {
  const runs: FakeRun[] = [];
  return {
    runs,
    execute: (job: ShellJob, sink: ShellSink) => {
      let finish: (end: ShellEnd) => void = () => undefined;
      const ended = new Promise<ShellEnd>((resolve) => {
        finish = resolve;
      });
      const run: FakeRun = { job, sink, stopped: false, finish: (end) => finish(end) };
      runs.push(run);
      return {
        pid: 4242,
        ended,
        stop: async () => {
          run.stopped = true;
          finish({ exitCode: null, signal: "SIGKILL" });
        },
      };
    },
  };
}

describe("the runner's link", () => {
  it("connects with both credentials, says hello and runs what the hub sends", async () => {
    const hub = fakeHub();
    const shell = fakeShell();
    const events: LinkEvent[] = [];
    const link = createRunnerLink({ config, report: () => report, execute: shell.execute, connect: hub.connect, retryDelay: () => 0, onEvent: (event) => events.push(event) });
    link.start();
    const socket = await hub.until(() => hub.sockets[0]);
    expect(socket.url).toBe("wss://agent.example.com/runner/link");
    expect(socket.headers).toEqual({ [accessClientIdHeader]: "id.access", [accessClientSecretHeader]: "client-secret", [runnerTokenHeader]: "t".repeat(43) });
    socket.events.open();
    expect(socket.sent).toEqual([{ type: "hello", protocol: protocolVersion, machine: report, works: [] }]);
    socket.events.message(JSON.stringify({ type: "welcome", protocol: protocolVersion, name: "pc" }));
    expect(link.connected()).toBe(true);
    socket.events.message(JSON.stringify({ type: "run", id: "c1", command: "echo hi", cwd: null, environment: { GH_TOKEN: "x" } }));
    const run = shell.runs[0];
    expect(run?.job).toEqual({ command: "echo hi", cwd: null, environment: { GH_TOKEN: "x" } });
    run?.sink("stdout", Buffer.from("hi\n"));
    run?.finish({ exitCode: 0, signal: null });
    await hub.until(() => socket.sent.find((message) => message.type === "ended"));
    expect(socket.sent.slice(1)).toEqual([
      { type: "output", id: "c1", stream: "stdout", data: Buffer.from("hi\n").toString("base64") },
      { type: "ended", id: "c1", exitCode: 0, signal: null },
    ]);
    expect(link.running()).toEqual([]);
    link.update();
    expect(socket.sent.at(-1)).toEqual({ type: "report", machine: report });
    await link.close();
    expect(socket.closed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["connecting", "connected", "started", "ended"]);
  });

  it("stops a command when the hub asks", async () => {
    const hub = fakeHub();
    const shell = fakeShell();
    const link = createRunnerLink({ config, report: () => report, execute: shell.execute, connect: hub.connect, retryDelay: () => 0 });
    link.start();
    const socket = await hub.until(() => hub.sockets[0]);
    socket.events.open();
    socket.events.message(JSON.stringify({ type: "run", id: "c1", command: "sleep", cwd: null, environment: {} }));
    socket.events.message(JSON.stringify({ type: "stop", id: "c1" }));
    const ended = await hub.until(() => socket.sent.find((message) => message.type === "ended"));
    expect(ended).toEqual({ type: "ended", id: "c1", exitCode: null, signal: "SIGKILL" });
    expect(shell.runs[0]?.stopped).toBe(true);
    await link.close();
  });

  it("reports a command that cannot start", async () => {
    const hub = fakeHub();
    const link = createRunnerLink({
      config,
      report: () => report,
      execute: () => ({ pid: undefined, ended: Promise.reject(new Error("The folder Z:\\x does not exist on this machine")), stop: async () => undefined }),
      connect: hub.connect,
      retryDelay: () => 0,
    });
    link.start();
    const socket = await hub.until(() => hub.sockets[0]);
    socket.events.open();
    socket.events.message(JSON.stringify({ type: "run", id: "c1", command: "x", cwd: "Z:\\x", environment: {} }));
    expect(await hub.until(() => socket.sent.find((message) => message.type === "failed"))).toEqual({
      type: "failed",
      id: "c1",
      reason: "The folder Z:\\x does not exist on this machine",
    });
    await link.close();
  });

  it("stops every command when the connection drops and connects again by itself", async () => {
    const hub = fakeHub();
    const shell = fakeShell();
    const delays: number[] = [];
    const link = createRunnerLink({
      config,
      report: () => report,
      execute: shell.execute,
      connect: hub.connect,
      retryDelay: (attempt) => {
        delays.push(attempt);
        return 0;
      },
    });
    link.start();
    const first = await hub.until(() => hub.sockets[0]);
    first.events.open();
    first.events.message(JSON.stringify({ type: "welcome", protocol: protocolVersion, name: "pc" }));
    first.events.message(JSON.stringify({ type: "run", id: "c1", command: "sleep", cwd: null, environment: {} }));
    first.events.message(JSON.stringify({ type: "run", id: "c2", command: "sleep", cwd: null, environment: {} }));
    first.events.close(1006, "");
    expect(shell.runs.every((run) => run.stopped)).toBe(true);
    expect(link.connected()).toBe(false);
    const second = await hub.until(() => hub.sockets[1]);
    second.events.refused(403);
    second.events.close(1006, "");
    const third = await hub.until(() => hub.sockets[2]);
    third.events.open();
    expect(third.sent[0]?.type).toBe("hello");
    third.events.message(JSON.stringify({ type: "welcome", protocol: protocolVersion, name: "pc" }));
    third.events.close(runnerCloseCodes.revoked, "revoked");
    await hub.until(() => hub.sockets[3]);
    expect(delays).toEqual([0, 1, 5]);
    expect(first.sent.filter((message) => message.type === "ended")).toEqual([]);
    await link.close();
  });

  it("lists its workers in its hello, hands work messages to them, and keeps them running when the link drops", async () => {
    const hub = fakeHub();
    const shell = fakeShell();
    const received: unknown[] = [];
    const works = {
      held: () => [{ ticket: 4, attempt: 2, last: 17, live: true, ended: false }],
      busy: () => 1,
      receive: (message: unknown) => void received.push(message),
      disconnected: () => undefined,
      idle: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const link = createRunnerLink({ config, report: () => report, execute: shell.execute, connect: hub.connect, retryDelay: () => 0, works: () => works });
    link.start();
    const socket = await hub.until(() => hub.sockets[0]);
    socket.events.open();
    expect(socket.sent).toEqual([{ type: "hello", protocol: protocolVersion, machine: report, works: [{ ticket: 4, attempt: 2, last: 17, live: true, ended: false }] }]);
    socket.events.message(JSON.stringify({ type: "welcome", protocol: protocolVersion, name: "pc" }));
    socket.events.message(JSON.stringify({ type: "work.sync", ticket: 4, attempt: 2, after: 10 }));
    socket.events.message(JSON.stringify({ type: "work.stop", ticket: 4, save: false, remove: true }));
    expect(received).toEqual([
      { type: "work.sync", ticket: 4, attempt: 2, after: 10 },
      { type: "work.stop", ticket: 4, save: false, remove: true },
    ]);
    link.send({ type: "work.event", ticket: 4, attempt: 2, seq: 18, at: 1, event: { kind: "text", block: "b", delta: "x" } });
    expect(socket.sent.at(-1)).toMatchObject({ type: "work.event", seq: 18 });
    socket.events.close(1006, "");
    expect(received).toHaveLength(2);
    await link.close();
  });

  it("builds the link address from the hub's address", () => {
    expect(linkUrl("https://agent.example.com")).toBe("wss://agent.example.com/runner/link");
    expect(linkUrl("http://127.0.0.1:5180/")).toBe("ws://127.0.0.1:5180/runner/link");
  });
});
