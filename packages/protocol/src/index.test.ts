import { describe, expect, it } from "vitest";
import { AccessKeySet, Hello, Identity, ProtocolVersion, protocolVersion } from "./index.js";

describe("ProtocolVersion", () => {
  it("accepts the current version", () => {
    expect(ProtocolVersion.parse(protocolVersion)).toBe(protocolVersion);
  });

  it("rejects any other version", () => {
    expect(ProtocolVersion.safeParse(protocolVersion + 1).success).toBe(false);
  });
});

describe("Identity", () => {
  it("tells a person from a service token", () => {
    const person = Identity.parse({ kind: "person", email: "owner@example.com", subject: "abc" });
    const service = Identity.parse({ kind: "service", clientId: "client.access" });
    expect(person.kind).toBe("person");
    expect(service.kind).toBe("service");
  });

  it("rejects a person without an email", () => {
    expect(Identity.safeParse({ kind: "person", subject: "abc" }).success).toBe(false);
  });
});

describe("AccessKeySet", () => {
  it("requires a key id on every key", () => {
    expect(AccessKeySet.safeParse({ keys: [{ kty: "RSA" }] }).success).toBe(false);
    expect(AccessKeySet.safeParse({ keys: [{ kty: "RSA", kid: "k", n: "x", e: "AQAB" }] }).success).toBe(true);
  });
});

describe("Hello", () => {
  it("carries the protocol version", () => {
    const hello = { type: "hello", protocol: protocolVersion, identity: { kind: "service", clientId: "c" } };
    expect(Hello.parse(hello)).toEqual(hello);
    expect(Hello.safeParse({ ...hello, protocol: protocolVersion + 1 }).success).toBe(false);
  });
});
