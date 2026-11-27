import { pageAssetsPath, pageIconsPath, pageRoute, remotePath, themeScriptPath } from "@super-agent2/protocol";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { WebSocket } from "ws";

export const peerNameHeader = "x-super-agent2-peer-name";
export const peerUpgradeHeader = "x-super-agent2-peer-upgrade";
export const peerSocketPath = "/ws";
export const peerFrameLimit = 1024 * 1024;

export const peerRequestHeaders = ["accept", "content-length", "content-type", "range"];
export const peerResponseHeaders = [
  "accept-ranges", "allow", "content-disposition", "content-length", "content-range", "content-security-policy",
  "content-type", "referrer-policy", "x-content-type-options", "x-file-media-type", "x-frame-options",
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

export function peerPageRequest(method: string, target: string): boolean {
  if (!/^\/(?!\/)/.test(target) || target.includes("\\")) return false;
  const { pathname } = new URL(target, "http://peer");
  if (pathname.startsWith("/api/")) {
    return pathname !== "/api/push" && !pathname.startsWith("/api/push/") && ["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method);
  }
  if (method !== "GET" && method !== "HEAD") return false;
  return (pathname !== remotePath && pathname !== `${remotePath}/` && pageRoute(pathname) !== undefined)
    || pathname === themeScriptPath
    || [pageAssetsPath, pageIconsPath, "/pdfjs/"].some((prefix) => pathname.startsWith(prefix));
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
