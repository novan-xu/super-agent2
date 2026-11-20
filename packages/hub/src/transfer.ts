import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Attachment, DeliveredFile } from "@super-agent2/protocol";
import { z } from "zod";
import { createAttachmentStore } from "./attachments.js";
import { serveAttachments } from "./attachments-api.js";
import type { HubDatabase } from "./database.js";

const input = z.object({ text: z.string(), device: z.enum(["phone", "desktop"]), files: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(30) });
const row = z.object({ seq: z.number(), text: z.string(), device: z.enum(["phone", "desktop"]), created_at: z.number(), title: z.string().nullable() });
const fileRow = z.object({ file: z.string() });
const stores = new WeakMap<HubDatabase, ReturnType<typeof createAttachmentStore>>();

function storeFor(database: HubDatabase) {
  let store = stores.get(database);
  if (store === undefined) {
    store = createAttachmentStore(database, { now: () => Date.now() }, join(database.dataDir, "transfer"), "transfer_files");
    stores.set(database, store);
  }
  return store;
}

export function createLightTransfer(database: HubDatabase) {
  const store = storeFor(database);
  const insertEntry = database.connection.prepare("INSERT INTO transfer_entries (title, text, device, created_at, ticket) VALUES (?, ?, 'desktop', ?, ?)");
  const insertFile = database.connection.prepare("INSERT INTO transfer_files (id, name, size, media_type, created_at) VALUES (?, ?, ?, ?, ?)");
  const attach = database.connection.prepare("INSERT INTO transfer_entry_files (entry, file) VALUES (?, ?)");
  return (ticket: number, attempt: number, title: string, text: string, files: readonly DeliveredFile[], pathOf: (part: number) => string, now: number): void => {
    const seq = Number(insertEntry.run(title, text, now, ticket).lastInsertRowid);
    const linked: string[] = [];
    try {
      for (const [part, file] of files.entries()) {
        const id = createHash("sha256").update(`light-task:${ticket}:${attempt}:${part}`).digest("hex").slice(0, 32);
        const attachment: Attachment = { id, ...file };
        const path = store.path(attachment);
        insertFile.run(id, file.name, file.size, file.mediaType, now);
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path)) rmSync(path);
        linkSync(pathOf(part), path);
        linked.push(dirname(path));
        attach.run(seq, id);
      }
    } catch (error) {
      for (const path of linked) rmSync(path, { recursive: true, force: true });
      throw error;
    }
  };
}

export async function serveTransfer(g: { request: IncomingMessage; response: ServerResponse; path: string; method: string; database: HubDatabase; sameOrigin: boolean; readBody: () => Promise<string | undefined>; changed: () => void }): Promise<boolean> {
  const store = storeFor(g.database);
  const db = g.database.connection;
  const upload = /^\/api\/transfer\/files\/([0-9a-f]{32})\/upload$/.exec(g.path);
  if (upload !== null && g.method === "PUT" && db.prepare("SELECT 1 FROM transfer_entry_files WHERE file = ?").get(upload[1] ?? "") !== undefined) {
    g.request.resume();
    g.response.writeHead(409, { "content-type": "application/json" });
    g.response.end(JSON.stringify({ error: "conflict" }));
    return true;
  }
  if (g.path.startsWith("/api/transfer/files")) return serveAttachments({ ...g, store, basePath: "/api/transfer/files", maxFileBytes: 100 * 1024 * 1024 });
  const reply = (status: number, body: unknown) => { g.response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); g.response.end(JSON.stringify(body)); };
  const filesFor = (seq: number) => db.prepare("SELECT file FROM transfer_entry_files WHERE entry = ? ORDER BY rowid").all(seq).map((x) => store.get(fileRow.parse(x).file)).filter((x) => x !== undefined);
  if (g.path === "/api/transfer" && g.method === "GET") {
    const before = new URL(g.request.url ?? "/", "http://hub").searchParams.get("before");
    if (before !== null && !/^[1-9]\d{0,14}$/.test(before)) { reply(400, { error: "bad_request" }); return true; }
    const rows = db.prepare("SELECT seq, text, device, created_at, title FROM transfer_entries WHERE seq < ? ORDER BY seq DESC LIMIT 51").all(before === null ? Number.MAX_SAFE_INTEGER : Number(before)).map((x) => row.parse(x));
    const more = rows.length > 50;
    const items = rows.slice(0, 50).reverse().map((x) => ({ seq: x.seq, text: x.text, device: x.device, at: x.created_at, ...(x.title === null ? {} : { title: x.title }), files: filesFor(x.seq) }));
    reply(200, { items, more }); return true;
  }
  const match = /^\/api\/transfer\/(\d+)$/.exec(g.path);
  if ((g.path === "/api/transfer" && g.method === "POST") || (match !== null && g.method === "DELETE")) {
    if (!g.sameOrigin) { g.request.resume(); reply(403, { error: "forbidden" }); return true; }
    if (match !== null) {
      const seq = Number(match[1]);
      const files = filesFor(seq);
      if (db.prepare("DELETE FROM transfer_entries WHERE seq = ?").run(seq).changes === 0) { reply(404, { error: "not_found" }); return true; }
      for (const file of files) { db.prepare("DELETE FROM transfer_files WHERE id = ?").run(file.id); rmSync(join(store.root, file.id), { recursive: true, force: true }); }
      g.changed(); reply(200, { ok: true }); return true;
    }
    if (!(g.request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { g.request.resume(); reply(415, { error: "unsupported_media_type" }); return true; }
    let data: z.infer<typeof input> | undefined;
    try { const parsed = input.safeParse(JSON.parse((await g.readBody()) ?? "")); if (parsed.success) data = parsed.data; } catch { data = undefined; }
    if (data === undefined || (data.text.length === 0 && data.files.length === 0) || new Set(data.files).size !== data.files.length) { reply(400, { error: "bad_request" }); return true; }
    if (data.files.some((id) => (store.writing(id) || !store.complete(id)) || db.prepare("SELECT 1 FROM transfer_entry_files WHERE file = ?").get(id) !== undefined)) { reply(409, { error: "conflict" }); return true; }
    db.exec("BEGIN IMMEDIATE");
    try {
      const seq = Number(db.prepare("INSERT INTO transfer_entries (text, device, created_at) VALUES (?, ?, ?)").run(data.text, data.device, Date.now()).lastInsertRowid);
      for (const id of data.files) db.prepare("INSERT INTO transfer_entry_files (entry, file) VALUES (?, ?)").run(seq, id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    g.changed(); reply(201, { ok: true }); return true;
  }
  return false;
}
