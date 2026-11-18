import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

const extensions = new Set("doc docx docm dot dotx dotm rtf odt ott xls xlsx xlsm xlsb xlt xltx xltm ods ots ppt pptx pptm pps ppsx ppsm pot potx potm odp otp".split(" "));
const limit = 64 * 1024 * 1024;
export class Previews {
  private readonly pending = new Map<string, Promise<string>>();
  constructor(private readonly root: string, private readonly url: string | undefined, private readonly fetcher: typeof fetch = fetch) {}
  async pdf(file: { name: string; size: number; open(): Readable }): Promise<string> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!file.name.includes(".") || !extensions.has(ext)) throw new Error("This file has no Office preview.");
    if (file.size > limit) throw new Error("This file exceeds the 64 MiB preview limit.");
    const parts: Buffer[] = []; let length = 0;
    for await (const chunk of file.open()) { const part = Buffer.from(chunk as Uint8Array); length += part.length; if (length > limit) throw new Error("This file exceeds the 64 MiB preview limit."); parts.push(part); }
    const bytes = Buffer.concat(parts); const hash = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.root, hash.slice(0, 2), `${hash}.pdf`);
    if (existsSync(path)) return path;
    let pending = this.pending.get(hash);
    if (!pending) {
      if (!this.url) throw new Error("The converter is unavailable.");
      if (this.pending.size >= 4) throw new Error("The converter is busy. Please try again.");
      const url = this.url;
      pending = (async () => {
        const form = new FormData(); form.append("files", new Blob([new Uint8Array(bytes)]), `document.${ext}`);
        const response = await this.fetcher(`${url}/forms/libreoffice/convert`, { method: "POST", body: form, signal: AbortSignal.timeout(90_000) });
        if (!response.ok || !response.body) throw new Error("The converter could not convert this file.");
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error("The converted PDF exceeds the 64 MiB preview limit."); chunks.push(chunk); }
        const pdf = Buffer.concat(chunks); if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("The converter returned an invalid PDF.");
        mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`;
        try { writeFileSync(temp, pdf, { mode: 0o600 }); renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
        return path;
      })().finally(() => this.pending.delete(hash));
      this.pending.set(hash, pending);
    }
    return pending;
  }
}
export function previewFile(path: string) {
  return { name: "preview.pdf", size: statSync(path).size, mediaType: "application/pdf", open: (range?: { start: number; end: number }) => createReadStream(path, range) };
}
