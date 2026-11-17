import { AccessClaims, type Identity } from "@super-agent2/protocol";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import type { Clock } from "./clock.js";
import type { KeyCache } from "./keys.js";

export const accessAlgorithm = "RS256";

export const assertionHeader = "cf-access-jwt-assertion";

export interface AccessVerifierOptions {
  readonly team: string;
  readonly audience: string;
  readonly keys: KeyCache;
  readonly clock: Clock;
  readonly clockToleranceSeconds?: number;
}

export type Verification = { readonly ok: true; readonly identity: Identity } | { readonly ok: false; readonly reason: string };

export type AccessVerifier = (assertion: string | undefined) => Promise<Verification>;

export function accessIssuer(team: string): string {
  return `https://${team}.cloudflareaccess.com`;
}

function refuse(reason: string): Verification {
  return { ok: false, reason };
}

function identityOf(claims: AccessClaims): Identity | undefined {
  const email = claims.email ?? "";
  const subject = claims.sub ?? "";
  const commonName = claims.common_name ?? "";
  if (email !== "" && subject !== "" && commonName === "") {
    return { kind: "person", email: email.toLowerCase(), subject };
  }
  if (commonName !== "" && email === "") {
    return { kind: "service", clientId: commonName };
  }
  return undefined;
}

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  const issuer = accessIssuer(options.team);
  const tolerance = options.clockToleranceSeconds ?? 30;
  return async (assertion) => {
    if (assertion === undefined || assertion === "") {
      return refuse("no assertion");
    }
    try {
      const header = decodeProtectedHeader(assertion);
      if (header.alg !== accessAlgorithm) {
        return refuse("unexpected algorithm");
      }
      if (typeof header.kid !== "string" || header.kid === "") {
        return refuse("no key id");
      }
      const set = await options.keys.keysFor(header.kid);
      const keys = createLocalJWKSet({ keys: set.keys as JWK[] });
      const now = options.clock.now();
      const { payload, protectedHeader } = await jwtVerify(assertion, keys, {
        algorithms: [accessAlgorithm],
        issuer,
        audience: options.audience,
        currentDate: new Date(now),
        clockTolerance: tolerance,
        requiredClaims: ["iss", "aud", "exp", "iat"],
      });
      if (protectedHeader.alg !== accessAlgorithm) {
        return refuse("unexpected algorithm");
      }
      const claims = AccessClaims.safeParse(payload);
      if (!claims.success) {
        return refuse("malformed claims");
      }
      const audiences = Array.isArray(claims.data.aud) ? claims.data.aud : [claims.data.aud];
      if (claims.data.iss !== issuer || !audiences.includes(options.audience)) {
        return refuse("wrong issuer or audience");
      }
      if (claims.data.exp + tolerance <= now / 1000) {
        return refuse("expired");
      }
      const identity = identityOf(claims.data);
      if (identity === undefined) {
        return refuse("unknown identity");
      }
      return { ok: true, identity };
    } catch {
      return refuse("invalid assertion");
    }
  };
}

export type Admission = (identity: Identity) => boolean;

export function ownerOnly(ownerEmail: string): Admission {
  const owner = ownerEmail.toLowerCase();
  return (identity) => identity.kind === "person" && identity.email === owner;
}
