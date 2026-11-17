import type { DeliveredFile } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";

export interface StoredFile {
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  readonly data: Buffer;
}

export interface TicketFiles {
  put(ticket: number, files: readonly DeliveredFile[]): void;
  list(ticket: number): { readonly name: string; readonly size: number }[];
  get(ticket: number, name: string): StoredFile | undefined;
}

const ListRow = z.object({ name: z.string(), size: z.number().int() });

const FileRow = z.object({ name: z.string(), size: z.number().int(), media_type: z.string(), data: z.instanceof(Uint8Array) });

export function createTicketFiles(database: HubDatabase): TicketFiles {
  const { connection } = database;
  const replace = connection.prepare(
    "INSERT INTO ticket_files (ticket_id, name, size, media_type, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ticket_id, name) DO UPDATE SET size = excluded.size, media_type = excluded.media_type, data = excluded.data",
  );
  const selectList = connection.prepare("SELECT name, size FROM ticket_files WHERE ticket_id = ? ORDER BY name");
  const selectFile = connection.prepare("SELECT name, size, media_type, data FROM ticket_files WHERE ticket_id = ? AND name = ?");
  return {
    put: (ticket, files) => {
      for (const file of files) {
        const data = Buffer.from(file.data, "base64");
        replace.run(ticket, file.name, data.length, file.mediaType, data);
      }
    },
    list: (ticket) => selectList.all(ticket).map((row) => ListRow.parse(row)),
    get: (ticket, name) => {
      const row = selectFile.get(ticket, name);
      if (row === undefined) {
        return undefined;
      }
      const value = FileRow.parse(row);
      return { name: value.name, size: value.size, mediaType: value.media_type, data: Buffer.from(value.data) };
    },
  };
}
