import { describe, expect, it, vi } from "vitest";

const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument }));

import { showPdf } from "./pdf.js";

describe("PDF loading", () => {
  it("loads from the local URL with WebAssembly and XFA disabled and releases failures", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    getDocument.mockReturnValue({ promise: Promise.reject(new Error("bad PDF")), destroy });
    await expect(showPdf({} as HTMLElement, "/api/file")).rejects.toThrow("bad PDF");
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "/api/file", useWasm: false, enableXfa: false, cMapUrl: "/pdfjs/cmaps/" }));
    expect(destroy).toHaveBeenCalledOnce();
  });
});
