import { createServer, type IncomingHttpHeaders, type ServerHttp2Stream } from "node:http2";
import { request, type OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { peerLinkPath, peerTokenHeader } from "@super-agent2/protocol";
import WebSocket, { createWebSocketStream } from "ws";
import { nasPeer, peerExchangePath, peerUpdatesHeader, serveExchange, type PeerExchange } from "./peer-exchange.js";
import {
  copyBothWays, peerFrameLimit, peerApiRequest, peerRequestHeaders, peerResponseHeaders,
  peerSocketPath, peerUpgradeHeader, peerUpgradeHeaders, selectHeaders, watchPeer,
} from "./peer-wire.js";

export interface PeerConnectionConfig {
  readonly hub: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly token: string;
}

export function peerHubUrl(given: string | undefined): string | undefined {
  if (given === undefined) return undefined;
  try {
    const url = new URL(given);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      && url.pathname === "/" && url.search === "" && url.hash === "" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function serveLocal(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, address: AddressInfo): void {
  stream.on("error", () => stream.destroy());
  const method = headers[":method"];
  const path = headers[":path"];
  const upgrade = headers[peerUpgradeHeader] === "websocket";
  if (typeof method !== "string" || typeof path !== "string"
    || (upgrade ? method !== "POST" || path !== peerSocketPath : !peerApiRequest(method, path))) {
    stream.respond({ ":status": 404 });
    stream.end();
    return;
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const forwarded: OutgoingHttpHeaders = {
    ...selectHeaders(headers, upgrade ? peerUpgradeHeaders : peerRequestHeaders),
    origin: `http://${host}:${address.port}`,
  };
  if (upgrade) {
    forwarded.connection = "Upgrade";
    forwarded.upgrade = "websocket";
  }
  const upstream = request({ host: address.address, port: address.port, method: upgrade ? "GET" : method, path, headers: forwarded, agent: false });
  const badGateway = () => {
    if (stream.destroyed || stream.closed) return;
    if (stream.headersSent) {
      stream.destroy();
      return;
    }
    stream.respond({ ":status": 502 });
    stream.end();
  };
  stream.once("close", () => upstream.destroy());
  upstream.once("error", badGateway);
  upstream.once("response", (answer) => {
    if (stream.destroyed || stream.closed || upgrade) {
      answer.destroy();
      if (upgrade) badGateway();
      return;
    }
    answer.on("error", () => stream.destroy());
    stream.respond({ ":status": answer.statusCode ?? 502, ...selectHeaders(answer.headers, peerResponseHeaders) });
    answer.pipe(stream);
  });
  upstream.once("upgrade", (answer, socket, head) => {
    if (!upgrade || stream.destroyed || stream.closed || answer.statusCode !== 101) {
      socket.destroy();
      badGateway();
      return;
    }
    socket.on("error", () => stream.destroy());
    socket.once("close", () => { if (!stream.writableEnded) stream.end(); });
    stream.once("close", () => socket.destroy());
    stream.respond({ ":status": 200, ...selectHeaders(answer.headers, ["sec-websocket-accept", "sec-websocket-protocol"]) });
    if (head.length > 0) stream.write(head);
    copyBothWays(stream, socket);
  });
  if (upgrade || stream.readableEnded) upstream.end();
  else stream.pipe(upstream);
}

export function connectToPeer(config: PeerConnectionConfig, address: AddressInfo, retryBase = 1_000, exchange?: PeerExchange): () => void {
  const url = new URL(peerLinkPath, config.hub);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const http2 = createServer({ settings: { maxConcurrentStreams: 64 } });
  const source = nasPeer(config.hub, config.clientId);
  http2.on("sessionError", () => undefined);
  http2.on("stream", (stream, headers) => {
    if (exchange !== undefined && headers[":path"] === peerExchangePath && headers[":method"] === "POST") serveExchange(stream, exchange, source, headers[peerUpdatesHeader] === "1");
    else serveLocal(stream, headers, address);
  });
  let stopped = false;
  let failures = 0;
  let socket: WebSocket;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const dial = () => {
    const started = Date.now();
    socket = new WebSocket(url, {
      headers: {
        "cf-access-client-id": config.clientId, "cf-access-client-secret": config.clientSecret, [peerTokenHeader]: config.token,
      },
      handshakeTimeout: 10_000, maxPayload: peerFrameLimit, perMessageDeflate: false,
    });
    socket.on("error", () => undefined);
    socket.once("open", () => {
      watchPeer(socket);
      http2.emit("connection", createWebSocketStream(socket));
    });
    socket.once("close", () => {
      if (stopped) return;
      if (Date.now() - started > 30_000) failures = 0;
      const delay = Math.min(retryBase * 2 ** failures, 30_000);
      failures = Math.min(failures + 1, 5);
      retry = setTimeout(dial, delay + Math.random() * delay * 0.2);
      retry.unref();
    });
  };
  dial();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket.terminate();
  };
}
