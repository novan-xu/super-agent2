import type { IncomingMessage } from "node:http";
import { isIPv4 } from "node:net";
import type { Identity } from "@super-agent2/protocol";
import type { AccessVerifier } from "./access.js";

export const localOwnerEmail = "owner@local.invalid";
export const localOwner: Identity = { kind: "person", email: localOwnerEmail, subject: localOwnerEmail };
export const loopbackOwnerProof = Symbol("loopback owner");

export const verifyLoopbackOwner: AccessVerifier = async (proof) => proof === loopbackOwnerProof
  ? { ok: true, identity: localOwner }
  : { ok: false, reason: "no loopback admission" };

export function loopbackHost(host: string): string | undefined {
  if (host.toLowerCase() === "localhost") return "127.0.0.1";
  if (host === "::1" || (host.startsWith("127.") && isIPv4(host))) return host;
  return undefined;
}

export function admitsLoopback(request: IncomingMessage): boolean {
  const { socket, headers } = request;
  const port = socket.localPort;
  const host = socket.localAddress;
  if (port === undefined || host === undefined || loopbackHost(host) !== host || loopbackHost(socket.remoteAddress ?? "") === undefined) return false;
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "same-site" && site !== "none") return false;
  const hosts = [host === "::1" ? "[::1]" : host, "localhost"].flatMap((name) => port === 80 ? [name, `${name}:80`] : [`${name}:${port}`]);
  const origin = headers.origin;
  return request.headersDistinct.host?.length === 1 && hosts.includes(headers.host?.toLowerCase() ?? "")
    && (origin === undefined || hosts.some((name) => origin.toLowerCase() === `http://${name}`));
}
