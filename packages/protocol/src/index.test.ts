import { describe, expect, it } from "vitest";
import { ProtocolVersion, protocolVersion } from "./index.js";

describe("ProtocolVersion", () => {
  it("accepts the current version", () => {
    expect(ProtocolVersion.parse(protocolVersion)).toBe(protocolVersion);
  });

  it("rejects any other version", () => {
    expect(ProtocolVersion.safeParse(protocolVersion + 1).success).toBe(false);
  });
});
