import { attachmentPartBytes, type AttachmentUpload } from "@super-agent2/protocol";
import type { Answer } from "../hub/api.js";

export interface UploadApi {
  createAttachment(name: string, size: number, mediaType: string): Promise<Answer<AttachmentUpload>>;
  uploadState(id: string): Promise<Answer<AttachmentUpload>>;
  uploadPart(id: string, offset: number, part: Blob): Promise<Answer<AttachmentUpload>>;
}

export interface Source {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  slice(start: number, end: number): Blob;
}

export type UploadOutcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly id: string | null };

export interface Progress {
  (id: string, received: number): void;
}

const conflictsInARow = 3;

export function nameOf(source: Source, index: number, now: number): string {
  if (source.name.trim() !== "") {
    return source.name;
  }
  const extension = source.type.startsWith("image/") ? `.${source.type.slice(6).split("+")[0] ?? "png"}` : "";
  return `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${index + 1}${extension}`;
}

export async function upload(source: Source, name: string, api: UploadApi, known: string | null, progress: Progress, partBytes: number = attachmentPartBytes): Promise<UploadOutcome> {
  let id = known;
  let received = 0;
  if (id === null) {
    const created = await api.createAttachment(name, source.size, source.type);
    if (!created.ok) {
      return { ok: false, id: null };
    }
    id = created.value.attachment.id;
  } else {
    const state = await api.uploadState(id);
    if (!state.ok) {
      return { ok: false, id };
    }
    received = state.value.received;
  }
  progress(id, received);
  let conflicts = 0;
  while (received < source.size) {
    const answer = await api.uploadPart(id, received, source.slice(received, Math.min(source.size, received + partBytes)));
    if (answer.ok) {
      conflicts = 0;
      received = answer.value.received;
      progress(id, received);
      continue;
    }
    conflicts += 1;
    if (answer.error !== "conflict" || conflicts >= conflictsInARow) {
      return { ok: false, id };
    }
    const state = await api.uploadState(id);
    if (!state.ok) {
      return { ok: false, id };
    }
    received = state.value.received;
    progress(id, received);
  }
  return { ok: true, id };
}
