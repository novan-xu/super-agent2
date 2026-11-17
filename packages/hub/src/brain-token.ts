import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const brainTokenFileName = "brain.token";

const tokenPattern = /^[A-Za-z0-9_-]{43,}$/;

export type BrainTokenCheck = (authorization: string | undefined) => boolean;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function readToken(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function ensureBrainToken(path: string): string {
  const existing = readToken(path);
  if (existing !== undefined) {
    if (!tokenPattern.test(existing)) {
      throw new Error(`The brain token file ${path} does not hold a token of at least 43 URL-safe characters`);
    }
    return existing;
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  try {
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return ensureBrainToken(path);
    }
    throw error;
  }
  return token;
}

export function brainTokenCheck(token: string): BrainTokenCheck {
  const expected = digest(token);
  return (authorization) => {
    if (authorization === undefined) {
      return false;
    }
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (match?.[1] === undefined) {
      return false;
    }
    return timingSafeEqual(digest(match[1]), expected);
  };
}
