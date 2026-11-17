import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import type { PushPayload } from "@super-agent2/protocol";
import { importJWK, SignJWT } from "jose";
import type { Clock } from "./clock.js";

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

const curve = "prime256v1";
const publicKeyBytes = 65;
const privateKeyBytes = 32;
const authBytes = 16;
const recordSize = 4096;
const maximumPlaintext = recordSize - 86 - 17;
const tokenLifetimeSeconds = 12 * 60 * 60;
const messageLifetimeSeconds = 24 * 60 * 60;
const sendTimeout = 15_000;

function decoded(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function leftPadded(value: Buffer, length: number): Buffer {
  return value.length >= length ? value : Buffer.concat([Buffer.alloc(length - value.length), value]);
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH(curve);
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: leftPadded(ecdh.getPrivateKey(), privateKeyBytes).toString("base64url"),
  };
}

export function isPublicKey(value: string): boolean {
  const bytes = decoded(value);
  return bytes.length === publicKeyBytes && bytes[0] === 4;
}

export function isAuthSecret(value: string): boolean {
  return decoded(value).length === authBytes;
}

export function vapidProblem(keys: VapidKeys): string | undefined {
  if (!isPublicKey(keys.publicKey)) {
    return "VAPID_PUBLIC_KEY must be an uncompressed P-256 public key in URL-safe base64";
  }
  const secret = decoded(keys.privateKey);
  if (secret.length !== privateKeyBytes) {
    return "VAPID_PRIVATE_KEY must be a 32-byte P-256 private key in URL-safe base64";
  }
  try {
    const ecdh = createECDH(curve);
    ecdh.setPrivateKey(secret);
    if (!ecdh.getPublicKey().equals(decoded(keys.publicKey))) {
      return "VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY";
    }
  } catch {
    return "VAPID_PRIVATE_KEY is not a valid P-256 private key";
  }
  return undefined;
}

export interface EphemeralChoice {
  readonly privateKey: Buffer;
  readonly salt: Buffer;
}

export function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, choice?: EphemeralChoice): Buffer {
  if (plaintext.length > maximumPlaintext) {
    throw new Error("The push message is too long");
  }
  const receiver = decoded(p256dh);
  const authSecret = decoded(auth);
  const ecdh = createECDH(curve);
  if (choice === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(choice.privateKey);
  }
  const sender = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiver);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]);
  const input = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = choice?.salt ?? randomBytes(16);
  const key = Buffer.from(hkdfSync("sha256", input, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", input, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header[20] = sender.length;
  return Buffer.concat([header, sender, sealed]);
}

export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly origin: string;
}

export type PushOutcome = "sent" | "gone" | "failed";

export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<PushOutcome>;
}

export interface PushSenderOptions {
  readonly keys: VapidKeys;
  readonly subject?: string | undefined;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly stopped?: AbortSignal;
}

export function createPushSender(options: PushSenderOptions): PushSender {
  const secret = decoded(options.keys.privateKey);
  const open = decoded(options.keys.publicKey);
  const signingKey = importJWK(
    {
      kty: "EC",
      crv: "P-256",
      x: open.subarray(1, 33).toString("base64url"),
      y: open.subarray(33).toString("base64url"),
      d: secret.toString("base64url"),
    },
    "ES256",
  );

  const token = async (audience: string, subject: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setAudience(audience)
      .setSubject(subject)
      .setExpirationTime(Math.floor(options.clock.now() / 1000) + tokenLifetimeSeconds)
      .sign(await signingKey);

  return {
    send: async (target, payload) => {
      let body: Buffer;
      let proof: string;
      try {
        body = encryptPayload(Buffer.from(JSON.stringify(payload)), target.p256dh, target.auth);
        proof = await token(new URL(target.endpoint).origin, options.subject ?? target.origin);
      } catch {
        return "failed";
      }
      const timeout = AbortSignal.timeout(sendTimeout);
      let response: Response;
      try {
        response = await options.fetch(target.endpoint, {
          method: "POST",
          headers: {
            authorization: `vapid t=${proof}, k=${options.keys.publicKey}`,
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(messageLifetimeSeconds),
            urgency: "high",
          },
          body: new Uint8Array(body),
          redirect: "manual",
          signal: options.stopped === undefined ? timeout : AbortSignal.any([timeout, options.stopped]),
        });
      } catch {
        return "failed";
      }
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) {
        return "sent";
      }
      return response.status === 404 || response.status === 410 ? "gone" : "failed";
    },
  };
}
