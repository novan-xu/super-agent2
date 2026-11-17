import type { ServerMessage } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { HubSocket, type SocketEvents, type SocketLike, type SocketStatus } from "./socket.js";

class FakeSocket implements SocketLike {
  private state: "connecting" | "open" | "closed" = "connecting";
  readonly sent: unknown[] = [];
  closed = false;

  constructor(private readonly events: SocketEvents) {}

  isOpen(): boolean {
    return this.state === "open";
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.state = "open";
    this.events.open();
  }

  lose(): void {
    this.state = "closed";
    this.events.close();
  }

  deliver(data: unknown): void {
    this.events.message(data);
  }
}

function harness(resume: (conversation: string) => number = () => 0) {
  const sockets: FakeSocket[] = [];
  const timers: { readonly run: () => void; readonly delay: number; cancelled: boolean }[] = [];
  const statuses: SocketStatus[] = [];
  const messages: ServerMessage[] = [];
  let opens = 0;
  const socket = new HubSocket({
    url: "ws://hub/ws",
    create: (_url, events) => {
      const created = new FakeSocket(events);
      sockets.push(created);
      return created;
    },
    schedule: (run, delay) => {
      const timer = { run, delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    resume,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    onOpen: () => {
      opens += 1;
    },
  });
  return { socket, sockets, timers, statuses, messages, opens: () => opens };
}

describe("HubSocket", () => {
  it("watches the open conversation from where the page left off, again after every reconnection", () => {
    let after = 0;
    const { socket, sockets, timers, opens } = harness(() => after);
    socket.start();
    socket.watch("c1");
    sockets[0]?.open();
    expect(sockets[0]?.sent).toEqual([{ type: "watch", conversation: "c1", after: 0 }]);
    after = 7;
    sockets[0]?.lose();
    expect(timers.map((timer) => timer.delay)).toEqual([500]);
    timers[0]?.run();
    sockets[1]?.open();
    expect(sockets[1]?.sent).toEqual([{ type: "watch", conversation: "c1", after: 7 }]);
    expect(opens()).toBe(2);
  });

  it("waits longer after each failed attempt and starts over once connected", () => {
    const { socket, sockets, timers } = harness();
    socket.start();
    sockets[0]?.lose();
    timers[0]?.run();
    sockets[1]?.lose();
    timers[1]?.run();
    sockets[2]?.open();
    sockets[2]?.lose();
    expect(timers.map((timer) => timer.delay)).toEqual([500, 1000, 500]);
  });

  it("switches what it watches", () => {
    const { socket, sockets } = harness();
    socket.start();
    sockets[0]?.open();
    socket.watch("c1");
    socket.watch("c2");
    socket.watch(null);
    expect(sockets[0]?.sent).toEqual([
      { type: "watch", conversation: "c1", after: 0 },
      { type: "unwatch", conversation: "c1" },
      { type: "watch", conversation: "c2", after: 0 },
      { type: "unwatch", conversation: "c2" },
    ]);
  });

  it("passes on only messages of the protocol", () => {
    const { socket, sockets, messages } = harness();
    socket.start();
    sockets[0]?.open();
    sockets[0]?.deliver("not json");
    sockets[0]?.deliver(JSON.stringify({ type: "nonsense" }));
    sockets[0]?.deliver(JSON.stringify({ type: "brain", brain: { linked: true } }));
    expect(messages).toEqual([{ type: "brain", brain: { linked: true } }]);
  });

  it("reconnects at once when asked, dropping a socket that may be dead", () => {
    const { socket, sockets, timers, statuses } = harness();
    socket.start();
    sockets[0]?.open();
    socket.reconnect(false);
    expect(sockets).toHaveLength(1);
    socket.reconnect(true);
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[0]?.lose();
    expect(timers).toHaveLength(0);
    sockets[1]?.lose();
    socket.reconnect(false);
    expect(timers[0]?.cancelled).toBe(true);
    expect(sockets).toHaveLength(3);
    expect(statuses).toEqual(["connecting", "open", "connecting", "closed", "connecting"]);
  });

  it("stops for good", () => {
    const { socket, sockets, timers } = harness();
    socket.start();
    sockets[0]?.lose();
    socket.stop();
    expect(timers[0]?.cancelled).toBe(true);
    timers[0]?.run();
    expect(sockets).toHaveLength(1);
  });
});
