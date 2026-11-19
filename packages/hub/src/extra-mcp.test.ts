import { describe, expect, it } from "vitest";
import { extraMcpFromEnvironment } from "./extra-mcp.js";

const definition = { name: "Agent_wring", url: "http://mini:3000/mcp", secret: "WRING_TOKEN", brain: true, workers: true };

describe("extra MCP configuration", () => {
  it("resolves secrets and selects audiences", () => {
    const env = { HUB_EXTRA_MCP_SERVERS: JSON.stringify([definition, { ...definition, name: "worker", brain: false }]), WRING_TOKEN: "example-secret" };
    expect(extraMcpFromEnvironment(env)).toEqual({ brain: [{ name: "Agent_wring", url: definition.url, token: "example-secret" }], workers: [{ name: "Agent_wring", url: definition.url, token: "example-secret" }, { name: "worker", url: definition.url, token: "example-secret" }] });
  });
  it("rejects missing secrets, duplicates, reserved names and credential URLs", () => {
    expect(() => extraMcpFromEnvironment({ HUB_EXTRA_MCP_SERVERS: JSON.stringify([definition]) })).toThrow("Missing MCP secret");
    for (const entries of [[definition, definition], [{ ...definition, name: "hub" }], [{ ...definition, url: "http://user:pass@host/" }]]) {
      expect(() => extraMcpFromEnvironment({ HUB_EXTRA_MCP_SERVERS: JSON.stringify(entries), WRING_TOKEN: "example-secret" })).toThrow();
    }
  });
});
