import type { AccessKeySet } from "@super-agent2/protocol";
import { exportJWK, generateKeyPair, type CryptoKey, SignJWT, type JWTPayload } from "jose";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { KeySource } from "../keys.js";

export const team = "example-team";
export const audience = "a".repeat(64);
export const ownerEmail = "owner@example.com";
export const issuer = `https://${team}.cloudflareaccess.com`;
export const startOfTest = Date.UTC(2026, 10, 17, 12, 0, 0);

export class TestClock implements Clock {
  constructor(private current: number = startOfTest) {}

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, unknown>;
}

export async function signingKey(kid: string, algorithm: "RS256" | "ES256" = "RS256"): Promise<SigningKey> {
  const pair = await generateKeyPair(algorithm, { extractable: true });
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: algorithm, use: "sig" };
  return { kid, privateKey: pair.privateKey, publicJwk };
}

export function keySet(...keys: SigningKey[]): AccessKeySet {
  return { keys: keys.map((key) => ({ ...key.publicJwk, kty: String(key.publicJwk["kty"]), kid: key.kid })) };
}

export function staticKeySource(set: AccessKeySet): KeySource & { calls: number } {
  const source = Object.assign(
    async () => {
      source.calls += 1;
      return set;
    },
    { calls: 0 },
  );
  return source;
}

export interface AssertionOptions {
  readonly key: SigningKey;
  readonly clock: Clock;
  readonly claims?: JWTPayload & Record<string, unknown>;
  readonly algorithm?: string;
  readonly kid?: string;
  readonly lifetimeSeconds?: number;
}

export function personClaims(email: string = ownerEmail): JWTPayload & Record<string, unknown> {
  return {
    iss: issuer,
    aud: [audience],
    email,
    sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    type: "app",
    identity_nonce: "nonce",
    country: "SG",
  };
}

export function serviceClaims(): JWTPayload & Record<string, unknown> {
  return { iss: issuer, aud: [audience], common_name: "0123456789abcdef.access", sub: "", type: "app" };
}

export async function assertion(options: AssertionOptions): Promise<string> {
  const seconds = Math.floor(options.clock.now() / 1000);
  const lifetime = options.lifetimeSeconds ?? 3600;
  return new SignJWT({ iat: seconds, nbf: seconds, exp: seconds + lifetime, ...(options.claims ?? personClaims()) })
    .setProtectedHeader({ alg: options.algorithm ?? "RS256", kid: options.kid ?? options.key.kid, typ: "JWT" })
    .sign(options.key.privateKey);
}

export function unsignedAssertion(claims: Record<string, unknown>, kid: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", kid, typ: "JWT" })}.${encode(claims)}.`;
}

export function testConfig(dataDir: string): Config {
  return { accessTeam: team, accessAudience: audience, ownerEmail, dataDir, port: 0, host: "127.0.0.1" };
}
