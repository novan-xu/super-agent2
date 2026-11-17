import { describe, expect, it } from "vitest";
import { openMessage, pickWindow, readPush, targetOf } from "./notification.js";

const payload = { title: "等你", body: "有一条命令等你确认", tag: "hold:abc", url: "/workbench?card=hold%3Aabc" };

describe("readPush", () => {
  it("shows what the hub sent, with the address to open", () => {
    expect(readPush(payload)).toEqual({
      title: "等你",
      options: { body: "有一条命令等你确认", tag: "hold:abc", icon: "/icons/icon-192.png", data: { url: "/workbench?card=hold%3Aabc" } },
    });
  });

  it("shows nothing for a message that is not what the hub sends", () => {
    for (const bad of [null, "text", 4, [], {}, { ...payload, title: "" }, { ...payload, body: 3 }, { ...payload, tag: undefined }, { ...payload, url: "https://elsewhere.example.com/" }, { ...payload, url: "//elsewhere.example.com/" }, { ...payload, url: "workbench" }]) {
      expect(readPush(bad)).toBeUndefined();
    }
  });

  it("adds nothing of its own to the text", () => {
    const shown = readPush({ ...payload, extra: "gh repo delete" });
    expect(JSON.stringify(shown)).not.toContain("gh repo delete");
  });
});

describe("targetOf", () => {
  it("reads the address a notification carries", () => {
    expect(targetOf({ url: "/workbench?card=x" })).toBe("/workbench?card=x");
  });

  it("refuses an address that leaves the site", () => {
    expect(targetOf({ url: "https://elsewhere.example.com/" })).toBeUndefined();
    expect(targetOf({ url: "//elsewhere.example.com" })).toBeUndefined();
    expect(targetOf({ url: "/\\elsewhere.example.com" })).toBeUndefined();
    expect(targetOf(undefined)).toBeUndefined();
    expect(targetOf("x")).toBeUndefined();
  });
});

describe("pickWindow", () => {
  const pages = [
    { name: "a", focused: false, visibilityState: "hidden" },
    { name: "b", focused: false, visibilityState: "visible" },
    { name: "c", focused: true, visibilityState: "visible" },
  ];

  it("prefers the window in use, then one in view, then any", () => {
    expect(pickWindow(pages)?.name).toBe("c");
    expect(pickWindow(pages.slice(0, 2))?.name).toBe("b");
    expect(pickWindow(pages.slice(0, 1))?.name).toBe("a");
  });

  it("finds nothing when no window is open, so a new one is opened", () => {
    expect(pickWindow([])).toBeUndefined();
  });
});

describe("openMessage", () => {
  it("tells an open page where to go", () => {
    expect(openMessage("/workbench")).toEqual({ type: "open", url: "/workbench" });
  });
});
