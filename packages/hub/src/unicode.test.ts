import { describe, expect, it } from "vitest";
import { cmdSpacesAsSpaces, foldLookAlikes } from "./unicode.js";

describe("folding look-alikes", () => {
  it("drops invisible characters and folds look-alike letters, spaces, dashes and separators", () => {
    expect(foldLookAlikes("g​h‮ rеpo ––yes ｇｈ；∕x", "posix")).toBe("gh repo --yes gh;/x");
  });

  it("keeps the quotes a reading accepts and drops the others", () => {
    expect(foldLookAlikes("“a” ＂b＂", "powershell")).toBe("“a” b");
    expect(foldLookAlikes("“a” ＂b＂", "posix")).toBe("a b");
  });

  it("leaves other text alone and reaches a fixed point", () => {
    const text = "提交：完成 😀 café Ünïcödé сборка";
    const folded = foldLookAlikes(text, "posix");
    expect(folded).toContain("提交:完成 😀 café Ünïcödé");
    expect(foldLookAlikes(folded, "posix")).toBe(folded);
    expect(foldLookAlikes("plain ascii", "powershell")).toBe("plain ascii");
  });

  it("reads cmd's white space as spaces", () => {
    expect(cmdSpacesAsSpaces("rd /s᠎/q　x​y")).toBe("rd /s /q x​y");
  });
});
