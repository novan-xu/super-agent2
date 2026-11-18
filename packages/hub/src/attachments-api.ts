import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentCreate, attachmentsPath, isNativeImage } from "@super-agent2/protocol";
import type { AttachmentStore } from "./attachments.js";

const attachmentRoute = /^\/api\/attachments\/([0-9a-f]{32})(\/upload)?$/;

export interface AttachmentRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly path: string;
  readonly method: string;
  readonly store: AttachmentStore;
  readonly sameOrigin: boolean;
  readonly readBody: () => Promise<string | undefined>;
}

function reply(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

function contentTypeOf(request: IncomingMessage): string {
  return (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function offsetOf(request: IncomingMessage): number | undefined {
  const given = new URL(request.url ?? "/", "http://hub").searchParams.get("offset");
  return given !== null && /^\d{1,15}$/.test(given) ? Number(given) : undefined;
}

function refuse(request: IncomingMessage, response: ServerResponse, status: number, error: string): true {
  request.resume();
  reply(response, status, { error });
  return true;
}

export function contentDisposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function serveAttachments(given: AttachmentRequest): Promise<boolean> {
  const { request, response, path, method, store } = given;
  if (path === attachmentsPath) {
    if (method !== "POST") {
      return false;
    }
    if (!given.sameOrigin) {
      return refuse(request, response, 403, "forbidden");
    }
    if (contentTypeOf(request) !== "application/json") {
      return refuse(request, response, 415, "unsupported_media_type");
    }
    let parsed;
    try {
      parsed = AttachmentCreate.safeParse(JSON.parse((await given.readBody()) ?? ""));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success) {
      reply(response, 400, { error: "bad_request" });
      return true;
    }
    reply(response, 201, store.create(parsed.data));
    return true;
  }
  const match = attachmentRoute.exec(path);
  const id = match?.[1];
  if (match === null || id === undefined) {
    return false;
  }
  const attachment = store.get(id);
  if (attachment === undefined) {
    return false;
  }
  if (match[2] === "/upload") {
    if (method === "GET") {
      request.resume();
      reply(response, 200, { attachment, received: store.received(id) });
      return true;
    }
    if (method !== "PUT") {
      return false;
    }
    if (!given.sameOrigin) {
      return refuse(request, response, 403, "forbidden");
    }
    if (contentTypeOf(request) !== "application/octet-stream") {
      return refuse(request, response, 415, "unsupported_media_type");
    }
    const offset = offsetOf(request);
    if (offset === undefined) {
      return refuse(request, response, 400, "bad_request");
    }
    const outcome = await store.write(id, offset, request);
    if (!outcome.ok) {
      reply(response, outcome.error === "not_found" ? 404 : outcome.error === "conflict" ? 409 : 400, { error: outcome.error, received: outcome.received });
      return true;
    }
    reply(response, 200, { attachment, received: outcome.received });
    return true;
  }
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  request.resume();
  const body = method === "GET" ? store.open(id) : undefined;
  if (method === "GET" && body === undefined) {
    return false;
  }
  if (method === "HEAD" && !store.complete(id)) {
    return false;
  }
  response.writeHead(200, {
    "content-type": isNativeImage(attachment.mediaType) ? attachment.mediaType : "application/octet-stream",
    "content-length": attachment.size,
    "content-disposition": contentDisposition(attachment.name),
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  });
  if (body === undefined) {
    response.end();
    return true;
  }
  body.on("error", () => response.destroy());
  response.on("close", () => body.destroy());
  body.pipe(response);
  return true;
}
