import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

export interface PushDevice {
  readonly privateKey: Buffer;
  readonly p256dh: string;
  readonly auth: string;
}

export function createPushDevice(): PushDevice {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

export function receivePush(device: PushDevice, message: Uint8Array): string {
  const body = Buffer.from(message);
  const salt = body.subarray(0, 16);
  const identifierLength = body[20] ?? 0;
  const sender = body.subarray(21, 21 + identifierLength);
  const sealed = body.subarray(21 + identifierLength);
  const receiver = Buffer.from(device.p256dh, "base64url");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(device.privateKey);
  const shared = ecdh.computeSecret(sender);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]);
  const input = Buffer.from(hkdfSync("sha256", shared, Buffer.from(device.auth, "base64url"), keyInfo, 32));
  const key = Buffer.from(hkdfSync("sha256", input, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", input, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) {
    end -= 1;
  }
  if (end === 0 || padded[end - 1] !== 2) {
    throw new Error("The push message has no padding delimiter");
  }
  return padded.subarray(0, end - 1).toString("utf8");
}
