import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AttachmentId, attachmentPartBytes, type Attachment } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { transferFileBytes, transferFileCount, transferStore } from "./transfer.js";

const inlineBytes = 1024 * 1024;
const idleUploadMs = 24 * 60 * 60 * 1000;
const maximumPending = 2;
const maximumBase64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);
export const inboxMcpBodyBytes = maximumBase64Length(attachmentPartBytes) + 64 * 1024;

const Key = z.string().min(1).max(256).describe("Use a unique key for each send. Reuse it when retrying the same send.");
const Note = z.string().max(2000).optional();
const Name = z.string().trim().min(1).max(255).refine((name) => name.isWellFormed() && !/[\p{Cc}/\\]/u.test(name), "Use a file name without a path or control characters.");
const MediaType = z.string().trim().max(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, "Use a media type such as application/pdf.").optional();
const File = z.strictObject({ name: Name, media_type: MediaType });
const Files = <T extends z.ZodType>(file: T) => z.array(file).min(1).max(transferFileCount, `Send at most ${transferFileCount} files per entry.`);
const SendFiles = z.strictObject({
  idempotency_key: Key,
  note: Note,
  files: Files(File.extend({ content_base64: z.string().max(maximumBase64Length(inlineBytes), "Use begin_upload for larger files.") })),
});
const BeginUpload = z.strictObject({
  idempotency_key: Key,
  note: Note,
  files: Files(File.extend({ size: z.number().int().min(0).max(transferFileBytes, "A file may contain at most 100 MiB.") })),
});
const UploadPart = z.strictObject({
  idempotency_key: Key,
  file_index: z.number().int().min(0).max(transferFileCount - 1),
  offset: z.number().int().min(0).max(transferFileBytes),
  content_base64: z.string().min(1).max(maximumBase64Length(attachmentPartBytes), "Each part may contain at most 8 MiB."),
});
const FinishUpload = z.strictObject({ idempotency_key: Key });

const descriptions = {
  send_files: { schema: SendFiles, description: "Send up to 30 files as one transfer entry, with an optional short note. Supply standard base64 for each file. For more than 1 MiB of combined file data, use begin_upload, upload_part and finish_upload." },
  begin_upload: { schema: BeginUpload, description: "Start or resume one transfer of up to 30 files and 100 MiB per file. Declare each file's exact byte size. The result gives bytes already received for each file in input order." },
  upload_part: { schema: UploadPart, description: "Append one standard base64 part of up to 8 MiB using the same idempotency key, a zero-based file index and the byte offset. Send parts in order for each file. Replaying an identical part is safe." },
  finish_upload: { schema: FinishUpload, description: "Publish all files and the optional note as one transfer entry once every file has reached its declared size. Retrying with the same key returns the original receipt." },
};
export const inboxTransferDefinitions = Object.entries(descriptions).map(([name, { schema, description }]) => ({
  name, description, inputSchema: z.toJSONSchema(schema, { io: "input" }),
}));

const TransferRow = z.object({ id: z.number(), body_hash: z.string(), note: z.string(), touched_at: z.number(), result: z.string().nullable() });
const Receipt = z.object({ entry_id: z.number(), files: z.array(z.string()) });
const Id = z.object({ id: z.number() });
const FileRow = z.object({ file: AttachmentId });

type Receipt = z.infer<typeof Receipt>;
export type InboxTransferSource = { id: string; name: string };
export class InboxTransferError extends Error {}

function base64(value: string, maximum: number, limitMessage: string): Buffer {
  const data = Buffer.from(value, "base64");
  if (data.length > maximum) throw new InboxTransferError(limitMessage);
  if (data.toString("base64") !== value) throw new InboxTransferError("Use standard, padded base64 without whitespace.");
  return data;
}

const inlineLimit = "Inline files may contain at most 1 MiB in total. Use begin_upload for larger sends.";

export function createInboxTransfers(database: HubDatabase, clock: Clock) {
  const db = database.connection;
  const store = transferStore(database);
  const select = db.prepare("SELECT id, body_hash, note, touched_at, result FROM inbox_transfers WHERE source = ? AND key = ?");
  const countFresh = db.prepare("SELECT count(*) AS n FROM inbox_transfers WHERE source = ? AND started_at > ?");
  const countPending = db.prepare("SELECT count(*) AS n FROM inbox_transfers WHERE source = ? AND result IS NULL");
  const selectExpired = db.prepare(`SELECT u.id FROM inbox_transfers u JOIN inbox_sources s ON s.id = u.source
    WHERE u.result IS NULL AND (u.touched_at <= ? OR s.revoked_at IS NOT NULL)`);
  const insert = db.prepare("INSERT INTO inbox_transfers (source, key, body_hash, note, started_at, touched_at) VALUES (?, ?, ?, ?, ?, ?)");
  const uploadFiles = db.prepare("SELECT file FROM inbox_transfer_files WHERE upload = ? ORDER BY position");
  const fileAt = db.prepare("SELECT file FROM inbox_transfer_files WHERE upload = ? AND position = ?");
  const stageFile = db.prepare("INSERT INTO inbox_transfer_files (upload, position, file) VALUES (?, ?, ?)");
  const removeStaging = db.prepare("DELETE FROM inbox_transfer_files WHERE upload = ?");
  const removeFile = db.prepare("DELETE FROM transfer_files WHERE id = ?");
  const removeUpload = db.prepare("DELETE FROM inbox_transfers WHERE id = ?");
  const publishEntry = db.prepare("INSERT INTO transfer_entries (title, text, device, created_at) VALUES (?, ?, 'desktop', ?)");
  const publishFile = db.prepare("INSERT INTO transfer_entry_files (entry, file) VALUES (?, ?)");
  const saveReceipt = db.prepare("UPDATE inbox_transfers SET result = ? WHERE id = ?");
  const touch = db.prepare("UPDATE inbox_transfers SET touched_at = ? WHERE id = ?");

  const filesOf = (upload: number) => uploadFiles.all(upload).map((row) => FileRow.parse(row).file);
  const lookup = (source: InboxTransferSource, key: string) => {
    const row = select.get(source.id, key);
    return row === undefined ? undefined : TransferRow.parse(row);
  };
  const receiptOf = (result: string): Receipt => Receipt.parse(JSON.parse(result));
  const discard = (file: string) => rmSync(join(store.root, file), { recursive: true, force: true });
  const transaction = <T>(apply: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = apply();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const prune = (now: number) => {
    for (const row of selectExpired.all(now - idleUploadMs)) {
      const { id } = Id.parse(row);
      const files = filesOf(id);
      if (files.some(store.writing)) continue;
      for (const file of files) discard(file);
      transaction(() => {
        removeUpload.run(id);
        for (const file of files) removeFile.run(file);
      });
    }
  };

  const publish = (source: InboxTransferSource, upload: number, note: string, files: Attachment[], now: number) => {
    const entry = Number(publishEntry.run(source.name, note, now).lastInsertRowid);
    for (const file of files) publishFile.run(entry, file.id);
    const receipt = { entry_id: entry, files: files.map(({ name }) => name) };
    removeStaging.run(upload);
    saveReceipt.run(JSON.stringify(receipt), upload);
    return receipt;
  };

  const progress = (upload: number) => ({
    completed: false,
    files: filesOf(upload).map((id) => ({ name: store.get(id)!.name, received: store.received(id) })),
  });

  const start = (source: InboxTransferSource, args: z.infer<typeof BeginUpload> | z.infer<typeof SendFiles>, mode: "inline" | "parts") => {
    const now = clock.now();
    prune(now);
    const key = args.idempotency_key;
    const hash = createHash("sha256").update(JSON.stringify([mode, args.note ?? "", args.files])).digest("hex");
    const previous = lookup(source, key);
    if (previous !== undefined) {
      if (previous.body_hash !== hash) throw new InboxTransferError("This idempotency key is already in use for a different send.");
      if (mode === "inline") return { data: receiptOf(previous.result!) };
      if (previous.result !== null) return { data: { completed: true, ...receiptOf(previous.result) } };
      return { data: progress(previous.id) };
    }
    if (Number(countFresh.get(source.id, now - 60_000)?.["n"]) >= 60) throw new InboxTransferError("This source can start at most 60 sends per minute. Retry after the rate window resets.");
    if (mode === "parts" && Number(countPending.get(source.id)?.["n"]) >= maximumPending) throw new InboxTransferError("This source already has two pending uploads. Finish an existing upload or wait for it to expire.");
    let remaining = inlineBytes;
    const inputs = args.files.map((file) => {
      if ("size" in file) return { name: file.name, mediaType: file.media_type ?? "", size: file.size };
      const bytes = base64(file.content_base64, remaining, inlineLimit);
      remaining -= bytes.length;
      return { name: file.name, mediaType: file.media_type ?? "", size: bytes.length, bytes };
    });
    const created: Attachment[] = [];
    try {
      return transaction(() => {
        const note = args.note ?? "";
        const upload = Number(insert.run(source.id, key, hash, note, now, now).lastInsertRowid);
        for (const [position, file] of inputs.entries()) {
          const { attachment } = store.create(file);
          created.push(attachment);
          if (file.bytes !== undefined) writeFileSync(store.path(attachment), file.bytes);
          else stageFile.run(upload, position, attachment.id);
        }
        if (mode === "parts") return { data: progress(upload) };
        const receipt = publish(source, upload, note, created, now);
        return { data: receipt, published: receipt };
      });
    } catch (error) {
      for (const file of created) discard(file.id);
      throw error;
    }
  };

  const pending = (source: InboxTransferSource, key: string) => {
    const upload = lookup(source, key);
    if (upload === undefined || (upload.result === null && upload.touched_at <= clock.now() - idleUploadMs)) {
      throw new InboxTransferError("No active upload uses this key. Call begin_upload to start again.");
    }
    return upload;
  };

  const part = async (source: InboxTransferSource, args: z.infer<typeof UploadPart>) => {
    const upload = pending(source, args.idempotency_key);
    if (upload.result !== null) return { data: { completed: true, ...receiptOf(upload.result) } };
    const row = fileAt.get(upload.id, args.file_index);
    if (row === undefined) throw new InboxTransferError("The file index is outside the upload's file list.");
    const { file } = FileRow.parse(row);
    if (store.writing(file)) throw new InboxTransferError("Another part is being written to this file. Retry in order.");
    const bytes = base64(args.content_base64, attachmentPartBytes, "Each part may contain at most 8 MiB.");
    const have = store.received(file);
    const end = args.offset + bytes.length;
    if (end > store.get(file)!.size) throw new InboxTransferError("This part exceeds the declared file size.");
    if (args.offset < have && end <= have && (await store.read(file, args.offset, bytes.length)).equals(bytes)) {
      return { data: { received: have } };
    }
    if (args.offset !== have) throw new InboxTransferError(`Send the next part at byte offset ${have}. Replayed parts must contain identical bytes.`);
    const written = await store.write(file, args.offset, Readable.from([bytes]));
    if (!written.ok) throw new InboxTransferError(`The part could not be written. Retry from byte offset ${written.received}.`);
    touch.run(clock.now(), upload.id);
    return { data: { received: written.received } };
  };

  const finish = (source: InboxTransferSource, { idempotency_key: key }: z.infer<typeof FinishUpload>) => {
    const upload = pending(source, key);
    if (upload.result !== null) return { data: receiptOf(upload.result) };
    const ids = filesOf(upload.id);
    const chosen = store.choose(ids);
    if (!chosen.ok) throw new InboxTransferError(chosen.reason);
    if (ids.some(store.writing)) throw new InboxTransferError("Wait for the current upload parts to finish and retry.");
    const receipt = transaction(() => publish(source, upload.id, upload.note, chosen.attachments, clock.now()));
    return { data: receipt, published: receipt };
  };

  return async (source: InboxTransferSource, name: string, args: unknown): Promise<{ data: unknown; published?: Receipt }> => {
    switch (name) {
      case "send_files": return start(source, SendFiles.parse(args), "inline");
      case "begin_upload": return start(source, BeginUpload.parse(args), "parts");
      case "upload_part": return part(source, UploadPart.parse(args));
      case "finish_upload": return finish(source, FinishUpload.parse(args));
      default: throw new InboxTransferError(`Unknown inbox tool: ${name}`);
    }
  };
}
