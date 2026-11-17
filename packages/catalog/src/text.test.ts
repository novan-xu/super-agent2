import { describe, expect, expectTypeOf, it } from "vitest";
import { messages, type MessageKey } from "./messages.js";
import { text, type Value, type Values } from "./text.js";

const keys = Object.keys(messages) as MessageKey[];

const keptAsTheyAre = ["Super-agent2", "hub", "GitHub", "macOS", "Windows", "Claude Code", "Codex", "dsh", "Antigravity", "PR", "Woodpecker", "Cloudflare", "nas", "GPT", "Claude", "DeepSeek", "Apple", "Chrome", "Firefox", "Edge"];

function withoutPlaceholders(value: string): string {
  return value.replace(/\{\w+\}/g, "");
}

describe("text", () => {
  it("returns a message without placeholders as it is", () => {
    expect(text("navigation.workbench")).toBe("工作台");
  });

  it("inserts values into a sentence", () => {
    expect(text("command.reason.noTarget", { target: "elsewhere" })).toBe("没有名为 elsewhere 的执行目标");
    expect(text("hold.reason", { description: "删除仓库", evidence: "gh repo delete x" })).toBe("等你确认：删除仓库（gh repo delete x）");
  });

  it("inserts a number as its digits", () => {
    expect(text("command.reason.noToken", { variable: "TOKEN", account: 3 })).toBe("没有设置 TOKEN，hub 拿不到 3 的 GitHub 令牌");
  });

  it("leaves no placeholder behind in an inserted value", () => {
    expect(text("command.reason.noTarget", { target: "{target}" })).toBe("没有名为 {target} 的执行目标");
  });

  it("types a missing or misspelled key, a missing value and an extra value as errors", () => {
    expectTypeOf<"navigation.missing">().not.toExtend<MessageKey>();
    expectTypeOf<"navigation.workbench">().toExtend<MessageKey>();
    expectTypeOf<Values<"navigation.workbench">>().toEqualTypeOf<[]>();
    expectTypeOf<Values<"hold.reason">>().toEqualTypeOf<[values: { readonly description: Value; readonly evidence: Value }]>();
    expectTypeOf<Values<"command.reason.noTarget">>().toEqualTypeOf<[values: { readonly target: Value }]>();
  });
});

describe("messages", () => {
  it("has a key for every navigation item of the design", () => {
    expect(text("navigation.workbench")).toBe("工作台");
    expect(text("navigation.conversation")).toBe("对话");
    expect(text("navigation.history")).toBe("历史");
    expect(text("navigation.memory")).toBe("记忆");
    expect(text("navigation.settings")).toBe("设置");
  });

  it.each(keys)("%s is Chinese and holds no other English", (key) => {
    const value = withoutPlaceholders(messages[key]);
    let rest = value;
    for (const term of keptAsTheyAre) {
      rest = rest.split(term).join("");
    }
    expect(rest).not.toMatch(/[A-Za-z]/);
    if (!keptAsTheyAre.includes(value)) {
      expect(value).toMatch(/\p{Script=Han}/u);
    }
  });

  it("holds no placeholder that is not a plain name", () => {
    for (const key of keys) {
      expect(messages[key].replace(/\{\w+\}/g, "")).not.toMatch(/[{}]/);
    }
  });
});
