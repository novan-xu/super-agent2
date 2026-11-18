import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Previews } from "./previews.js";

const root = mkdtempSync(join(tmpdir(), "previews-"));
afterEach(() => rmSync(root, { force: true, recursive: true }));
const file = (name: string) => ({ name, size: 3, open: () => Readable.from([Buffer.from("abc")]) });

describe("Office previews", () => {
  it("shares concurrent conversions and caches by content across files", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect((form.get("files") as File).name).toBe("document.docx");
      return new Response("%PDF-example");
    });
    const previews = new Previews(root, "http://converter", fetcher);
    const paths = await Promise.all([previews.pdf(file("private.docx")), previews.pdf(file("other.docx"))]);
    expect(paths[0]).toBe(paths[1]);
    expect(readFileSync(paths[0]!, "utf8")).toBe("%PDF-example");
    await previews.pdf(file("sheet.xlsx"));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects failed and invalid conversions and allows retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("no", { status: 500 })).mockResolvedValueOnce(new Response("bad"));
    const previews = new Previews(root, "http://converter", fetcher);
    await expect(previews.pdf(file("slides.pptx"))).rejects.toThrow("could not convert");
    await expect(previews.pdf(file("slides.pptx"))).rejects.toThrow("invalid PDF");
    await expect(previews.pdf({ ...file("large.docx"), size: 64 * 1024 * 1024 + 1 })).rejects.toThrow("64 MiB");
  });
});
