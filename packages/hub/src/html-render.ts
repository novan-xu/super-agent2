import { canDrawBytes, decodeText, kindOf } from "@super-agent2/catalog";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";

export const isolatedPreviewPolicy = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; frame-ancestors 'self'";

export async function renderHtml(response: ServerResponse, file: { name: string; size: number; mediaType: string; open(): Readable }): Promise<boolean> {
  if (kindOf({ name: file.name, mime: file.mediaType }) !== "html" || !canDrawBytes(file.size)) return false;
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.open()) {
    const part = Buffer.from(chunk as Uint8Array);
    size += part.length;
    if (!canDrawBytes(size)) return false;
    parts.push(part);
  }
  const body = Buffer.from(decodeText(Buffer.concat(parts)), "utf8");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "content-security-policy": isolatedPreviewPolicy,
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
  });
  response.end(body);
  return true;
}
