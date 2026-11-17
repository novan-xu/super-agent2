import { describe, expect, it } from "vitest";
import { chineseOf, GeneratedText } from "./generated.js";
import { z } from "zod";

describe("GeneratedText", () => {
  it("accepts the English original with its Chinese copy", () => {
    expect(GeneratedText.parse({ en: "Add the login page", zh: "添加登录页面" })).toEqual({ en: "Add the login page", zh: "添加登录页面" });
  });

  it("refuses a message without its Chinese copy", () => {
    expect(GeneratedText.safeParse({ en: "Add the login page" }).success).toBe(false);
  });

  it("refuses an empty or blank Chinese copy", () => {
    expect(GeneratedText.safeParse({ en: "Add the login page", zh: "" }).success).toBe(false);
    expect(GeneratedText.safeParse({ en: "Add the login page", zh: "   " }).success).toBe(false);
  });

  it("refuses a Chinese copy that is not Chinese", () => {
    expect(GeneratedText.safeParse({ en: "Add the login page", zh: "Add the login page" }).success).toBe(false);
  });

  it("refuses a message without its English original", () => {
    expect(GeneratedText.safeParse({ zh: "添加登录页面" }).success).toBe(false);
    expect(GeneratedText.safeParse({ en: "  ", zh: "添加登录页面" }).success).toBe(false);
  });

  it("refuses a plain string where generated text is expected", () => {
    expect(GeneratedText.safeParse("添加登录页面").success).toBe(false);
  });

  it("accepts a Chinese copy that keeps a proper noun", () => {
    expect(GeneratedText.safeParse({ en: "Restart the NAS", zh: "重启 NAS" }).success).toBe(true);
  });

  it("is refused at the boundary of a message that carries it", () => {
    const Notice = z.object({ title: GeneratedText, reason: GeneratedText });
    const result = Notice.safeParse({ title: { en: "Stopped", zh: "已停止" }, reason: { en: "The build failed" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["reason", "zh"]);
  });

  it("gives the Chinese copy to show", () => {
    expect(chineseOf({ en: "Stopped", zh: "已停止" })).toBe("已停止");
  });
});
