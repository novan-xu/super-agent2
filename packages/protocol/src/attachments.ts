import { z } from "zod";

export const attachmentsPath = "/api/attachments";

export const attachmentPartBytes = 8 * 1024 * 1024;

export const AttachmentId = z.string().regex(/^[0-9a-f]{32}$/);
export type AttachmentId = z.infer<typeof AttachmentId>;

export const Attachment = z.object({
  id: AttachmentId,
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
});
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentCreate = z.object({
  name: z.string().trim().min(1),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
});
export type AttachmentCreate = z.infer<typeof AttachmentCreate>;

export const AttachmentUpload = z.object({
  attachment: Attachment,
  received: z.number().int().nonnegative(),
});
export type AttachmentUpload = z.infer<typeof AttachmentUpload>;

export const nativeImageTypes: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function isNativeImage(mediaType: string): boolean {
  return nativeImageTypes.includes(mediaType.toLowerCase());
}

const reservedNames = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

const storedNameBytes = 180;

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

function within(characters: readonly string[], bytes: number): string {
  let kept = "";
  for (const character of characters) {
    if (bytesOf(kept + character) > bytes) {
      break;
    }
    kept += character;
  }
  return kept;
}

export function storedName(name: string): string {
  const cleaned = [...name.normalize("NFC")]
    .map((character) => (/[/\\:*?"<>|\u0000-\u001f\u007f]/u.test(character) ? "_" : character))
    .join("")
    .replace(/^[\s.]+/u, "")
    .replace(/[\s.]+$/u, "");
  const base = cleaned === "" ? "file" : reservedNames.test(cleaned) ? `_${cleaned}` : cleaned;
  if (bytesOf(base) <= storedNameBytes) {
    return base;
  }
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 && bytesOf(base.slice(dot)) <= 24 ? base.slice(dot) : "";
  return `${within([...base.slice(0, base.length - extension.length)], storedNameBytes - bytesOf(extension))}${extension}`;
}

export function attachmentRelativePath(attachment: Pick<Attachment, "id" | "name">): string {
  return `${attachment.id}/${storedName(attachment.name)}`;
}

export function attachmentLine(attachment: Attachment, path: string): string {
  return `${attachment.name} (${attachment.mediaType || "unknown type"}, ${attachment.size} bytes) at ${path}`;
}
