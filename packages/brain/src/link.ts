import { randomUUID } from "node:crypto";
import {
  type BrainMessage,
  type BrainProviders,
  brainLinkPath,
  HubToBrain,
  type Prepared,
  type PrepareRequest,
  protocolVersion,
  type RunningTurn,
} from "@super-agent2/protocol";
import WebSocket from "ws";
import type { BrainTransport, PrepareCall } from "./brain.js";

export type Schedule = (callback: () => void, milliseconds: number) => () => void;

export const timerSchedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};

export interface LinkOptions {
  readonly hubUrl: string;
  readonly token: string;
  readonly schedule?: Schedule;
  readonly reconnectDelay?: number;
  readonly report?: (line: string) => void;
}

export interface HubLink extends BrainTransport {
  bind(handlers: LinkHandlers): void;
  connect(): void;
  connected(): boolean;
  close(): Promise<void>;
}

export interface LinkHandlers {
  readonly receive: (message: HubToBrain) => void;
  readonly running: () => RunningTurn[];
  readonly status?: () => BrainProviders;
}

export function linkUrl(hubUrl: string): string {
  const url = new URL(brainLinkPath, hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createHubLink(options: LinkOptions): HubLink {
  const schedule = options.schedule ?? timerSchedule;
  const delay = options.reconnectDelay ?? 1000;
  const report = options.report ?? (() => undefined);
  const outbox: BrainMessage[] = [];
  const pending = new Map<string, { readonly message: PrepareRequest; readonly resolve: (prepared: Prepared) => void; readonly reject: (error: Error) => void }>();
  let handlers: LinkHandlers | undefined;
  let socket: WebSocket | undefined;
  let open = false;
  let closed = false;
  let cancelRetry: (() => void) | undefined;

  const write = (message: BrainMessage): boolean => {
    if (socket === undefined || !open || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  };

  const runningForHello = (): RunningTurn[] => {
    const running = new Map<string, RunningTurn>();
    for (const turn of handlers?.running() ?? []) {
      running.set(turn.turn, turn);
    }
    for (const message of outbox) {
      if (message.type === "turn.finished") {
        running.set(message.turn, { conversation: message.conversation, turn: message.turn });
      }
    }
    return [...running.values()];
  };

  const retry = () => {
    if (closed || cancelRetry !== undefined) {
      return;
    }
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed || socket !== undefined) {
      return;
    }
    const current = new WebSocket(linkUrl(options.hubUrl), { headers: { authorization: `Bearer ${options.token}` } });
    socket = current;
    current.on("open", () => {
      open = true;
      report("Linked to the hub");
      current.send(JSON.stringify({ type: "hello", protocol: protocolVersion, running: runningForHello() } satisfies BrainMessage));
      const status = handlers?.status?.();
      if (status !== undefined) {
        current.send(JSON.stringify(status));
      }
      for (let index = outbox.length - 1; index >= 0; index -= 1) {
        if (outbox[index]?.type === "providers") {
          outbox.splice(index, 1);
        }
      }
      while (outbox.length > 0) {
        const message = outbox[0];
        if (message === undefined || !write(message)) {
          break;
        }
        outbox.shift();
      }
      for (const request of pending.values()) {
        write(request.message);
      }
    });
    current.on("message", (data, binary) => {
      let message: HubToBrain;
      try {
        message = HubToBrain.parse(binary ? undefined : JSON.parse(String(data)));
      } catch {
        current.close(1008, "invalid message");
        return;
      }
      if (message.type === "prepared") {
        const request = pending.get(message.request);
        if (request !== undefined) {
          pending.delete(message.request);
          request.resolve(message);
        }
        return;
      }
      if (message.type !== "hello") {
        handlers?.receive(message);
      }
    });
    current.on("error", (error) => report(`The link to the hub failed: ${error.message}`));
    current.on("close", () => {
      if (socket === current) {
        socket = undefined;
        open = false;
        report("The link to the hub closed");
        retry();
      }
    });
  };

  return {
    bind: (value) => {
      handlers = value;
    },
    connect,
    connected: () => open,
    send: (message) => {
      if (message.type === "routed") {
        write(message);
        return;
      }
      if (outbox.length > 0 || !write(message)) {
        outbox.push(message);
      }
    },
    prepare: (call: PrepareCall) =>
      new Promise<Prepared>((resolve, reject) => {
        if (closed) {
          reject(new Error("The hub link is closed."));
          return;
        }
        const message: PrepareRequest = {
          type: "prepare",
          request: randomUUID(),
          conversation: call.conversation,
          provider: call.provider,
          exclude: [...call.exclude],
          fresh: call.fresh,
          ...(call.seed === undefined ? {} : { seed: call.seed }),
          ...(call.steer === undefined ? {} : { steer: call.steer }),
          ...(call.continuing === undefined ? {} : { continuing: call.continuing }),
        };
        pending.set(message.request, { message, resolve, reject });
        write(message);
      }),
    close: async () => {
      closed = true;
      cancelRetry?.();
      for (const request of pending.values()) {
        request.reject(new Error("The hub link is closed."));
      }
      pending.clear();
      const current = socket;
      socket = undefined;
      if (current !== undefined && current.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          current.once("close", () => resolve());
          current.terminate();
        });
      }
    },
  };
}
