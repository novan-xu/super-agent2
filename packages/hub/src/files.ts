import { closeSync, createReadStream, existsSync, mkdirSync, openSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { DeliveredFile } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";

export interface StoredFile {
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  open(): Readable;
}

export interface TicketFiles {
  staged(ticket: number, attempt: number, part: number): number;
  append(ticket: number, attempt: number, part: number, offset: number, data: Buffer): number;
  keep(ticket: number, attempt: number, files: readonly DeliveredFile[]): void;
  drop(ticket: number, attempt: number): void;
  list(ticket: number): { readonly name: string; readonly size: number }[];
  get(ticket: number, name: string): StoredFile | undefined;
}

const ListRow = z.object({ name: z.string(), size: z.number().int() });

const FileRow = z.object({
  name: z.string(),
  size: z.number().int(),
  media_type: z.string(),
  data: z.instanceof(Uint8Array).nullable(),
  attempt: z.number().int().nullable(),
  part: z.number().int().nullable(),
});

export function ticketFilesFolder(dataDir: string): string {
  return join(dataDir, "files");
}

export function createTicketFiles(database: HubDatabase, folder: string = ticketFilesFolder(database.dataDir)): TicketFiles {
  const { connection } = database;
  const replace = connection.prepare(
    "INSERT INTO ticket_files (ticket_id, name, size, media_type, data, attempt, part) VALUES (?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (ticket_id, name) DO UPDATE SET size = excluded.size, media_type = excluded.media_type, data = NULL, attempt = excluded.attempt, part = excluded.part",
  );
  const selectList = connection.prepare("SELECT name, size FROM ticket_files WHERE ticket_id = ? ORDER BY name");
  const selectFile = connection.prepare("SELECT name, size, media_type, data, attempt, part FROM ticket_files WHERE ticket_id = ? AND name = ?");
  const attemptFolder = (ticket: number, attempt: number) => join(folder, `t${ticket}`, `a${attempt}`);
  const partPath = (ticket: number, attempt: number, part: number) => join(attemptFolder(ticket, attempt), String(part));

  const staged = (ticket: number, attempt: number, part: number): number => {
    const path = partPath(ticket, attempt, part);
    return existsSync(path) ? statSync(path).size : 0;
  };

  return {
    staged,
    append: (ticket, attempt, part, offset, data) => {
      mkdirSync(attemptFolder(ticket, attempt), { recursive: true });
      const path = partPath(ticket, attempt, part);
      const size = staged(ticket, attempt, part);
      if (offset > size) {
        return size;
      }
      if (offset < size) {
        truncateSync(path, offset);
      }
      const handle = openSync(path, "a");
      try {
        let written = 0;
        while (written < data.length) {
          written += writeSync(handle, data, written, data.length - written);
        }
      } finally {
        closeSync(handle);
      }
      return offset + data.length;
    },
    keep: (ticket, attempt, files) => {
      files.forEach((file, part) => {
        replace.run(ticket, file.name, file.size, file.mediaType, attempt, part);
      });
    },
    drop: (ticket, attempt) => {
      rmSync(attemptFolder(ticket, attempt), { recursive: true, force: true });
    },
    list: (ticket) => selectList.all(ticket).map((row) => ListRow.parse(row)),
    get: (ticket, name) => {
      const row = selectFile.get(ticket, name);
      if (row === undefined) {
        return undefined;
      }
      const value = FileRow.parse(row);
      const inline = value.data;
      if (inline !== null) {
        return { name: value.name, size: inline.length, mediaType: value.media_type, open: () => Readable.from([Buffer.from(inline)]) };
      }
      if (value.attempt === null || value.part === null) {
        return undefined;
      }
      const path = partPath(ticket, value.attempt, value.part);
      if (!existsSync(path)) {
        return undefined;
      }
      return { name: value.name, size: statSync(path).size, mediaType: value.media_type, open: () => createReadStream(path) };
    },
  };
}
