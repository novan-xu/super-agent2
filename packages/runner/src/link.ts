import {
  accessClientIdHeader,
  accessClientSecretHeader,
  HubToRunner,
  type MachineReport,
  protocolVersion,
  runnerCloseCodes,
  runnerLinkPath,
  type RunnerToHub,
  runnerTokenHeader,
} from "@super-agent2/protocol";
import WebSocket from "ws";
import type { RunnerConfig } from "./config.js";
import type { Works } from "./works.js";

export interface LinkSocket {
  send(text: string): void;
  close(): void;
  terminate(): void;
}

export interface LinkSocketEvents {
  open(): void;
  message(text: string): void;
  ping(): void;
  close(code: number, reason: string): void;
  refused(status: number): void;
}

export type Connect = (url: string, headers: Readonly<Record<string, string>>, events: LinkSocketEvents) => LinkSocket;

export type LinkEvent =
  | { readonly type: "connecting"; readonly url: string }
  | { readonly type: "connected"; readonly name: string; readonly version?: string }
  | { readonly type: "refused"; readonly status: number }
  | { readonly type: "closed"; readonly code: number; readonly reason: string }
  | { readonly type: "ignored"; readonly kind: string }
  | { readonly type: "retrying"; readonly delay: number };

export interface RunnerLinkOptions {
  readonly config: RunnerConfig;
  readonly report: () => MachineReport;
  readonly connect?: Connect;
  readonly retryDelay?: (attempt: number) => number;
  readonly silenceMilliseconds?: number;
  readonly onEvent?: (event: LinkEvent) => void;
  readonly works?: () => Works | undefined;
}

export interface RunnerLink {
  start(): void;
  update(): void;
  connected(): boolean;
  send(message: RunnerToHub): void;
  close(): Promise<void>;
}

export function linkUrl(hub: string): string {
  const url = new URL(runnerLinkPath, hub);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function defaultRetryDelay(attempt: number): number {
  return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
}

export const connectWithWs: Connect = (url, headers, events) => {
  const socket = new WebSocket(url, { headers: { ...headers }, handshakeTimeout: 30000 });
  let refused = false;
  socket.on("open", () => events.open());
  socket.on("message", (data, binary) => {
    if (!binary) {
      events.message(String(data));
    }
  });
  socket.on("ping", () => events.ping());
  socket.on("unexpected-response", (_request, response) => {
    refused = true;
    events.refused(response.statusCode ?? 0);
    response.resume();
    socket.terminate();
  });
  socket.on("error", () => undefined);
  socket.on("close", (code, reason) => {
    events.close(refused ? 1006 : code, String(reason));
  });
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(text);
      }
    },
    close: () => socket.close(1000, "runner closing"),
    terminate: () => socket.terminate(),
  };
};

export function createRunnerLink(options: RunnerLinkOptions): RunnerLink {
  const { config } = options;
  const connect = options.connect ?? connectWithWs;
  const retryDelay = options.retryDelay ?? defaultRetryDelay;
  const silence = options.silenceMilliseconds ?? 60000;
  const emit = (event: LinkEvent) => options.onEvent?.(event);
  const ignored = new Set<string>();
  let socket: LinkSocket | undefined;
  let welcomed = false;
  let attempt = 0;
  let closing = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let heard = Date.now();

  const send = (message: RunnerToHub) => {
    socket?.send(JSON.stringify(message));
  };

  const unknownKind = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const type: unknown = Reflect.get(value, "type");
    return typeof type === "string" && !HubToRunner.options.some((option) => option.shape.type.value === type) ? type : undefined;
  };

  const schedule = () => {
    if (closing) {
      return;
    }
    const delay = retryDelay(attempt);
    attempt += 1;
    emit({ type: "retrying", delay });
    retryTimer = setTimeout(open, delay);
  };

  const open = () => {
    retryTimer = undefined;
    if (closing) {
      return;
    }
    const url = linkUrl(config.hub);
    emit({ type: "connecting", url });
    welcomed = false;
    let current: LinkSocket | undefined;
    let finished = false;
    const events: LinkSocketEvents = {
      open: () => {
        heard = Date.now();
        socket = current;
        send({ type: "hello", protocol: protocolVersion, machine: options.report(), works: options.works?.()?.held() ?? [] });
      },
      message: (text) => {
        heard = Date.now();
        if (current === undefined || socket !== current) {
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          current.terminate();
          return;
        }
        const parsed = HubToRunner.safeParse(raw);
        if (!parsed.success) {
          const kind = unknownKind(raw);
          if (kind === undefined) {
            current.terminate();
            return;
          }
          if (!ignored.has(kind)) {
            ignored.add(kind);
            emit({ type: "ignored", kind });
          }
          return;
        }
        const message = parsed.data;
        if (message.type === "welcome") {
          welcomed = true;
          attempt = 0;
          emit({ type: "connected", name: message.name, ...(message.version === undefined ? {} : { version: message.version }) });
          return;
        }
        options.works?.()?.receive(message);
      },
      ping: () => {
        heard = Date.now();
      },
      refused: (status) => emit({ type: "refused", status }),
      close: (code, reason) => {
        if (finished) {
          return;
        }
        finished = true;
        if (socket === current) {
          socket = undefined;
        }
        welcomed = false;
        options.works?.()?.disconnected();
        emit({ type: "closed", code, reason });
        if (code === runnerCloseCodes.revoked) {
          attempt = Math.max(attempt, 5);
        }
        schedule();
      },
    };
    current = connect(
      url,
      {
        [accessClientIdHeader]: config.accessClientId,
        [accessClientSecretHeader]: config.accessClientSecret,
        [runnerTokenHeader]: config.runnerToken,
      },
      events,
    );
  };

  return {
    start: () => {
      if (watchdog === undefined) {
        watchdog = setInterval(() => {
          if (socket !== undefined && Date.now() - heard > silence) {
            socket.terminate();
          }
        }, Math.max(1000, Math.floor(silence / 4)));
        watchdog.unref();
      }
      open();
    },
    update: () => {
      if (welcomed) {
        send({ type: "report", machine: options.report() });
      }
    },
    connected: () => welcomed,
    send,
    close: async () => {
      closing = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      if (watchdog !== undefined) {
        clearInterval(watchdog);
      }
      socket?.close();
      socket = undefined;
    },
  };
}
