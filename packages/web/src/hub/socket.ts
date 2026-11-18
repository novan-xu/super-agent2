import { type ClientMessage, ServerMessage, type TopicScope } from "@super-agent2/protocol";
import { reconnectDelay } from "../live/reconnect.js";
import { topicScopeKey } from "../live/topic-scope.js";

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
  readonly resumeStream?: () => number | undefined;
  readonly resumeTicket?: (ticket: number) => number;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onStatus: (status: SocketStatus) => void;
  readonly onOpen: () => void;
}

export class HubSocket {
  private socket: SocketLike | undefined;
  private attempt = 0;
  private cancelRetry: (() => void) | undefined;
  private watching: string | null = null;
  private watchingStream = false;
  private streamScope: TopicScope | undefined;
  private streamSubscription = 0;
  private watchingTicket: number | null = null;
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

  watchTicket(ticket: number | null): void {
    if (ticket === this.watchingTicket) {
      return;
    }
    const previous = this.watchingTicket;
    this.watchingTicket = ticket;
    if (previous !== null) {
      this.send({ type: "unwatch.ticket", ticket: previous });
    }
    if (ticket !== null) {
      this.send({ type: "watch.ticket", ticket, after: this.ticketAfter(ticket) });
    }
  }

  watchStream(watching: boolean, scope?: TopicScope, restart = false): void {
    if (!restart && watching === this.watchingStream && (!watching || topicScopeKey(scope) === topicScopeKey(this.streamScope))) {
      return;
    }
    this.watchingStream = watching;
    this.streamScope = scope;
    this.streamSubscription += 1;
    if (watching) {
      this.followStream();
    } else {
      this.send({ type: "unwatch.stream" });
    }
  }

  readStream(before: number): void {
    this.send({ type: "read.stream", before });
  }

  private followStream(): void {
    const after = this.options.resumeStream?.();
    this.send({
      type: "watch.stream",
      ...(after === undefined ? {} : { after }),
      ...(this.streamScope === undefined ? {} : { scope: this.streamScope, subscription: this.streamSubscription }),
    });
  }

  private ticketAfter(ticket: number): number {
    return this.options.resumeTicket?.(ticket) ?? 0;
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
        if (this.watchingStream) {
          this.followStream();
        }
        if (this.watching !== null) {
          this.send({ type: "watch", conversation: this.watching, after: this.options.resume(this.watching) });
        }
        if (this.watchingTicket !== null) {
          this.send({ type: "watch.ticket", ticket: this.watchingTicket, after: this.ticketAfter(this.watchingTicket) });
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
          const message = parsed.data;
          if (message.type === "stream.page" || message.type === "stream.entry") {
            const expected = this.streamScope === undefined ? undefined : this.streamSubscription;
            if (!this.watchingStream || message.subscription !== expected) {
              return;
            }
          }
          this.options.onMessage(message);
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
