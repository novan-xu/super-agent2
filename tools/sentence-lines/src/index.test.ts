import { describe, expect, it } from "vitest";
import { findSentenceLines } from "./index.js";

describe("Markdown sentence lines", () => {
  it("reports multiple sentences and wrapped sentences with their source lines", () => {
    expect(findSentenceLines("# Heading\n\nFirst sentence. Second sentence!\nA sentence that\ncontinues here.\n")).toEqual([
      { line: 3, message: "multiple sentences on one line" },
      { line: 4, message: "sentence wraps onto the next line" },
    ]);
  });

  it("checks list continuations and sentences without spaces in Chinese", () => {
    expect(findSentenceLines("- First sentence. Second sentence.\n- A wrapped\n  sentence.\n- 第一。第二！第三？\n")).toEqual([
      { line: 1, message: "multiple sentences on one line" },
      { line: 2, message: "sentence wraps onto the next line" },
      { line: 4, message: "multiple sentences on one line" },
    ]);
  });

  it("accepts abbreviations, versions, filenames, ellipses, clauses and short list items", () => {
    const text = [
      "Examples e.g. this, i.e. that, etc. are here vs. there.",
      "Version 1.2.3 and package.json and .md are names... still here.",
      "A clause:",
      "A separate sentence.",
      "", "- Short phrase", "- Another item", "",
    ].join("\n");
    expect(findSentenceLines(text)).toEqual([]);
  });

  it("ignores code, tables, headings, HTML, reference definitions and front matter", () => {
    const text = [
      "---", "title: First. Second.", "description: a wrapped", "  value", "---", "",
      "# First. Second.", "", "| A | B |", "| --- | --- |", "| First. Second. | a |", "",
      "```md", "First. Second.", "a wrapped", "sentence", "```", "",
      "    First. Second.", "", "<div>", "First. Second.", "</div>", "",
      "[ref]: https://example.com/first.second", "",
      "Use `first. second` and [a link](https://example.com/a.b).", "",
    ].join("\n");
    expect(findSentenceLines(text)).toEqual([]);
  });

  it("still checks prose around inline markup and reports original lines", () => {
    expect(findSentenceLines("A **bold sentence.** Another with `code.with.dots`.\n\n[First sentence.](https://example.com) Next sentence.\n")).toEqual([
      { line: 1, message: "multiple sentences on one line" },
      { line: 3, message: "multiple sentences on one line" },
    ]);
  });

  it("ignores newlines inside inline code", () => {
    expect(findSentenceLines("A `code span\nwith dots...` here.\n")).toEqual([]);
  });

  it("handles supplementary Unicode without shifting subsequent text", () => {
    expect(findSentenceLines("😀 First. Second.\n")).toEqual([{ line: 1, message: "multiple sentences on one line" }]);
  });
});
