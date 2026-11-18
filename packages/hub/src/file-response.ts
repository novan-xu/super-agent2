import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

export function sendFile(request: IncomingMessage, response: ServerResponse, file: { name: string; size: number; mediaType: string; open(range?: { start: number; end: number }): Readable }, disposition: string, cache: string): void {
  const range = request.headers.range;
  let start = 0;
  let end = file.size - 1;
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match === null || (!match[1] && !match[2]) || file.size === 0) {
      response.writeHead(416, { "content-range": `bytes */${file.size}` }); response.end(); return;
    }
    if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) {
      response.writeHead(416, { "content-range": `bytes */${file.size}` }); response.end(); return;
    }
  }
  const extensions: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", weba: "audio/webm" };
  const namedType = extensions[file.name.split(".").pop()?.toLowerCase() ?? ""];
  const safeType = namedType ?? (/^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|aac|wav|ogg|webm|flac))$/i.test(file.mediaType) ? file.mediaType : "application/octet-stream");
  response.writeHead(range === undefined ? 200 : 206, {
    "content-type": safeType, "content-length": range === undefined ? file.size : end - start + 1,
    "content-disposition": disposition, "cache-control": cache, "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox", "accept-ranges": "bytes",
    "x-file-media-type": /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mediaType) ? file.mediaType : "application/octet-stream",
    ...(range === undefined ? {} : { "content-range": `bytes ${start}-${end}/${file.size}` }),
  });
  if (request.method === "HEAD") { response.end(); return; }
  const body = file.open(range === undefined ? undefined : { start, end });
  body.on("error", () => response.destroy()); response.on("close", () => body.destroy()); body.pipe(response);
}
