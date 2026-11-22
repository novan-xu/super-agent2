import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WorkSourceName } from "@super-agent2/protocol";
import { z } from "zod";
import { isJson, parseJson, readBody } from "./http-json.js";
import type { Schedules } from "./schedules.js";

export const WorkRequest = z.strictObject({
  kind: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  text: z.string().min(1).max(4000).refine((value) => value.trim() !== ""),
  link: z.url().max(2048).refine((value) => /^https?:\/\//i.test(value)).optional(),
});
export type WorkRequest = z.infer<typeof WorkRequest>;

const bodyLimit = 40_000;
const statuses = { no_active_schedule: 409, idempotency_conflict: 409, rate_limited: 429, queue_full: 429 } as const;

function reply(response: ServerResponse, status: number, body: { id: string } | { error: string }): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function authorized(directory: string, source: string, header: string | undefined): Promise<boolean> {
  const token = /^Bearer ([a-zA-Z0-9_-]{32,128})$/i.exec(header ?? "")?.[1];
  if (token === undefined) return false;
  const digest = (await readFile(join(directory, `${source}.sha256`), "utf8").catch(() => "")).trim();
  return /^[0-9a-f]{64}$/.test(digest)
    && timingSafeEqual(Buffer.from(digest, "hex"), createHash("sha256").update(token).digest());
}

export function createWorkRequestServer(directory: string, schedules: Schedules, report: (line: string) => void) {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const source = WorkSourceName.safeParse(/^\/work-requests\/([^/]+)$/.exec(request.url ?? "")?.[1]);
    if (request.method !== "POST" || !source.success) {
      request.resume(); reply(response, 404, { error: "not_found" }); return;
    }
    if (!await authorized(directory, source.data, request.headers.authorization)) {
      request.resume(); response.setHeader("www-authenticate", "Bearer"); reply(response, 401, { error: "unauthorized" }); return;
    }
    if (!isJson(request)) {
      request.resume(); reply(response, 415, { error: "unsupported_media_type" }); return;
    }
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[\x21-\x2b\x2d-\x7e]{1,256}$/.test(key)) {
      request.resume(); reply(response, 400, { error: "invalid_idempotency_key" }); return;
    }
    if (Number(request.headers["content-length"] ?? 0) > bodyLimit) {
      request.resume(); reply(response, 413, { error: "too_large" }); return;
    }
    const raw = await readBody(request, bodyLimit);
    if (raw === undefined) { reply(response, 413, { error: "too_large" }); return; }
    const body = parseJson(raw, WorkRequest);
    if (body === undefined) { reply(response, 400, { error: "bad_request" }); return; }
    const result = schedules.requestWork(source.data, key, body);
    if ("error" in result) {
      const status = statuses[result.error];
      if (status === 429) response.setHeader("retry-after", "60");
      reply(response, status, result);
    } else {
      reply(response, 202, { id: result.id });
    }
  };
  const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
    void handle(request, response).catch(() => {
      report("An internal work request could not be processed.");
      if (response.headersSent) response.destroy();
      else { request.resume(); reply(response, 500, { error: "unavailable" }); }
    });
  });

  return {
    listen: (port: number, host: string) => new Promise<AddressInfo>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server.address() as AddressInfo);
      });
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    }),
  };
}
