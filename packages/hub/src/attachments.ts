import { randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, rmSync, statSync, truncateSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Attachment, type AttachmentCreate, attachmentRelativePath, type AttachmentUpload } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";

export type WriteOutcome =
  | { readonly ok: true; readonly received: number }
  | { readonly ok: false; readonly error: "not_found" | "conflict" | "bad_request"; readonly received: number };

export type ChosenAttachments = { readonly ok: true; readonly attachments: Attachment[] } | { readonly ok: false; readonly reason: string };

export interface AttachmentStore {
  readonly root: string;
  create(given: AttachmentCreate): AttachmentUpload;
  get(id: string): Attachment | undefined;
  received(id: string): number;
  complete(id: string): boolean;
  writing(id: string): boolean;
  choose(ids: readonly string[]): ChosenAttachments;
  write(id: string, offset: number, body: Readable): Promise<WriteOutcome>;
  open(id: string, range?: { start: number; end: number }): Readable | undefined;
  path(attachment: Attachment): string;
  relative(attachment: Attachment): string;
  read(id: string, offset: number, length: number): Promise<Buffer>;
  grant(ticket: number, attachments: readonly Attachment[]): void;
  granted(ticket: number, id: string): boolean;
}

const Row = z.object({ id: z.string(), name: z.string(), size: z.number().int(), media_type: z.string() });

export const unknownMediaType = "application/octet-stream";

export function attachmentsFolder(dataDir: string): string {
  return join(dataDir, "attachments");
}

export function createAttachmentStore(database: HubDatabase, clock: Clock, root: string = attachmentsFolder(database.dataDir), area: "attachments" | "transfer_files" = "attachments"): AttachmentStore {
  const { connection } = database;
  const insert = connection.prepare(`INSERT INTO ${area} (id, name, size, media_type, created_at) VALUES (?, ?, ?, ?, ?)`);
  const select = connection.prepare(`SELECT id, name, size, media_type FROM ${area} WHERE id = ?`);
  const insertGrant = connection.prepare("INSERT INTO ticket_attachments (ticket_id, attachment_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
  const selectGrant = connection.prepare("SELECT 1 AS granted FROM ticket_attachments WHERE ticket_id = ? AND attachment_id = ?");
  const writing = new Set<string>();

  const get = (id: string): Attachment | undefined => {
    const row = select.get(id);
    if (row === undefined) {
      return undefined;
    }
    const value = Row.parse(row);
    return { id: value.id, name: value.name, size: value.size, mediaType: value.media_type };
  };

  const relative = (attachment: Attachment) => attachmentRelativePath(attachment);
  const path = (attachment: Attachment) => join(root, ...relative(attachment).split("/"));

  const received = (id: string): number => {
    const attachment = get(id);
    if (attachment === undefined) {
      return 0;
    }
    const file = path(attachment);
    return existsSync(file) ? statSync(file).size : 0;
  };

  const complete = (id: string): boolean => {
    const attachment = get(id);
    return attachment !== undefined && received(id) === attachment.size;
  };

  const touch = (file: string) => {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, "a"));
  };

  return {
    root,
    create: (given) => {
      const id = randomBytes(16).toString("hex");
      const mediaType = given.mediaType.trim() === "" ? unknownMediaType : given.mediaType.trim().toLowerCase();
      const attachment: Attachment = { id, name: given.name, size: given.size, mediaType };
      const directory = join(root, id);
      mkdirSync(root, { recursive: true });
      mkdirSync(directory);
      try {
        closeSync(openSync(path(attachment), "wx"));
        insert.run(id, given.name, given.size, mediaType, clock.now());
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return { attachment, received: 0 };
    },
    get,
    received,
    complete,
    writing: (id) => writing.has(id),
    choose: (ids) => {
      const chosen: Attachment[] = [];
      for (const id of new Set(ids)) {
        const attachment = get(id);
        if (attachment === undefined) {
          return { ok: false, reason: `There is no attachment ${id}` };
        }
        if (!complete(id)) {
          return { ok: false, reason: `The attachment ${attachment.name} has not finished uploading` };
        }
        chosen.push(attachment);
      }
      return { ok: true, attachments: chosen };
    },
    write: async (id, offset, body) => {
      const attachment = get(id);
      if (attachment === undefined) {
        body.resume();
        return { ok: false, error: "not_found", received: 0 };
      }
      const file = path(attachment);
      if (writing.has(id)) {
        body.resume();
        return { ok: false, error: "conflict", received: received(id) };
      }
      writing.add(id);
      try {
        touch(file);
        const have = statSync(file).size;
        if (offset > have || offset > attachment.size) {
          body.resume();
          return { ok: false, error: "conflict", received: have };
        }
        if (offset < have) {
          truncateSync(file, offset);
        }
        let position = offset;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            position += chunk.length;
            done(position > attachment.size ? new Error("beyond the declared size") : null, chunk);
          },
        });
        try {
          await pipeline(body, bounded, createWriteStream(file, { flags: "a" }));
        } catch {
          const now = statSync(file).size;
          if (position > attachment.size) {
            truncateSync(file, offset);
            return { ok: false, error: "bad_request", received: offset };
          }
          return { ok: false, error: "conflict", received: Math.min(now, attachment.size) };
        }
        return { ok: true, received: statSync(file).size };
      } finally {
        writing.delete(id);
      }
    },
    open: (id, range) => {
      const attachment = get(id);
      return attachment === undefined || !complete(id) ? undefined : createReadStream(path(attachment), range);
    },
    path,
    relative,
    read: async (id, offset, length) => {
      const attachment = get(id);
      if (attachment === undefined) {
        throw new Error(`There is no attachment ${id}`);
      }
      const handle = await open(path(attachment), "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, attachment.size - offset)));
        let read = 0;
        while (read < buffer.length) {
          const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read);
          if (bytesRead === 0) {
            break;
          }
          read += bytesRead;
        }
        return buffer.subarray(0, read);
      } finally {
        await handle.close();
      }
    },
    grant: (ticket, attachments) => {
      for (const attachment of attachments) {
        insertGrant.run(ticket, attachment.id);
      }
    },
    granted: (ticket, id) => selectGrant.get(ticket, id) !== undefined,
  };
}
