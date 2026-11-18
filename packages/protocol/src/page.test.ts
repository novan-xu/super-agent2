import { describe, expect, it } from "vitest";
import { pagePath, pageRoute } from "./page.js";

describe("pageRoute", () => {
  it("reads every view of the page", () => {
    expect(pageRoute("/")).toEqual({ view: "home" });
    expect(pageRoute("/workbench")).toEqual({ view: "workbench" });
    expect(pageRoute("/history")).toEqual({ view: "history" });
    expect(pageRoute("/memory")).toEqual({ view: "memory" });
    expect(pageRoute("/settings/")).toEqual({ view: "settings" });
    expect(pageRoute("/settings/machines")).toEqual({ view: "settings", section: "machines" });
    expect(pageRoute("/settings/connections/")).toEqual({ view: "settings", section: "connections" });
    expect(pageRoute("/conversations")).toEqual({ view: "conversations", conversation: null });
    expect(pageRoute("/conversations/abc-123")).toEqual({ view: "conversations", conversation: "abc-123" });
    expect(pageRoute("/conversations", "?scope=code")).toEqual({ view: "conversations", conversation: null, scope: { kind: "code" } });
    const scoped = pageRoute("/conversations/abc-123", "?repository=owner%2Fproject");
    expect(scoped).toEqual({ view: "conversations", conversation: "abc-123", scope: { kind: "repository", repository: "owner/project" } });
    expect(pagePath(scoped!)).toBe("/conversations/abc-123?repository=owner%2Fproject");
    expect(pageRoute("/transfer")).toEqual({ view: "transfer" });
    expect(pagePath({ view: "transfer" })).toBe("/transfer");
    expect(pageRoute("/tickets/12")).toEqual({ view: "ticket", ticket: 12 });
  });

  it("refuses paths the page does not have", () => {
    for (const path of ["", "/api", "/assets/index.js", "/ws", "/health", "/conversations/a/b", "/memory/x", "/conversations/a.b", "/Workbench", "/tickets", "/tickets/0", "/tickets/012", "/tickets/x", "/tickets/1/2", "/tickets/12345678901234567", "/settings/rules", "/settings/machines/x", "/settings/Machines"]) {
      expect(pageRoute(path)).toBeUndefined();
    }
  });

  it("writes the path it reads", () => {
    for (const path of ["/", "/workbench", "/conversations", "/conversations/abc", "/tickets/7", "/history", "/memory", "/settings", "/settings/machines", "/settings/repositories", "/settings/models", "/settings/appearance", "/settings/connections"]) {
      const route = pageRoute(path);
      expect(route).toBeDefined();
      if (route !== undefined) {
        expect(pagePath(route)).toBe(path);
      }
    }
  });
});
