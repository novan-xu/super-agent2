import { PushPayload } from "@super-agent2/protocol";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createPushDevice, receivePush } from "./push-device.js";
import { createPushSender, encryptPayload, generateVapidKeys, vapidProblem } from "./push.js";
import { TestClock } from "./testing/access.js";

const payload: PushPayload = { title: "等你", body: "有一条命令等你确认", url: "/workbench?card=hold%3Aabc", tag: "hold:abc" };

describe("encrypting a push message", () => {
  it("produces the message of the standard's own example", () => {
    const body = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      { privateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"), salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url") },
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("can be read by the device it was made for, and by no other", () => {
    const device = createPushDevice();
    const body = encryptPayload(Buffer.from("看得见的字"), device.p256dh, device.auth);
    expect(receivePush(device, body)).toBe("看得见的字");
    expect(() => receivePush(createPushDevice(), body)).toThrow();
  });

  it("makes a different message each time", () => {
    const device = createPushDevice();
    const first = encryptPayload(Buffer.from("same"), device.p256dh, device.auth);
    const second = encryptPayload(Buffer.from("same"), device.p256dh, device.auth);
    expect(first.equals(second)).toBe(false);
  });

  it("refuses a message the push service would refuse for its size", () => {
    const device = createPushDevice();
    expect(() => encryptPayload(Buffer.alloc(4000), device.p256dh, device.auth)).toThrow();
  });
});

describe("VAPID keys", () => {
  it("accepts the keys it generates", () => {
    expect(vapidProblem(generateVapidKeys())).toBeUndefined();
  });

  it("refuses a private key that belongs to another public key", () => {
    expect(vapidProblem({ publicKey: generateVapidKeys().publicKey, privateKey: generateVapidKeys().privateKey })).toMatch(/does not belong/);
  });

  it("refuses keys of the wrong size without repeating them", () => {
    const keys = generateVapidKeys();
    expect(vapidProblem({ ...keys, publicKey: "AAAA" })).toMatch(/VAPID_PUBLIC_KEY/);
    expect(vapidProblem({ ...keys, privateKey: "AAAA" })).toMatch(/VAPID_PRIVATE_KEY/);
    expect(vapidProblem({ ...keys, privateKey: "AAAA" })).not.toContain("AAAA");
  });
});

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Buffer;
}

function recordingFetch(status: number | Error): typeof fetch & { readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const call = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (status instanceof Error) {
      return Promise.reject(status);
    }
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array) });
    return Promise.resolve(new Response(null, { status }));
  };
  return Object.assign(call, { sent });
}

describe("sending a push message", () => {
  const keys = generateVapidKeys();
  const clock = new TestClock();

  function target(origin = "https://hub.example.com") {
    const device = createPushDevice();
    return { device, target: { endpoint: "https://push.example.net/send/abc", p256dh: device.p256dh, auth: device.auth, origin } };
  }

  it("signs for the push service, encrypts for the device and says what it needs", async () => {
    const fetcher = recordingFetch(201);
    const { device, target: subscription } = target();
    const sender = createPushSender({ keys, fetch: fetcher, clock });
    expect(await sender.send(subscription, payload)).toBe("sent");
    const [sent] = fetcher.sent;
    expect(sent?.url).toBe(subscription.endpoint);
    expect(sent?.headers.get("content-encoding")).toBe("aes128gcm");
    expect(sent?.headers.get("ttl")).toBe("86400");
    expect(PushPayload.parse(JSON.parse(receivePush(device, sent?.body ?? Buffer.alloc(0))))).toEqual(payload);
    const authorization = sent?.headers.get("authorization") ?? "";
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(authorization) ?? [];
    expect(key).toBe(keys.publicKey);
    expect(decodeProtectedHeader(token ?? "").alg).toBe("ES256");
    const open = Buffer.from(keys.publicKey, "base64url");
    const verifying = await importJWK({ kty: "EC", crv: "P-256", x: open.subarray(1, 33).toString("base64url"), y: open.subarray(33).toString("base64url") }, "ES256");
    const verified = await jwtVerify(token ?? "", verifying, { audience: "https://push.example.net", currentDate: new Date(clock.now()) });
    expect(verified.payload.sub).toBe("https://hub.example.com");
    expect(verified.payload.exp).toBe(Math.floor(clock.now() / 1000) + 12 * 60 * 60);
  });

  it("names the configured contact instead of the page's address", async () => {
    const fetcher = recordingFetch(201);
    const sender = createPushSender({ keys, subject: "mailto:ops@example.com", fetch: fetcher, clock });
    await sender.send(target().target, payload);
    const token = /t=([^,]+),/.exec(fetcher.sent[0]?.headers.get("authorization") ?? "")?.[1] ?? "";
    const open = Buffer.from(keys.publicKey, "base64url");
    const verifying = await importJWK({ kty: "EC", crv: "P-256", x: open.subarray(1, 33).toString("base64url"), y: open.subarray(33).toString("base64url") }, "ES256");
    expect((await jwtVerify(token, verifying, { currentDate: new Date(clock.now()) })).payload.sub).toBe("mailto:ops@example.com");
  });

  it.each([
    [200, "sent"],
    [201, "sent"],
    [202, "sent"],
    [404, "gone"],
    [410, "gone"],
    [400, "failed"],
    [401, "failed"],
    [403, "failed"],
    [413, "failed"],
    [429, "failed"],
    [500, "failed"],
    [503, "failed"],
  ] as const)("reads status %i from the push service as %s", async (status, outcome) => {
    const sender = createPushSender({ keys, fetch: recordingFetch(status), clock });
    expect(await sender.send(target().target, payload)).toBe(outcome);
  });

  it("reports a push service that cannot be reached as a failure, not an error", async () => {
    const sender = createPushSender({ keys, fetch: recordingFetch(new Error("unreachable")), clock });
    expect(await sender.send(target().target, payload)).toBe("failed");
  });

  it("reports a subscription it cannot encrypt for as a failure", async () => {
    const fetcher = recordingFetch(201);
    const sender = createPushSender({ keys, fetch: fetcher, clock });
    expect(await sender.send({ endpoint: "https://push.example.net/x", p256dh: "AAAA", auth: "AAAA", origin: "https://hub.example.com" }, payload)).toBe("failed");
    expect(fetcher.sent).toEqual([]);
  });
});
