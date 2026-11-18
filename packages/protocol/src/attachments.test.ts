import { describe, expect, it } from "vitest";
import { AttachmentCreate, attachmentRelativePath, isNativeImage, OwnerMessage, storedName, WorkerMessage } from "./index.js";

describe("an attachment's stored name", () => {
  it("keeps an ordinary name as it is, in any language", () => {
    expect(storedName("IMG_0042.JPG")).toBe("IMG_0042.JPG");
    expect(storedName("合同 草稿.pdf")).toBe("合同 草稿.pdf");
  });

  it("never becomes a path or a name Windows or macOS would refuse", () => {
    expect(storedName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(storedName("C:\\Windows\\win.ini")).toBe("C__Windows_win.ini");
    expect(storedName('a<b>c:d"e|f?g*h')).toBe("a_b_c_d_e_f_g_h");
    expect(storedName("..")).toBe("file");
    expect(storedName("   ")).toBe("file");
    expect(storedName("name. ")).toBe("name");
    expect(storedName("CON")).toBe("_CON");
    expect(storedName("nul.txt")).toBe("_nul.txt");
    expect(storedName("tab\there\u0000.txt")).toBe("tab_here_.txt");
  });

  it("is short enough for every file system and keeps the extension", () => {
    const long = `${"长".repeat(200)}.jpeg`;
    const stored = storedName(long);
    expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(180);
    expect(stored.endsWith(".jpeg")).toBe(true);
  });

  it("sits in a folder of its own, named by the attachment's id", () => {
    expect(attachmentRelativePath({ id: "f".repeat(32), name: "../x.png" })).toBe(`${"f".repeat(32)}/_x.png`);
  });
});

describe("messages with attachments", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("may be attachments alone, but not empty", () => {
    expect(OwnerMessage.safeParse({ text: "  ", attachments: [id] }).success).toBe(true);
    expect(OwnerMessage.safeParse({ text: "  " }).success).toBe(false);
    expect(OwnerMessage.parse({ text: "hi" })).toEqual({ text: "hi", attachments: [] });
    expect(WorkerMessage.safeParse({ text: "", attachments: [id] }).success).toBe(true);
    expect(WorkerMessage.safeParse({ text: "" }).success).toBe(false);
    expect(WorkerMessage.safeParse({ text: "x", other: 1 }).success).toBe(false);
    expect(OwnerMessage.safeParse({ text: "x", attachments: ["../x"] }).success).toBe(false);
  });

  it("have no size or count limit of their own", () => {
    expect(AttachmentCreate.safeParse({ name: "video.mov", size: 900 * 1024 * 1024 * 1024, mediaType: "video/quicktime" }).success).toBe(true);
    expect(OwnerMessage.safeParse({ text: "", attachments: Array.from({ length: 500 }, () => id) }).success).toBe(true);
  });

  it("show only the image types every program reads as images", () => {
    expect(["image/png", "image/JPEG", "image/gif", "image/webp"].every(isNativeImage)).toBe(true);
    expect(["image/heic", "image/svg+xml", "application/pdf"].some(isNativeImage)).toBe(false);
  });
});
