import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type Health, type Hello, type Identity, type Refusal, type Session, protocolVersion } from "@super-agent2/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { type AccessVerifier, type Admission, assertionHeader } from "./access.js";
import type { HubDatabase } from "./database.js";

export const healthPath = "/health";
export const sessionPath = "/api/session";
export const socketPath = "/ws";

export interface HubServerOptions {
  readonly database: HubDatabase;
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

function sendJson(response: ServerResponse, status: number, body: Health | Refusal | Session, headOnly = false): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : text);
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
    sendJson(response, 404, { error: "not_found" });
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
    sockets.handleUpgrade(request, socket, head, (client: WebSocket) => {
      const hello: Hello = { type: "hello", protocol: protocolVersion, identity };
      client.send(JSON.stringify(hello));
    });
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
