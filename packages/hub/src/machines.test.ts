import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudflareServiceTokens, cloudflareSettings, expiryOf, type ServiceToken } from "./cloudflare.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { runMachineCommand } from "./machine-commands.js";
import { createMachineStore, MachineError, runnerTokenHash } from "./machines.js";
import { decodeRunnerSetup } from "@super-agent2/protocol";
import { TestClock } from "./testing/access.js";

let dataDir: string;
let clock: TestClock;
let database: HubDatabase;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-machines-"));
  clock = new TestClock();
  database = openDatabase({ dataDir, clock });
});

afterEach(() => {
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the machine store", () => {
  it("issues a token and keeps only its hash", () => {
    const machines = createMachineStore(database, clock);
    const { machine, token } = machines.add({ name: "pc", accessClientId: "client.access" });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(machine.tokenHash).toBe(runnerTokenHash(token));
    const stored = JSON.stringify(database.connection.prepare("SELECT * FROM machines").all());
    expect(stored).not.toContain(token);
    expect(machines.byToken(token)?.name).toBe("pc");
    expect(machines.byToken(`${token}x`)).toBeUndefined();
    expect(machines.byToken("short")).toBeUndefined();
  });

  it("refuses reserved, malformed and duplicate names", () => {
    const machines = createMachineStore(database, clock);
    expect(() => machines.add({ name: "hub", accessClientId: "a" })).toThrow(MachineError);
    expect(() => machines.add({ name: "nas", accessClientId: "a" })).toThrow(MachineError);
    expect(() => machines.add({ name: "Mac Mini", accessClientId: "a" })).toThrow(MachineError);
    machines.add({ name: "mac-mini", accessClientId: "a" });
    expect(() => machines.add({ name: "mac-mini", accessClientId: "b" })).toThrow(/already exists/);
  });

  it("refuses a revoked token and gives a new one when the name is added again", () => {
    const machines = createMachineStore(database, clock);
    const first = machines.add({ name: "pc", accessClientId: "a" });
    clock.advance(1000);
    expect(machines.revoke("pc")?.revokedAt).toBe(clock.now());
    expect(machines.byToken(first.token)).toBeUndefined();
    expect(machines.active("pc")).toBeUndefined();
    const second = machines.add({ name: "pc", accessClientId: "b" });
    expect(second.token).not.toBe(first.token);
    expect(machines.byToken(first.token)).toBeUndefined();
    expect(machines.byToken(second.token)?.accessClientId).toBe("b");
  });

  it("notices a change made by another connection", () => {
    const machines = createMachineStore(database, clock);
    machines.add({ name: "pc", accessClientId: "a" });
    expect(machines.changed()).toBe(false);
    const other = openDatabase({ dataDir, clock });
    try {
      createMachineStore(other, clock).revoke("pc");
    } finally {
      other.close();
    }
    expect(machines.changed()).toBe(true);
    expect(machines.changed()).toBe(false);
    expect(machines.active("pc")).toBeUndefined();
  });
});

describe("creating an Access service token", () => {
  it("asks for a token that does not expire, tagged for the runner application's policy, with the API token", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, result: { id: "token-id", client_id: "id.access", client_secret: "secret", duration: "forever" } }), { status: 200 });
    };
    const tokens = cloudflareServiceTokens({ accountId: "account", apiToken: "api-token", fetch: fake });
    expect(await tokens.create("superagent2-runner-pc")).toEqual({ id: "token-id", clientId: "id.access", clientSecret: "secret", expiresAt: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/account/access/service_tokens");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer api-token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "superagent2-runner-pc", duration: "forever", tags: { superagent2: "runner" } });
  });

  it("keeps the expiry Cloudflare gives when the token does expire", () => {
    expect(expiryOf("8760h", "2027-11-18T12:00:00Z")).toBe(Date.UTC(2027, 10, 18, 12));
    expect(expiryOf("forever", "2027-11-18T12:00:00Z")).toBeNull();
    expect(expiryOf(undefined, "0001-01-01T00:00:00Z")).toBeNull();
    expect(expiryOf(undefined, "not a date")).toBeNull();
    expect(expiryOf("8760h", null)).toBeNull();
  });

  it("reports Cloudflare's refusal without the token", async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
    const tokens = cloudflareServiceTokens({ accountId: "account", apiToken: "api-token", fetch: fake });
    const failure = tokens.create("x");
    await expect(failure).rejects.toThrow("HTTP 403");
    await expect(failure).rejects.toThrow("Authentication error");
    await expect(failure).rejects.not.toThrow("api-token");
  });

  it("names the missing settings", () => {
    expect(cloudflareSettings({})).toEqual({ missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCESS_API_TOKEN"] });
    expect(cloudflareSettings({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_ACCESS_API_TOKEN: "t" })).toEqual({ accountId: "a", apiToken: "t" });
  });
});

describe("the machines command line", () => {
  async function run(argv: string[], environment: Record<string, string> = {}, created: ServiceToken = { id: "token-id", clientId: "made.access", clientSecret: "made-secret", expiresAt: null }) {
    const out: string[] = [];
    const err: string[] = [];
    const names: string[] = [];
    const code = await runMachineCommand({
      argv,
      environment: { HUB_DATA_DIR: dataDir, ...environment },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      clock,
      serviceTokens: {
        create: async (name) => {
          names.push(name);
          return created;
        },
        remove: async () => undefined,
      },
    });
    return { code, out, err, names };
  }

  it("adds a machine with a new service token and prints the setup line once", async () => {
    const result = await run(["add", "mac-mini", "--hub", "https://agent.example.com/anything"]);
    expect(result.code).toBe(0);
    expect(result.names).toEqual(["superagent2-runner-mac-mini"]);
    const line = result.out.find((item) => item.startsWith("superagent2-runner-setup:"));
    const setup = decodeRunnerSetup(line ?? "");
    expect(setup).toMatchObject({ hub: "https://agent.example.com", name: "mac-mini", accessClientId: "made.access", accessClientSecret: "made-secret" });
    const machines = createMachineStore(database, clock);
    expect(machines.byToken(setup?.runnerToken ?? "")).toMatchObject({ name: "mac-mini", accessClientId: "made.access", accessTokenId: "token-id" });
    const listed = await run(["list"]);
    expect(listed.out.join("\n")).toContain("mac-mini\tactive\taccess client made.access");
    expect(listed.out.join("\n")).not.toContain(setup?.runnerToken ?? "missing");
  });

  it("reuses an existing service token and says the secret is asked for", async () => {
    const result = await run(["add", "pc", "--access-client-id", "old.access"], { HUB_PUBLIC_URL: "https://agent.example.com" });
    expect(result.code).toBe(0);
    expect(result.names).toEqual([]);
    const setup = decodeRunnerSetup(result.out.find((item) => item.startsWith("superagent2-runner-setup:")) ?? "");
    expect(setup?.accessClientSecret).toBeUndefined();
    expect(result.out.join("\n")).toContain("client secret");
  });

  it("needs Cloudflare's settings to create a token", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMachineCommand({
      argv: ["add", "pc", "--hub", "https://agent.example.com"],
      environment: { HUB_DATA_DIR: dataDir },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      clock,
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ACCESS_API_TOKEN");
    expect(createMachineStore(database, clock).list()).toEqual([]);
  });

  it("refuses a bad name, a missing address and a duplicate before creating anything", async () => {
    expect((await run(["add", "nas", "--hub", "https://a.example.com"])).code).toBe(2);
    expect((await run(["add", "pc"])).code).toBe(2);
    expect((await run(["add", "pc", "--hub", "https://a.example.com"])).code).toBe(0);
    const again = await run(["add", "pc", "--hub", "https://a.example.com"]);
    expect(again.code).toBe(1);
    expect(again.names).toEqual([]);
  });

  it("revokes a machine", async () => {
    await run(["add", "pc", "--hub", "https://a.example.com"]);
    const revoked = await run(["revoke", "pc"]);
    expect(revoked.code).toBe(0);
    expect(createMachineStore(database, clock).active("pc")).toBeUndefined();
    expect((await run(["revoke", "pc"])).code).toBe(1);
    expect((await run(["list"])).out.join("\n")).toContain("pc\trevoked");
  });
});
