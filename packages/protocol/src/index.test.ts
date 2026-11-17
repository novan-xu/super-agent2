import { describe, expect, it } from "vitest";
import {
  AccessKeySet,
  ClientMessage,
  CommandRequest,
  Hello,
  Identity,
  ProtocolVersion,
  ServerMessage,
  protocolVersion,
} from "./index.js";

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

describe("CommandRequest", () => {
  it("takes any command and defaults to the novan-xu account", () => {
    expect(CommandRequest.parse({ target: "hub", command: "some-program --flag" })).toEqual({
      target: "hub",
      command: "some-program --flag",
      account: "novan-xu",
    });
  });

  it("accepts only the two accounts and a plain target name", () => {
    expect(CommandRequest.safeParse({ target: "hub", command: "x", account: "nuofan-island" }).success).toBe(true);
    expect(CommandRequest.safeParse({ target: "hub", command: "x", account: "someone" }).success).toBe(false);
    expect(CommandRequest.safeParse({ target: "../hub", command: "x" }).success).toBe(false);
  });
});

describe("socket messages", () => {
  it("follows from the start unless told otherwise", () => {
    expect(ClientMessage.parse({ type: "follow", command: "c1" })).toEqual({ type: "follow", command: "c1", after: 0 });
    expect(ClientMessage.safeParse({ type: "run", command: "c1" }).success).toBe(false);
  });

  it("carries output chunks from the hub", () => {
    const chunk = { command: "c1", seq: 1, stream: "stdout", data: "hi", at: 1 };
    expect(ServerMessage.parse({ type: "output", chunk })).toEqual({ type: "output", chunk });
  });
});
