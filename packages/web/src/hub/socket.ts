import { type ClientMessage, ServerMessage } from "@super-agent2/protocol";
import { reconnectDelay } from "../live/reconnect.js";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketEvents {
  open(): void;
  close(): void;
  message(data: unknown): void;
}

export interface SocketLike {
  isOpen(): boolean;
  send(data: string): void;
  close(): void;
}

export function browserSocket(url: string, events: SocketEvents): SocketLike {
  const socket = new WebSocket(url);
  socket.onopen = () => events.open();
  socket.onclose = () => events.close();
  socket.onmessage = (event) => events.message(event.data);
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
}

export type Schedule = (run: () => void, delay: number) => () => void;

export interface HubSocketOptions {
  readonly url: string;
  readonly create: (url: string, events: SocketEvents) => SocketLike;
  readonly schedule: Schedule;
  readonly resume: (conversation: string) => number;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onStatus: (status: SocketStatus) => void;
  readonly onOpen: () => void;
}

export class HubSocket {
  private socket: SocketLike | undefined;
  private attempt = 0;
  private cancelRetry: (() => void) | undefined;
  private watching: string | null = null;
  private running = false;

  constructor(private readonly options: HubSocketOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.drop();
  }

  watch(conversation: string | null): void {
    if (conversation === this.watching) {
      return;
    }
    const previous = this.watching;
    this.watching = conversation;
    if (previous !== null) {
      this.send({ type: "unwatch", conversation: previous });
    }
    if (conversation !== null) {
      this.send({ type: "watch", conversation, after: this.options.resume(conversation) });
    }
  }

  reconnect(force: boolean): void {
    if (!this.running || (!force && this.socket !== undefined)) {
      return;
    }
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.attempt = 0;
    this.drop();
    this.connect();
  }

  private send(message: ClientMessage): void {
    if (this.socket?.isOpen() === true) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      try {
        socket.close();
      } catch {
        return;
      }
    }
  }

  private connect(): void {
    this.options.onStatus("connecting");
    let socket: SocketLike | undefined;
    const events: SocketEvents = {
      open: () => {
        if (this.socket !== socket) {
          return;
        }
        this.attempt = 0;
        this.options.onStatus("open");
        if (this.watching !== null) {
          this.send({ type: "watch", conversation: this.watching, after: this.options.resume(this.watching) });
        }
        this.options.onOpen();
      },
      message: (data) => {
        if (this.socket !== socket || typeof data !== "string") {
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          return;
        }
        const parsed = ServerMessage.safeParse(value);
        if (parsed.success) {
          this.options.onMessage(parsed.data);
        }
      },
      close: () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.retry();
        }
      },
    };
    try {
      socket = this.options.create(this.options.url, events);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
  }

  private retry(): void {
    this.options.onStatus("closed");
    if (!this.running) {
      return;
    }
    const delay = reconnectDelay(this.attempt);
    this.attempt += 1;
    this.cancelRetry = this.options.schedule(() => {
      this.cancelRetry = undefined;
      if (this.running && this.socket === undefined) {
        this.connect();
      }
    }, delay);
  }
}
