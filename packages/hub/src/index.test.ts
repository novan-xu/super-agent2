import { protocolVersion } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { part, speaks } from "./index.js";

describe("hub", () => {
  it("names itself", () => {
    expect(part).toBe("hub");
  });

  it("speaks the protocol version of the workspace", () => {
    expect(speaks(protocolVersion)).toBe(true);
    expect(speaks(protocolVersion + 1)).toBe(false);
  });
});
