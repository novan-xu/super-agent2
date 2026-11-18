import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protocol from "@super-agent2/protocol";
import { pagePath, pageViews, settingsSections } from "@super-agent2/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hub } from "./hub.js";
import * as server from "./server.js";
import { assertion, issuer, keySet, personClaims, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

const runnerAudience = "b".repeat(64);
const version = "0123456789abcdef0123456789abcdef01234567";

let dataDir: string;
let hub: Hub;
let key: SigningKey;
const clock = new TestClock();

function pathConstants(module: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(module).flatMap(([name, value]) => (name.endsWith("Path") && typeof value === "string" && value.startsWith("/") ? [value] : []));
}

const sampled = [
  "/api/machines/pc/revoke",
  "/api/memories/1",
  "/api/memories/suggestions/1/confirm",
  "/api/memories/suggestions/1/decline",
  "/api/tickets/1",
  "/api/tickets/1/files/report.md",
  "/api/tickets/1/decisions/1",
  "/api/tickets/1/work",
  "/api/tickets/1/messages",
  "/api/tickets/1/stop",
  "/api/tickets/1/answer",
  "/api/tickets/1/reassign",
  "/api/commands/abc",
  "/api/commands/abc/output",
  "/api/commands/abc/stop",
  "/api/commands/abc/release",
  "/api/commands/abc/refuse",
  "/api/conversations/abc",
  "/api/conversations/abc/messages",
  "/api/conversations/abc/interrupt",
  "/api/attachments/abc",
  "/api/attachments/abc/upload",
  "/assets/index-abc.js",
  "/icons/icon-192.png",
  "/tickets/1",
  "/runner/enroll",
  "/runner",
  "/runner/",
  "/runnerx",
  "/brain/other",
  "/nothing/here",
];

function everyRoute(): string[] {
  const pages = [...pageViews.map((view) => (view === "settings" ? "/settings" : `/${view}`)), "/", ...settingsSections.map((section) => pagePath({ view: "settings", section }))];
  return [...new Set([...pathConstants(server), ...pathConstants(protocol), ...pages, ...sampled])].sort();
}

const methods = ["GET", "HEAD", "POST", "PUT", "DELETE"] as const;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-front-door-"));
  key = await signingKey("key-1");
  const pageDir = join(dataDir, "page");
  mkdirSync(join(pageDir, "assets"), { recursive: true });
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>");
  writeFileSync(join(pageDir, "sw.js"), "");
  writeFileSync(join(pageDir, "theme.js"), "");
  writeFileSync(join(pageDir, "assets", "index-abc.js"), "");
  hub = await startTestHub({
    config: { ...testConfig(dataDir), accessRunnerAudience: runnerAudience, pageDir, version, sourceRepository: "novan-xu/super-agent2" },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [fakeTarget("hub")],
    credentials: testCredentials,
    gate: () => ({ kind: "allow" as const }),
    report: () => undefined,
    serviceTokens: { create: () => Promise.reject(new Error("not in this test")), remove: () => Promise.resolve() },
  });
});

afterAll(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function base(): string {
  return `http://127.0.0.1:${hub.address.port}`;
}

async function status(path: string, method: string, headers: Record<string, string>): Promise<number> {
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: { origin: base(), "sec-fetch-site": "same-origin", ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json" }), ...headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  });
  await response.arrayBuffer();
  return response.status;
}

function upgrade(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(`${base()}${path}`, { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    sent.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    sent.on("error", reject);
    sent.end();
  });
}

describe("the front door", () => {
  it("knows the routes it walks", () => {
    const routes = everyRoute();
    for (const path of ["/health", "/api/session", "/ws", "/api/machines", "/api/settings", "/runner/link", "/runner/release", "/runner/install", "/brain/mcp", "/brain/link", "/sw.js", "/settings/machines"]) {
      expect(routes).toContain(path);
    }
    expect(routes.length).toBeGreaterThan(60);
  });

  it("answers nothing without a signed Access assertion but its own health, every route, every method and an unknown one", async () => {
    const answered: string[] = [];
    for (const path of everyRoute()) {
      for (const method of methods) {
        const code = await status(path, method, {});
        if (code !== 403) {
          answered.push(`${method} ${path} ${code}`);
        }
      }
    }
    expect(answered).toEqual(["GET /health 200", "HEAD /health 200"]);
    const health = await fetch(`${base()}/health`);
    expect(Object.keys((await health.json()) as object).sort()).toEqual(["status", "version"]);
  });

  it("opens no socket without a signed Access assertion", async () => {
    for (const path of ["/ws", "/runner/link", "/brain/link", "/runner/enroll", "/nothing"]) {
      expect(await upgrade(path, {})).toBe(403);
    }
  });

  it("takes the runner application's assertion only on the runner paths, and the owner's only elsewhere", async () => {
    const runnerAsPerson = await assertion({ key, clock, claims: { ...personClaims(), aud: [runnerAudience] } });
    const ownerAsService = await assertion({ key, clock, claims: serviceClaims() });
    const runnerAsService = await assertion({ key, clock, claims: { iss: issuer, aud: [runnerAudience], common_name: "0123456789abcdef.access", sub: "", type: "app" } });
    for (const path of ["/api/session", "/api/settings", "/", "/settings/machines"]) {
      expect(await status(path, "GET", { "cf-access-jwt-assertion": runnerAsPerson })).toBe(403);
      expect(await status(path, "GET", { "cf-access-jwt-assertion": runnerAsService })).toBe(403);
    }
    expect(await status("/api/machines", "POST", { "cf-access-jwt-assertion": runnerAsPerson })).toBe(403);
    expect(await status("/api/session", "GET", { "cf-access-jwt-assertion": await assertion({ key, clock }) })).toBe(200);
    for (const path of ["/runner/install", "/runner/release"]) {
      expect(await status(path, "GET", { "cf-access-jwt-assertion": ownerAsService })).toBe(403);
      expect(await status(path, "GET", { "cf-access-jwt-assertion": runnerAsPerson })).toBe(403);
    }
    expect(await upgrade("/runner/link", { "cf-access-jwt-assertion": ownerAsService })).toBe(403);
    expect(await upgrade("/ws", { "cf-access-jwt-assertion": runnerAsPerson })).toBe(403);
  });
});
