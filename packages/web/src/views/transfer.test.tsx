import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { linked } from "./TransferView.js";

describe("transfer links", () => {
  it("escapes text and links only web addresses without trailing punctuation", () => {
    const html = renderToStaticMarkup(<>{linked('<b> https://example.com/a?x=1&y=2. javascript:alert(1)')}</>);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:');
  });
});
