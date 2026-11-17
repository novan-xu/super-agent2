import { describe, expect, it } from "vitest";
import { codePointLabel, rawSegments } from "./raw.js";

describe("rawSegments", () => {
  it("keeps an ordinary command whole, with its lines and tabs", () => {
    const command = "set -e\n\tgh repo delete 'a b' --yes && echo 完成";
    expect(rawSegments(command)).toEqual([{ text: command, hidden: false }]);
  });

  it("keeps a Windows line ending as it is", () => {
    expect(rawSegments("a\r\nb")).toEqual([{ text: "a\r\nb", hidden: false }]);
  });

  it("shows what cannot be seen", () => {
    expect(rawSegments("rm​ -rf x‮")).toEqual([
      { text: "rm", hidden: false },
      { text: "U+200B", hidden: true },
      { text: " -rf", hidden: false },
      { text: "U+00A0", hidden: true },
      { text: "x", hidden: false },
      { text: "U+202E", hidden: true },
    ]);
  });

  it("shows a lone carriage return and a control character", () => {
    expect(rawSegments("a\rb\u0007")).toEqual([
      { text: "a", hidden: false },
      { text: "U+000D", hidden: true },
      { text: "b", hidden: false },
      { text: "U+0007", hidden: true },
    ]);
  });

  it("shows blank-looking letters", () => {
    expect(rawSegments("aㅤb").map((segment) => segment.hidden)).toEqual([false, true, false]);
  });

  it("gives back every visible character in order, so nothing is lost", () => {
    const command = "echo 😀 ‍ done";
    const visible = rawSegments(command)
      .filter((segment) => !segment.hidden)
      .map((segment) => segment.text)
      .join("");
    expect(visible).toBe("echo 😀  done");
  });

  it("names a code point with at least four digits", () => {
    expect(codePointLabel("‮")).toBe("U+202E");
    expect(codePointLabel("\u{1f600}")).toBe("U+1F600");
    expect(codePointLabel("\u0007")).toBe("U+0007");
  });
});
