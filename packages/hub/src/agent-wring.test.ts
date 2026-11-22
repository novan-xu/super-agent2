import { describe, expect, it } from "vitest";
import { articleName, uniqueArticleName } from "./agent-wring.js";

const product = "cc992985d3ce4559";
const fallback = `${product}.html`;

describe("Agent_wring article names", () => {
  it.each([
    [null, fallback],
    ["inline; filename=plain.html", "plain.html"],
    ['inline; filename="semi;colon.html"', "semi;colon.html"],
    ["inline; filename=plain.html; filename*=UTF-8''%E6%96%87%E7%AB%A0.html", "文章.html"],
    ["inline; filename=plain.html; filename*=UTF-8''%ZZ.html", "plain.html"],
    ['inline; filename="../unsafe.html"', fallback],
    ["inline; filename*=UTF-8''bad%5Cname.html", fallback],
    ["inline; filename*=UTF-8''bad%00name.html", fallback],
    ["inline; filename=article.txt", fallback],
    ["inline; filename=one.html; filename=two.html", fallback],
  ])("reads %s", (header, expected) => expect(articleName(header, product)).toBe(expected));

  it("avoids collisions with existing suffixes and respects the name length limit", () => {
    const used = new Set<string>();
    expect(uniqueArticleName("title.html", used)).toBe("title.html");
    expect(uniqueArticleName("title (2).html", used)).toBe("title (2).html");
    expect(uniqueArticleName("title.html", used)).toBe("title (3).html");
    const long = `${"文".repeat(115)}.html`;
    expect(uniqueArticleName(long, used)).toBe(long);
    expect(Array.from(uniqueArticleName(long, used))).toHaveLength(120);
  });
});
