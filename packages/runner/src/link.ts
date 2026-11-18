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
import type { Ledger } from "./ledger.js";
import type { ShellJob, ShellRun, ShellSink } from "./shell.js";
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

export type ExecuteCommand = (job: ShellJob, sink: ShellSink) => ShellRun;

export type LinkEvent =
  | { readonly type: "connecting"; readonly url: string }
  | { readonly type: "connected"; readonly name: string; readonly version?: string }
  | { readonly type: "refused"; readonly status: number }
  | { readonly type: "closed"; readonly code: number; readonly reason: string; readonly stopped: number }
  | { readonly type: "started"; readonly id: string; readonly pid: number | undefined }
  | { readonly type: "ended"; readonly id: string; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly type: "failed"; readonly id: string; readonly reason: string }
  | { readonly type: "retrying"; readonly delay: number };

export interface RunnerLinkOptions {
  readonly config: RunnerConfig;
  readonly report: () => MachineReport;
  readonly execute: ExecuteCommand;
  readonly connect?: Connect;
  readonly ledger?: Ledger;
  readonly retryDelay?: (attempt: number) => number;
  readonly silenceMilliseconds?: number;
  readonly onEvent?: (event: LinkEvent) => void;
  readonly works?: () => Works | undefined;
}

export interface RunnerLink {
  start(): void;
  update(): void;
  running(): string[];
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
  const runs = new Map<string, ShellRun>();
  const ended = new Map<string, Promise<void>>();
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

  const stopping = new Set<string>();

  const stopOne = (id: string): boolean => {
    const execution = runs.get(id);
    if (execution === undefined || stopping.has(id)) {
      return false;
    }
    stopping.add(id);
    execution.stop().catch(() => undefined);
    return true;
  };

  const stopAll = (): number => [...runs.keys()].filter(stopOne).length;

  const run = (current: LinkSocket, id: string, job: ShellJob) => {
    const sendHere = (message: RunnerToHub) => {
      if (socket === current) {
        current.send(JSON.stringify(message));
      }
    };
    let execution: ShellRun;
    try {
      execution = options.execute(job, (stream, data) => sendHere({ type: "output", id, stream, data: data.toString("base64") }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emit({ type: "failed", id, reason });
      sendHere({ type: "failed", id, reason });
      return;
    }
    runs.set(id, execution);
    if (execution.pid !== undefined) {
      options.ledger?.add(execution.pid);
    }
    emit({ type: "started", id, pid: execution.pid });
    if (socket !== current) {
      stopOne(id);
    }
    const forget = () => {
      runs.delete(id);
      stopping.delete(id);
      ended.delete(id);
      if (execution.pid !== undefined) {
        options.ledger?.remove(execution.pid);
      }
    };
    const finished = execution.ended.then(
      (end) => {
        forget();
        emit({ type: "ended", id, exitCode: end.exitCode, signal: end.signal });
        sendHere({ type: "ended", id, exitCode: end.exitCode, signal: end.signal });
      },
      (error: unknown) => {
        forget();
        const reason = error instanceof Error ? error.message : String(error);
        emit({ type: "failed", id, reason });
        sendHere({ type: "failed", id, reason });
      },
    );
    ended.set(id, finished);
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
        let message: HubToRunner;
        try {
          message = HubToRunner.parse(JSON.parse(text));
        } catch {
          current.terminate();
          return;
        }
        if (message.type === "welcome") {
          welcomed = true;
          attempt = 0;
          emit({ type: "connected", name: message.name, ...(message.version === undefined ? {} : { version: message.version }) });
          return;
        }
        if (message.type === "run") {
          run(current, message.id, { command: message.command, cwd: message.cwd, environment: message.environment });
          return;
        }
        if (message.type === "stop") {
          stopOne(message.id);
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
        const stopped = stopAll();
        emit({ type: "closed", code, reason, stopped });
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
    running: () => [...runs.keys()],
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
      stopAll();
      await Promise.all([...ended.values()]);
      socket?.close();
      socket = undefined;
    },
  };
}
