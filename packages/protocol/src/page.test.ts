import { describe, expect, it } from "vitest";
import { pagePath, pageRoute } from "./page.js";

describe("pageRoute", () => {
  it("reads every view of the page", () => {
    expect(pageRoute("/")).toEqual({ view: "home" });
    expect(pageRoute("/workbench")).toEqual({ view: "workbench" });
    expect(pageRoute("/history")).toEqual({ view: "history" });
    expect(pageRoute("/memory")).toEqual({ view: "memory" });
    expect(pageRoute("/settings/")).toEqual({ view: "settings" });
    expect(pageRoute("/conversations")).toEqual({ view: "conversations", conversation: null });
    expect(pageRoute("/conversations/abc-123")).toEqual({ view: "conversations", conversation: "abc-123" });
  });

  it("refuses paths the page does not have", () => {
    for (const path of ["", "/api", "/assets/index.js", "/ws", "/health", "/conversations/a/b", "/memory/x", "/conversations/a.b", "/Workbench"]) {
      expect(pageRoute(path)).toBeUndefined();
    }
  });

  it("writes the path it reads", () => {
    for (const path of ["/", "/workbench", "/conversations", "/conversations/abc", "/history", "/memory", "/settings"]) {
      const route = pageRoute(path);
      expect(route).toBeDefined();
      if (route !== undefined) {
        expect(pagePath(route)).toBe(path);
      }
    }
  });
});
