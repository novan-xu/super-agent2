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

describe("the runner's link", () => {
  it("connects with both credentials, says hello, and reports its machine once welcomed", async () => {
    const hub = fakeHub();
    const events: LinkEvent[] = [];
    const link = createRunnerLink({ config, report: () => report, connect: hub.connect, retryDelay: () => 0, onEvent: (event) => events.push(event) });
    link.start();
    const socket = await hub.until(() => hub.sockets[0]);
    expect(socket.url).toBe("wss://agent.example.com/runner/link");
    expect(socket.headers).toEqual({ [accessClientIdHeader]: "id.access", [accessClientSecretHeader]: "client-secret", [runnerTokenHeader]: "t".repeat(43) });
    socket.events.open();
    expect(socket.sent).toEqual([{ type: "hello", protocol: protocolVersion, machine: report, works: [] }]);
    socket.events.message(JSON.stringify({ type: "welcome", protocol: protocolVersion, name: "pc" }));
    expect(link.connected()).toBe(true);
    link.update();
    expect(socket.sent.at(-1)).toEqual({ type: "report", machine: report });
    await link.close();
    expect(socket.closed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["connecting", "connected"]);
  });

  it("runs no command the hub sends, and ignores a kind of message it does not know without dropping the link", async () => {
    const hub = fakeHub();
    const events: LinkEvent[] = [];
    const received: unknown[] = [];
    const works = {
      held: () => [],
      busy: () => 0,
      receive: (message: unknown) => void received.push(message),
      disconnected: () => undefined,
      idle: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const link = createRunnerLink({ config, report: () => report, connect: hub.connect, retryDelay: () => 0, onEvent: (event) => events.push(event), works: () => works });
    link.start();
    const socket = await hub.until(() => hub.sockets[0]);
    socket.events.open();
    socket.events.message(JSON.stringify({ type: "welcome", protocol: protocolVersion, name: "pc" }));
    socket.events.message(JSON.stringify({ type: "run", id: "c1", command: "echo hi", cwd: null, environment: { GH_TOKEN: "x" } }));
    socket.events.message(JSON.stringify({ type: "run", id: "c2", command: "echo again", cwd: null, environment: {} }));
    socket.events.message(JSON.stringify({ type: "work.later", ticket: 4 }));
    expect(socket.closed).toBe(false);
    expect(socket.sent.map((message) => message.type)).toEqual(["hello"]);
    expect(received).toEqual([]);
    expect(events.filter((event) => event.type === "ignored")).toEqual([
      { type: "ignored", kind: "run" },
      { type: "ignored", kind: "work.later" },
    ]);
    socket.events.message(JSON.stringify({ type: "work.sync", ticket: 4 }));
    expect(socket.closed).toBe(true);
    await link.close();
  });

  it("connects again by itself when the connection drops, waiting longer after a revocation", async () => {
    const hub = fakeHub();
    const delays: number[] = [];
    const link = createRunnerLink({
      config,
      report: () => report,
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
    first.events.close(1006, "");
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
    await link.close();
  });

  it("lists its workers in its hello, hands work messages to them, and keeps them running when the link drops", async () => {
    const hub = fakeHub();
    const received: unknown[] = [];
    const works = {
      held: () => [{ ticket: 4, attempt: 2, last: 17, live: true, ended: false }],
      busy: () => 1,
      receive: (message: unknown) => void received.push(message),
      disconnected: () => undefined,
      idle: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const link = createRunnerLink({ config, report: () => report, connect: hub.connect, retryDelay: () => 0, works: () => works });
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
