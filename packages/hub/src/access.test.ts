import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { createAccessVerifier, ownerOnly } from "./access.js";
import { createKeyCache, type KeySource } from "./keys.js";
import {
  assertion,
  audience,
  issuer,
  keySet,
  ownerEmail,
  personClaims,
  serviceClaims,
  signingKey,
  staticKeySource,
  team,
  TestClock,
  unsignedAssertion,
} from "./testing/access.js";

async function setup(source?: KeySource) {
  const clock = new TestClock();
  const key = await signingKey("key-1");
  const keys = createKeyCache({ source: source ?? staticKeySource(keySet(key)), clock });
  const verify = createAccessVerifier({ team, audience, keys, clock });
  const admit = ownerOnly(ownerEmail);
  const admitted = async (token: string | undefined) => {
    const result = await verify(token);
    return result.ok && admit(result.identity);
  };
  return { clock, key, verify, admitted };
}

describe("createAccessVerifier", () => {
  it("admits the owner's sign-in", async () => {
    const { clock, key, verify, admitted } = await setup();
    const token = await assertion({ key, clock });
    expect(await verify(token)).toEqual({
      ok: true,
      identity: { kind: "person", email: ownerEmail, subject: "7335d417-61da-459d-899c-0a01c76a2f94" },
    });
    expect(await admitted(token)).toBe(true);
  });

  it("admits the owner's sign-in whatever the case of the email", async () => {
    const { clock, key, admitted } = await setup();
    expect(await admitted(await assertion({ key, clock, claims: personClaims("OWNER@example.COM") }))).toBe(true);
  });

  it("accepts an audience given as a single string", async () => {
    const { clock, key, admitted } = await setup();
    expect(await admitted(await assertion({ key, clock, claims: { ...personClaims(), aud: audience } }))).toBe(true);
  });

  it("refuses a missing or empty assertion", async () => {
    const { verify } = await setup();
    expect((await verify(undefined)).ok).toBe(false);
    expect((await verify("")).ok).toBe(false);
  });

  it("refuses an assertion that is not a token", async () => {
    const { verify } = await setup();
    expect((await verify("not-a-token")).ok).toBe(false);
    expect((await verify("a.b.c")).ok).toBe(false);
  });

  it("refuses another person's sign-in", async () => {
    const { clock, key, verify, admitted } = await setup();
    const token = await assertion({ key, clock, claims: personClaims("someone@example.com") });
    expect((await verify(token)).ok).toBe(true);
    expect(await admitted(token)).toBe(false);
  });

  it("refuses an assertion for another audience", async () => {
    const { clock, key, verify } = await setup();
    const token = await assertion({ key, clock, claims: { ...personClaims(), aud: ["b".repeat(64)] } });
    expect((await verify(token)).ok).toBe(false);
  });

  it("refuses an assertion from another team", async () => {
    const { clock, key, verify } = await setup();
    const token = await assertion({ key, clock, claims: { ...personClaims(), iss: "https://other.cloudflareaccess.com" } });
    expect((await verify(token)).ok).toBe(false);
  });

  it("refuses an assertion signed by another key under the same key id", async () => {
    const { clock, verify } = await setup();
    const impostor = await signingKey("key-1");
    expect((await verify(await assertion({ key: impostor, clock }))).ok).toBe(false);
  });

  it("refuses an assertion signed by a key that is not published", async () => {
    const { clock, verify } = await setup();
    const unknown = await signingKey("key-2");
    expect((await verify(await assertion({ key: unknown, clock }))).ok).toBe(false);
  });

  it("refuses an expired assertion and one that is not yet valid", async () => {
    const { clock, key, verify } = await setup();
    const token = await assertion({ key, clock, lifetimeSeconds: 60 });
    expect((await verify(token)).ok).toBe(true);
    clock.advance(60_000 + 30_000);
    expect((await verify(token)).ok).toBe(false);

    const early = new TestClock(clock.now() + 3_600_000);
    const future = await assertion({ key, clock: early });
    expect((await verify(future)).ok).toBe(false);
  });

  it("refuses an assertion with no expiry", async () => {
    const { clock, key, verify } = await setup();
    const seconds = Math.floor(clock.now() / 1000);
    const token = await new SignJWT({ ...personClaims(), iat: seconds })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .sign(key.privateKey);
    expect((await verify(token)).ok).toBe(false);
  });

  it("refuses an algorithm other than RS256, even with a published key of that kind", async () => {
    const clock = new TestClock();
    const rsa = await signingKey("rsa");
    const ec = await signingKey("ec", "ES256");
    const keys = createKeyCache({ source: staticKeySource(keySet(rsa, ec)), clock });
    const verify = createAccessVerifier({ team, audience, keys, clock });
    expect((await verify(await assertion({ key: rsa, clock }))).ok).toBe(true);
    expect((await verify(await assertion({ key: ec, clock, algorithm: "ES256" }))).ok).toBe(false);
  });

  it("refuses an unsigned assertion", async () => {
    const { clock, key, verify } = await setup();
    const seconds = Math.floor(clock.now() / 1000);
    const token = unsignedAssertion({ ...personClaims(), iat: seconds, exp: seconds + 3600 }, key.kid);
    expect((await verify(token)).ok).toBe(false);
  });

  it("refuses an assertion signed with the public key as a shared secret", async () => {
    const { clock, key, verify } = await setup();
    const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
    const seconds = Math.floor(clock.now() / 1000);
    const token = await new SignJWT({ ...personClaims(), iat: seconds, exp: seconds + 3600 })
      .setProtectedHeader({ alg: "HS256", kid: key.kid })
      .sign(secret);
    expect((await verify(token)).ok).toBe(false);
  });

  it("refuses everything when the key set cannot be fetched", async () => {
    const offline: KeySource = async () => {
      throw new Error("offline");
    };
    const { clock, key, verify } = await setup(offline);
    expect(await verify(await assertion({ key, clock }))).toEqual({ ok: false, reason: "invalid assertion" });
  });

  it("tells a service token apart from a person and does not admit it", async () => {
    const { clock, key, verify, admitted } = await setup();
    const token = await assertion({ key, clock, claims: serviceClaims() });
    expect(await verify(token)).toEqual({ ok: true, identity: { kind: "service", clientId: "0123456789abcdef.access" } });
    expect(await admitted(token)).toBe(false);
  });

  it("refuses a token that is neither a person nor a service", async () => {
    const { clock, key, verify } = await setup();
    const token = await assertion({ key, clock, claims: { iss: issuer, aud: [audience], sub: "x" } });
    expect((await verify(token)).ok).toBe(false);
  });
});

describe("ownerOnly", () => {
  it("admits only the owner's own sign-in", () => {
    const admit = ownerOnly("Owner@Example.com");
    expect(admit({ kind: "person", email: "owner@example.com", subject: "s" })).toBe(true);
    expect(admit({ kind: "person", email: "other@example.com", subject: "s" })).toBe(false);
    expect(admit({ kind: "service", clientId: "owner@example.com" })).toBe(false);
  });
});
