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
  writeFileSync(join(pageDir, "sw.js"), "self.addEventListener(\"push\", () => undefined);");
  mkdirSync(join(pageDir, "icons"));
  writeFileSync(join(pageDir, "icons", "icon-192.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(pageDir, "icons", "notes.txt"), "not an icon");
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

  it("serves the service worker from the root, fresh every time, under the page's own policy", async () => {
    const running = await start();
    const response = await call(running, "/sw.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await response.text()).toContain("push");
  });

  it("serves the icons and builds the manifest in Chinese from the catalog", async () => {
    const running = await start();
    const icon = await call(running, "/icons/icon-192.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71]));
    expect((await call(running, "/icons/notes.txt")).status).toBe(404);
    expect((await call(running, "/icons/missing.png")).status).toBe(404);
    expect((await call(running, "/icons/..%5csecret.txt")).status).toBe(404);
    const manifest = await call(running, "/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
    const body = (await manifest.json()) as { name: string; display: string; lang: string; icons: { src: string; purpose: string }[] };
    expect(body).toMatchObject({ name: "Super-agent2", display: "standalone", lang: "zh-CN" });
    expect(body.icons.map((entry) => entry.purpose)).toEqual(["any", "any", "maskable"]);
    expect(body.icons.every((entry) => entry.src.startsWith("/icons/"))).toBe(true);
  });

  it("keeps the worker, the icons and the manifest behind the front door", async () => {
    const running = await start();
    for (const path of ["/sw.js", "/icons/icon-192.png", "/manifest.webmanifest"]) {
      expect((await call(running, path, {}, false)).status, path).toBe(403);
    }
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
