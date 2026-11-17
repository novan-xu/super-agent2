import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  ClientMessage,
  type CommandList,
  type CommandResponse,
  type Health,
  type Identity,
  type OutputResponse,
  type Refusal,
  type ServerMessage,
  type Session,
  protocolVersion,
} from "@super-agent2/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { type AccessVerifier, type Admission, assertionHeader } from "./access.js";
import type { CommandService } from "./commands.js";
import type { HubDatabase } from "./database.js";

export const healthPath = "/health";
export const sessionPath = "/api/session";
export const socketPath = "/ws";
export const commandsPath = "/api/commands";

const commandRoute = /^\/api\/commands\/([0-9A-Za-z-]+)(\/output|\/stop)?$/;

const defaultListLimit = 50;
const maximumListLimit = 500;

export interface HubServerOptions {
  readonly database: HubDatabase;
  readonly commands: CommandService;
  readonly verify: AccessVerifier;
  readonly admit: Admission;
}

export interface HubServer {
  readonly server: Server;
  listen(port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

function headerValue(request: IncomingMessage): string | undefined {
  const value = request.headers[assertionHeader];
  return Array.isArray(value) ? undefined : value;
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://hub").pathname;
}

type Body = Health | Refusal | Session | CommandList | CommandResponse | OutputResponse;

function sendJson(response: ServerResponse, status: number, body: Body, headOnly = false): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : text);
}

function integerParameter(url: URL, name: string, fallback: number, maximum: number): number | undefined {
  const text = url.searchParams.get(name);
  if (text === null) {
    return fallback;
  }
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  return Math.min(Number(text), maximum);
}

function isJson(request: IncomingMessage): boolean {
  const type = request.headers["content-type"] ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function refuseSocket(socket: Duplex, status: 403 | 404): void {
  const reason = status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createHubServer(options: HubServerOptions): HubServer {
  const sockets = new WebSocketServer({ noServer: true });

  const authenticate = async (request: IncomingMessage): Promise<Identity | undefined> => {
    try {
      const result = await options.verify(headerValue(request));
      if (!result.ok || !options.admit(result.identity)) {
        return undefined;
      }
      return result.identity;
    } catch {
      return undefined;
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = pathOf(request);
    const method = request.method ?? "GET";
    if (path === healthPath && (method === "GET" || method === "HEAD")) {
      const healthy = options.database.healthy();
      sendJson(response, healthy ? 200 : 503, { status: healthy ? "ok" : "unavailable" }, method === "HEAD");
      return;
    }
    const identity = await authenticate(request);
    if (identity === undefined) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    if (path === sessionPath && method === "GET") {
      sendJson(response, 200, { protocol: protocolVersion, identity });
      return;
    }
    if (path.startsWith(commandsPath) && serveCommands(request, response, path, method)) {
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  };

  const serveCommands = (request: IncomingMessage, response: ServerResponse, path: string, method: string): boolean => {
    const url = new URL(request.url ?? "/", "http://hub");
    if (path === commandsPath && method === "GET") {
      const limit = integerParameter(url, "limit", defaultListLimit, maximumListLimit);
      if (limit === undefined) {
        return false;
      }
      sendJson(response, 200, { commands: options.commands.list(limit) });
      return true;
    }
    const match = commandRoute.exec(path);
    const id = match?.[1];
    if (match === null || id === undefined) {
      return false;
    }
    const action = match[2];
    const command = options.commands.get(id);
    if (command === undefined) {
      return false;
    }
    if (action === undefined && method === "GET") {
      sendJson(response, 200, { command });
      return true;
    }
    if (action === "/output" && method === "GET") {
      const after = integerParameter(url, "after", 0, Number.MAX_SAFE_INTEGER);
      if (after === undefined) {
        return false;
      }
      sendJson(response, 200, { chunks: options.commands.output(id, after) });
      return true;
    }
    if (action === "/stop" && method === "POST") {
      request.resume();
      if (!isJson(request)) {
        sendJson(response, 415, { error: "unsupported_media_type" });
        return true;
      }
      const stopped = options.commands.stop(id) ?? command;
      sendJson(response, 202, { command: stopped });
      return true;
    }
    return false;
  };

  const serveSocket = (client: WebSocket, identity: Identity): void => {
    const followed = new Set<string>();
    const send = (message: ServerMessage) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify(message));
      }
    };
    const unsubscribe = options.commands.subscribe((event) => {
      if (event.type === "command" || followed.has(event.chunk.command)) {
        send(event);
      }
    });
    client.on("close", unsubscribe);
    client.on("message", (data, binary) => {
      let message: ClientMessage;
      try {
        message = ClientMessage.parse(binary ? undefined : JSON.parse(String(data)));
      } catch {
        client.close(1008, "invalid message");
        return;
      }
      if (message.type === "unfollow") {
        followed.delete(message.command);
        return;
      }
      followed.add(message.command);
      for (const chunk of options.commands.output(message.command, message.after)) {
        send({ type: "output", chunk });
      }
    });
    send({ type: "hello", protocol: protocolVersion, identity });
  };

  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const identity = await authenticate(request);
    if (identity === undefined) {
      refuseSocket(socket, 403);
      return;
    }
    if (pathOf(request) !== socketPath) {
      refuseSocket(socket, 404);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client: WebSocket) => serveSocket(client, identity));
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 403, { error: "forbidden" });
      } else {
        response.destroy();
      }
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    upgrade(request, socket, head).catch(() => socket.destroy());
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(port, host, () => {
          server.off("error", failed);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of sockets.clients) {
          client.terminate();
        }
        sockets.close();
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
