import { describe, expect, it } from "vitest";
import { canDrawBytes, decodeText, delimiterOf, kindOf, parseTable, svgImage, TEXT_BYTES } from "./filekind.js";

describe("file viewer kinds", () => {
  it("prefers extensions and recognizes HTML", () => {
    expect(kindOf({ name: "x.svg", mime: "text/html" })).toBe("vector");
    expect(kindOf({ name: "x.html", mime: "image/png" })).toBe("html");
    expect(kindOf({ name: "x.HTM", mime: "" })).toBe("html");
    expect(kindOf({ name: "x", mime: "text/html; charset=utf-8" })).toBe("html");
    expect(kindOf({ name: "x.js", mime: "text/html" })).toBe("text");
    expect(kindOf({ name: "x", mime: "application/pdf" })).toBe("pdf");
    expect(kindOf({ name: "x.docx", mime: "" })).toBe("office");
    expect(TEXT_BYTES).toBe(5 * 1024 * 1024);
  });
  it("limits byte-drawn files and wraps SVG as an image", async () => {
    expect(canDrawBytes(TEXT_BYTES)).toBe(true);
    expect(canDrawBytes(TEXT_BYTES + 1)).toBe(false);
    const image = svgImage(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'));
    expect(image.type).toBe("image/svg+xml");
    expect(await image.text()).toContain("<script>");
  });
  it("decodes UTF-16 and handles quoted tables with a row limit", () => {
    expect(decodeText(new Uint8Array([255, 254, 65, 0]))).toBe("A");
    expect(delimiterOf("a\tb", "x.tsv")).toBe("\t");
    const table = parseTable('"a,b",c\n' + 'x,y\n'.repeat(2001));
    expect(table.rows).toHaveLength(2000);
    expect(table.rows[0]).toEqual(["a,b", "c"]);
    expect(table.total).toBe(2002);
  });
});
