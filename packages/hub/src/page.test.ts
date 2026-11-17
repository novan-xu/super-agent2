import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hub } from "./hub.js";
import { assertion, keySet, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { startTestHub } from "./testing/http.js";

const indexHtml = '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script></head><body></body></html>';
const script = "console.log(1);";

let dataDir: string;
let pageDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-page-"));
  pageDir = mkdtempSync(join(tmpdir(), "hub-page-files-"));
  mkdirSync(join(pageDir, "assets"));
  writeFileSync(join(pageDir, "index.html"), indexHtml);
  writeFileSync(join(pageDir, "assets", "index-abc123.js"), script);
  writeFileSync(join(pageDir, "assets", "index-abc123.css"), "body{}");
  writeFileSync(join(pageDir, "secret.txt"), "not served");
  clock = new TestClock();
  key = await signingKey("key-1");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pageDir, { recursive: true, force: true });
});

async function start(withPage = true): Promise<Hub> {
  const config = testConfig(dataDir);
  hub = await startTestHub({
    config: withPage ? { ...config, pageDir } : config,
    keySource: staticKeySource(keySet(key)),
    clock,
  });
  return hub;
}

async function call(running: Hub, path: string, init: RequestInit = {}, signedIn = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (signedIn) {
    headers.set("Cf-Access-Jwt-Assertion", await assertion({ key, clock }));
  }
  return fetch(`http://127.0.0.1:${running.address.port}${path}`, { ...init, headers });
}

describe("the page", () => {
  it("answers every route of the page with the page itself", async () => {
    const running = await start();
    for (const path of ["/", "/workbench", "/conversations", "/conversations/abc-123", "/history", "/memory", "/settings"]) {
      const response = await call(running, path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(await response.text()).toBe(indexHtml);
    }
  });

  it("serves the built assets with their type, for good", async () => {
    const running = await start();
    const response = await call(running, "/assets/index-abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe(script);
    const style = await call(running, "/assets/index-abc123.css");
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("answers HEAD without a body", async () => {
    const running = await start();
    const response = await call(running, "/conversations", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(indexHtml)));
    expect(await response.text()).toBe("");
  });

  it("is behind the front door, while health stays public", async () => {
    const running = await start();
    for (const path of ["/", "/conversations/abc", "/assets/index-abc123.js"]) {
      const response = await call(running, path, {}, false);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    const health = await call(running, "/health", {}, false);
    expect(health.status).toBe(200);
  });

  it("serves nothing outside the assets folder and nothing it does not know", async () => {
    const running = await start();
    for (const path of [
      "/secret.txt",
      "/index.html",
      "/assets/missing.js",
      "/assets/%2e%2e%2fsecret.txt",
      "/assets/..%5csecret.txt",
      "/assets/.hidden.js",
      "/assets/index-abc123",
      "/conversations/a/b",
      "/api/unknown",
    ]) {
      const response = await call(running, path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("refuses to change anything through a page route", async () => {
    const running = await start();
    const response = await call(running, "/conversations", { method: "PUT" });
    expect(response.status).toBe(404);
  });

  it("answers not found when there is no built page", async () => {
    const running = await start(false);
    const response = await call(running, "/");
    expect(response.status).toBe(404);
  });
});
