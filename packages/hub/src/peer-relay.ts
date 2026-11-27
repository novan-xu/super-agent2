import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { peerTokenHeader, type PeerStatus } from "@super-agent2/protocol";
import { createWebSocketStream, WebSocketServer } from "ws";
import { assertionHeader, type AccessVerifier } from "./access.js";
import { exchangeWithPeer, type PeerExchange } from "./peer-exchange.js";
import { isolatedPreviewPolicy } from "./html-render.js";
import type { PeerStore } from "./peer-store.js";
import {
  copyBothWays, peerFrameLimit, peerApiRequest, peerRequestHeaders, peerResponseHeaders,
  peerSocketPath, peerUpgradeHeader, peerUpgradeHeaders, safePeerMediaType, selectHeaders, watchPeer,
} from "./peer-wire.js";

interface Link {
  readonly session: ClientHttp2Session;
  readonly clientId: string;
}

function failResponse(request: IncomingMessage, response: ServerResponse, status: number): void {
  request.resume();
  response.writeHead(status, { "cache-control": "no-store", "content-length": 0 });
  response.end();
}

function failUpgrade(socket: Duplex, status: 403 | 404 | 502 | 503): void {
  socket.end(`HTTP/1.1 ${status} Peer relay\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export interface PeerRelayOptions {
  readonly verify: AccessVerifier;
  readonly store: PeerStore;
  readonly exchange?: PeerExchange;
}

export class PeerRelay {
  private readonly links = new Map<string, Link>();
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: peerFrameLimit });
  private readonly reconcile: ReturnType<typeof setInterval>;
  private previous = "";
  private closed = false;

  constructor(private readonly options: PeerRelayOptions, private readonly announce: (peers: readonly PeerStatus[]) => void) {
    this.previous = JSON.stringify(this.status());
    this.reconcile = setInterval(() => this.refresh(), 5_000);
    this.reconcile.unref();
  }

  status(): readonly PeerStatus[] {
    return this.options.store.list().map(({ name, clientId }) => ({ name, online: this.links.get(name)?.clientId === clientId }));
  }

  private refresh(): void {
    if (this.closed) return;
    for (const [name, { session, clientId }] of this.links) {
      if (this.options.store.find(name)?.clientId !== clientId) {
        this.links.delete(name);
        session.destroy();
      }
    }
    const peers = this.status();
    const next = JSON.stringify(peers);
    if (next === this.previous) return;
    this.previous = next;
    this.announce(peers);
  }

  async accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const assertion = request.headers[assertionHeader];
    const token = request.headers[peerTokenHeader];
    const verified = await this.options.verify(typeof assertion === "string" ? assertion : undefined);
    const peer = verified.ok && verified.identity.kind === "service"
      ? this.options.store.admit(verified.identity.clientId, typeof token === "string" ? token : undefined)
      : undefined;
    if (peer === undefined) {
      failUpgrade(socket, 403);
      return;
    }
    if (socket.destroyed || this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (client) => {
      const session = connect("http://peer", { createConnection: () => createWebSocketStream(client) });
      session.on("error", () => client.terminate());
      session.once("close", () => {
        if (this.links.get(peer.name)?.session !== session) return;
        this.links.delete(peer.name);
        this.refresh();
      });
      session.once("remoteSettings", () => {
        if (this.closed || this.options.store.find(peer.name)?.clientId !== peer.clientId) {
          session.destroy();
          return;
        }
        const prior = this.links.get(peer.name);
        this.links.set(peer.name, { session, clientId: peer.clientId });
        prior?.session.destroy();
        if (this.options.exchange !== undefined) exchangeWithPeer(session, this.options.exchange, { id: peer.clientId, name: peer.name });
        this.refresh();
      });
      client.once("close", () => session.destroy());
      watchPeer(client, () => this.options.store.find(peer.name)?.clientId === peer.clientId);
    });
  }

  availability(name: string): 200 | 404 | 503 {
    const peer = this.options.store.find(name);
    if (peer === undefined) return 404;
    return this.links.get(name)?.clientId === peer.clientId ? 200 : 503;
  }

  private open(name: string, headers: Parameters<ClientHttp2Session["request"]>[0], endStream: boolean): ClientHttp2Stream | undefined {
    const link = this.links.get(name);
    if (link === undefined || link.session.closed || link.session.destroyed || this.options.store.find(name)?.clientId !== link.clientId) return undefined;
    try {
      return link.session.request(headers, { endStream });
    } catch {
      return undefined;
    }
  }

  http(name: string, target: string, request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? "GET";
    if (!peerApiRequest(method, target)) {
      failResponse(request, response, 404);
      return;
    }
    const endStream = request.headers["transfer-encoding"] === undefined && Number(request.headers["content-length"] ?? 0) === 0;
    const stream = this.open(name, { ":method": method, ":path": target, ...selectHeaders(request.headers, peerRequestHeaders) }, endStream);
    if (stream === undefined) {
      failResponse(request, response, this.options.store.find(name) === undefined ? 404 : 503);
      return;
    }
    const failed = () => {
      if (response.writableEnded || response.destroyed) return;
      if (response.headersSent) response.destroy();
      else failResponse(request, response, 502);
    };
    stream.on("error", failed);
    stream.once("close", failed);
    const cancel = () => { if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL); };
    request.once("error", cancel);
    response.once("close", cancel);
    stream.once("response", (headers) => {
      if (response.destroyed) return;
      response.writeHead(headers[":status"] ?? 502, {
        ...selectHeaders(headers, peerResponseHeaders),
        "content-type": safePeerMediaType(headers["content-type"]),
        "content-security-policy": isolatedPreviewPolicy,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store", "cdn-cache-control": "no-store",
      });
      stream.pipe(response);
    });
    if (!endStream) request.pipe(stream);
    else request.resume();
  }

  upgrade(name: string, target: string, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (target !== peerSocketPath) {
      failUpgrade(socket, 404);
      return;
    }
    const stream = this.open(name, {
      ":method": "POST", ":path": peerSocketPath, [peerUpgradeHeader]: "websocket", ...selectHeaders(request.headers, peerUpgradeHeaders),
    }, false);
    if (stream === undefined) {
      failUpgrade(socket, this.options.store.find(name) === undefined ? 404 : 503);
      return;
    }
    let upgraded = false;
    let finished = false;
    const failed = () => {
      if (finished) return;
      finished = true;
      if (upgraded) socket.destroy();
      else failUpgrade(socket, 502);
    };
    stream.on("error", failed);
    stream.once("close", failed);
    socket.once("close", () => { if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL); });
    stream.once("response", (headers) => {
      const accept = headers["sec-websocket-accept"];
      const protocol = headers["sec-websocket-protocol"];
      if (headers[":status"] !== 200 || typeof accept !== "string" || !/^[A-Za-z0-9+/]{27}=$/.test(accept)
        || (protocol !== undefined && (typeof protocol !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(protocol)))) {
        stream.close(constants.NGHTTP2_CANCEL);
        failed();
        return;
      }
      upgraded = true;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${typeof protocol === "string" ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ""}\r\n`);
      if (head.length > 0) stream.write(head);
      copyBothWays(stream, socket);
    });
  }

  close(): void {
    this.closed = true;
    this.links.clear();
    clearInterval(this.reconcile);
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
  }
}
