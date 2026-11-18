import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeContent, claudeImageBytes } from "./claude.js";
import { codexInput } from "./codex.js";
import { dshContent, dshImageBytes } from "./dsh.js";

const folder = mkdtempSync(join(tmpdir(), "program-images-"));
const png = join(folder, "red.png");
writeFileSync(png, Buffer.from([137, 80, 78, 71]));
const image = { path: png, mediaType: "image/PNG", size: 4 };
const heic = { path: join(folder, "photo.heic"), mediaType: "image/heic", size: 4 };

describe("images given to each program", () => {
  it("go to Claude Code as base64 image blocks after the text", () => {
    expect(claudeContent("look", [])).toBe("look");
    expect(claudeContent("look", [image, heic])).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") } },
    ]);
    expect(claudeContent("look", [{ ...image, size: claudeImageBytes + 1 }])).toBe("look");
    expect(claudeContent("look", [{ ...image, path: join(folder, "gone.png") }])).toBe("look");
  });

  it("go to Codex as local images by path", () => {
    expect(codexInput("look", [image, heic])).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: png },
    ]);
  });

  it("go to dsh as encoded image blocks within its own limits", () => {
    expect(dshContent("look", [image, heic, { ...image, size: dshImageBytes + 1 }])).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: Buffer.from([137, 80, 78, 71]).toString("base64"), mimeType: "image/png" },
    ]);
  });
});
