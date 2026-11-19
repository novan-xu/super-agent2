import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { linked, RecentFiles } from "./TransferView.js";

describe("transfer links", () => {
  it("escapes text and links only web addresses without trailing punctuation", () => {
    const html = renderToStaticMarkup(<>{linked('<b> https://example.com/a?x=1&y=2. javascript:alert(1)')}</>);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:');
  });
});


describe("recent transfer files", () => {
  it("shows loaded files newest first with device, size and transfer links", () => {
    const file = (id: string, name: string) => ({ id, name, size: 1024, mediaType: "text/plain" });
    const items = [
      { seq: 1, text: "", device: "phone" as const, at: 1000, files: [file("a", "older.txt")] },
      { seq: 2, text: "", device: "desktop" as const, at: 2000, files: [file("b", "newer.txt")] },
    ];
    const html = renderToStaticMarkup(<RecentFiles items={items} open={() => {}} />);
    expect(html.indexOf("newer.txt")).toBeLessThan(html.indexOf("older.txt"));
    expect(html).toContain('/api/transfer/files/b');
    expect(html).toContain("来自手机");
    expect(html).toContain("来自桌面");
    expect(html).toContain("1 KB");
    expect(renderToStaticMarkup(<RecentFiles items={items.slice(0, 1)} open={() => {}} />)).not.toContain("newer.txt");
  });
});
