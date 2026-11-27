import { pageAssetsPath, pageIconsPath, pageRoute, remotePath, themeScriptPath } from "@super-agent2/protocol";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { WebSocket } from "ws";

export const peerUpgradeHeader = "x-super-agent2-peer-upgrade";
export const peerSocketPath = "/ws";
export const peerFrameLimit = 1024 * 1024;

export const peerRequestHeaders = ["accept", "content-length", "content-type", "range"];
export const peerResponseHeaders = [
  "accept-ranges", "allow", "content-disposition", "content-length", "content-range",
  "x-file-media-type",
];
export const peerUpgradeHeaders = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"];

export function selectHeaders(headers: IncomingHttpHeaders, allowed: readonly string[]): OutgoingHttpHeaders {
  const selected: OutgoingHttpHeaders = {};
  for (const name of allowed) {
    const value = headers[name];
    if (typeof value === "string") selected[name] = value;
  }
  return selected;
}

export function peerApiRequest(method: string, target: string): boolean {
  if (!/^\/(?!\/)/.test(target) || target.includes("\\")) return false;
  const { pathname } = new URL(target, "http://peer");
  return pathname.startsWith("/api/") && pathname !== "/api/push" && !pathname.startsWith("/api/push/")
    && ["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method);
}

export function remotePageAsset(path: string): boolean {
  return (path !== remotePath && path !== `${remotePath}/` && pageRoute(path) !== undefined)
    || path === themeScriptPath || [pageAssetsPath, pageIconsPath, "/pdfjs/"].some((prefix) => path.startsWith(prefix));
}

export function safePeerMediaType(header: string | string[] | undefined): string {
  return typeof header === "string"
    && /^(?:application\/(?:json|octet-stream|pdf)|text\/(?:html|plain)|image\/(?:png|jpe?g|gif|webp|avif|bmp)|(?:audio|video)\/[a-z0-9.+-]+)(?:;|$)/i.test(header)
    ? header : "application/octet-stream";
}

export function watchPeer(socket: WebSocket, check: () => boolean = () => true): void {
  let alive = true;
  socket.on("pong", () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive || !check()) {
      socket.terminate();
      return;
    }
    alive = false;
    if (socket.readyState === socket.OPEN) socket.ping();
  }, 15_000);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
}

export function copyBothWays(first: NodeJS.ReadWriteStream, second: NodeJS.ReadWriteStream): void {
  first.pipe(second);
  second.pipe(first);
}
