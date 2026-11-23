import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HandbackScreenshot, screenshotBytes, screenshotImage, type ScreenshotFile } from "@super-agent2/protocol";

export function screenshotFolder(folder: string): string {
  return join(folder, "screenshots");
}

export function screenshotTransferFolder(folder: string, ticket: number, attempt: number): string {
  return join(folder, `screenshots-t${ticket}-a${attempt}`);
}

export function stageScreenshots(folder: string, ticket: number, attempt: number, given: readonly HandbackScreenshot[]): ScreenshotFile[] {
  const source = screenshotFolder(folder);
  const target = screenshotTransferFolder(folder, ticket, attempt);
  if (!lstatSync(source).isDirectory()) throw new Error(`Put the images in the regular directory ${source}.`);
  const names = new Set(given.map(({ file }) => file.toLowerCase()));
  if (names.size !== given.length) throw new Error("Use a different file for every screenshot.");
  mkdirSync(target, { recursive: true });
  if (!lstatSync(target).isDirectory()) throw new Error(`${target} must be a regular directory.`);
  const prepared = given.map(({ file, ...label }) => {
    const path = join(source, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > screenshotBytes) throw new Error(`${path} must be a regular image file no larger than 2 MiB.`);
    const isPng = /\.png$/i.test(file);
    const mediaType = isPng ? "image/png" : "image/jpeg";
    const bytes = readFileSync(path);
    if (bytes.length > screenshotBytes || !screenshotImage(bytes, mediaType)) throw new Error(`${path} is not a valid ${mediaType} screenshot of at most 2 MiB.`);
    const name = `image-${randomUUID()}.${isPng ? "png" : "jpg"}`;
    return { file: { ...label, name, size: bytes.length, mediaType }, bytes } as const;
  });
  for (const { file, bytes } of prepared) writeFileSync(join(target, file.name), bytes, { flag: "wx" });
  return prepared.map(({ file }) => file);
}
