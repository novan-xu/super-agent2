import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hello, Session } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Hub, startHub } from "./hub.js";
import {
  assertion,
  keySet,
  ownerEmail,
  personClaims,
  serviceClaims,
  signingKey,
  type SigningKey,
  staticKeySource,
  TestClock,
  testConfig,
} from "./testing/access.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;

const ownerIdentity = { kind: "person", email: ownerEmail, subject: "7335d417-61da-459d-899c-0a01c76a2f94" };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-"));
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(): Promise<Hub> {
  hub = await startHub({ config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock });
  return hub;
}

function owner(): Promise<string> {
  return assertion({ key, clock });
}

function assertionHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token };
}

function request(running: Hub, path: string, token?: string, method = "GET"): Promise<Response> {
  return fetch(`http://127.0.0.1:${running.address.port}${path}`, { method, headers: assertionHeaders(token) });
}

type Opened = { readonly kind: "message"; readonly data: string } | { readonly kind: "refused"; readonly status: number };

function connect(running: Hub, path: string, token?: string): Promise<Opened> {
  const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}${path}`, { headers: assertionHeaders(token) });
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      resolve({ kind: "message", data: String(data) });
      socket.close();
    });
    socket.once("unexpected-response", (_upgrade, response) => {
      resolve({ kind: "refused", status: response.statusCode ?? 0 });
      response.resume();
    });
    socket.once("error", reject);
  });
}

describe("health", () => {
  it("answers without a sign-in and reveals nothing", async () => {
    const running = await start();
    const response = await request(running, "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("server")).toBeNull();
    expect((await request(running, "/health", undefined, "HEAD")).status).toBe(200);
  });
});

describe("the front door", () => {
  it("serves the owner", async () => {
    const running = await start();
    const response = await request(running, "/api/session", await owner());
    expect(response.status).toBe(200);
    expect(Session.parse(await response.json()).identity).toEqual(ownerIdentity);
  });

  it("refuses a request without an assertion, on any path", async () => {
    const running = await start();
    for (const path of ["/", "/api/session", "/index.html", "/api/unknown", "/health/x"]) {
      const response = await request(running, path);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
  });

  it("refuses another email, another audience, another key and a service token", async () => {
    const running = await start();
    const impostor = await signingKey("key-1");
    const tokens = [
      await assertion({ key, clock, claims: personClaims("someone@example.com") }),
      await assertion({ key, clock, claims: { ...personClaims(), aud: ["b".repeat(64)] } }),
      await assertion({ key: impostor, clock }),
      await assertion({ key, clock, claims: serviceClaims() }),
    ];
    for (const token of tokens) {
      expect((await request(running, "/api/session", token)).status).toBe(403);
    }
  });

  it("refuses the owner's assertion once it has expired", async () => {
    const running = await start();
    const token = await assertion({ key, clock, lifetimeSeconds: 60 });
    expect((await request(running, "/api/session", token)).status).toBe(200);
    clock.advance(3_600_000);
    expect((await request(running, "/api/session", token)).status).toBe(403);
  });

  it("answers not found for an unknown path only after the sign-in", async () => {
    const running = await start();
    expect((await request(running, "/nothing-here", await owner())).status).toBe(404);
  });

  it("refuses everything but health when the key set cannot be fetched", async () => {
    hub = await startHub({
      config: testConfig(dataDir),
      keySource: async () => {
        throw new Error("offline");
      },
      clock,
    });
    expect((await request(hub, "/api/session", await owner())).status).toBe(403);
    expect((await request(hub, "/health")).status).toBe(200);
  });
});

describe("the WebSocket", () => {
  it("opens for the owner and greets with the identity", async () => {
    const running = await start();
    const opened = await connect(running, "/ws", await owner());
    if (opened.kind !== "message") {
      throw new Error(`refused with ${opened.status}`);
    }
    expect(Hello.parse(JSON.parse(opened.data)).identity).toEqual(ownerIdentity);
  });

  it("refuses an upgrade without a valid assertion", async () => {
    const running = await start();
    expect(await connect(running, "/ws")).toEqual({ kind: "refused", status: 403 });
    const stranger = await assertion({ key, clock, claims: personClaims("someone@example.com") });
    expect(await connect(running, "/ws", stranger)).toEqual({ kind: "refused", status: 403 });
  });

  it("refuses an upgrade on another path", async () => {
    const running = await start();
    expect(await connect(running, "/elsewhere", await owner())).toEqual({ kind: "refused", status: 404 });
  });
});

describe("restart", () => {
  it("keeps the hub's state", async () => {
    const first = await start();
    const instance = first.database.instance;
    await first.close();
    hub = undefined;
    const second = await start();
    expect(second.database.instance).toBe(instance);
  });
});
