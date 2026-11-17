import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandResponse, HoldList, Refusal } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccessVerifier } from "./access.js";
import { createCommandService } from "./commands.js";
import { openDatabase } from "./database.js";
import type { Hub } from "./hub.js";
import { lockSettings } from "./irreversible.js";
import { createKeyCache } from "./keys.js";
import { createConfirmationLock, fingerprintOf, refusedReason } from "./lock.js";
import { createHubServer, type HubServer } from "./server.js";
import type { Job, Target } from "./targets.js";
import {
  assertion,
  audience,
  keySet,
  serviceClaims,
  signingKey,
  type SigningKey,
  staticKeySource,
  team,
  TestClock,
  testConfig,
} from "./testing/access.js";
import { fakeTarget, testCredentials, waitForState } from "./testing/commands.js";
import { listenForFetch, startTestHub } from "./testing/http.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
let target: Target & { jobs: Job[] };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-lock-api-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  target = fakeTarget("hub");
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(): Promise<Hub> {
  target = fakeTarget("hub");
  hub = await startTestHub({
    config: { ...testConfig(dataDir), projectFolders: ["/srv/projects"] },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [target],
    credentials: testCredentials,
  });
  return hub;
}

function origin(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}`;
}

interface Call {
  readonly token?: string | undefined;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

async function post(address: AddressInfo, path: string, call: Call): Promise<Response> {
  const headers = new Headers({ origin: origin(address), "content-type": "application/json", ...call.headers });
  if (call.token !== undefined) {
    headers.set("Cf-Access-Jwt-Assertion", call.token);
  }
  return fetch(`${origin(address)}${path}`, { method: "POST", headers, body: call.body ?? "{}" });
}

async function holdOne(running: Hub, command = "gh repo delete novan-xu/old --yes") {
  const { id } = running.commands.start({ target: "hub", command, cwd: "/srv/projects/app" });
  const held = await waitForState(running.commands, id, "held");
  return { id, held, body: JSON.stringify({ fingerprint: fingerprintOf(held) }) };
}

describe("confirming over HTTP", () => {
  it("lists what is held with what the owner needs to confirm it", async () => {
    const running = await start();
    const { id, held } = await holdOne(running);
    const response = await fetch(`${origin(running.address)}/api/holds`, {
      headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) },
    });
    expect(response.status).toBe(200);
    const list = HoldList.parse(await response.json());
    expect(list.holds).toHaveLength(1);
    expect(list.holds[0]?.command).toMatchObject({ id, state: "held", command: "gh repo delete novan-xu/old --yes" });
    expect(list.holds[0]?.hold).toMatchObject({ form: "repository-deletion", fingerprint: fingerprintOf(held), answer: null });
  });

  it("runs the command exactly as held when the owner releases it from the page", async () => {
    const running = await start();
    const { id, body } = await holdOne(running);
    const response = await post(running.address, `/api/commands/${id}/release`, { token: await assertion({ key, clock }), body });
    expect(response.status).toBe(202);
    expect(CommandResponse.parse(await response.json()).command.id).toBe(id);
    expect(await running.commands.finished(id)).toMatchObject({ state: "exited", command: "gh repo delete novan-xu/old --yes" });
    expect(target.jobs.map((job) => [job.command, job.cwd])).toEqual([["gh repo delete novan-xu/old --yes", "/srv/projects/app"]]);
  });

  it("drops the command when the owner refuses it", async () => {
    const running = await start();
    const { id, body } = await holdOne(running);
    const response = await post(running.address, `/api/commands/${id}/refuse`, { token: await assertion({ key, clock }), body });
    expect(response.status).toBe(202);
    expect(await running.commands.finished(id)).toMatchObject({ state: "dropped", reason: refusedReason });
    expect(target.jobs).toEqual([]);
  });

  it("lets a command that is not on the list run without waiting", async () => {
    const running = await start();
    const { id } = running.commands.start({ target: "hub", command: "gh pr merge 12 --admin --squash" });
    expect(await running.commands.finished(id)).toMatchObject({ state: "exited" });
    expect(running.lock?.get(id)).toBeUndefined();
  });

  it("refuses a release without a sign-in or with a service token", async () => {
    const running = await start();
    const { id, body } = await holdOne(running);
    const service = await assertion({ key, clock, claims: serviceClaims() });
    for (const token of [undefined, service]) {
      const response = await post(running.address, `/api/commands/${id}/release`, { token, body });
      expect(response.status).toBe(403);
    }
    expect(running.commands.get(id)?.state).toBe("held");
    expect(target.jobs).toEqual([]);
  });

  it("refuses a release from another site, or with no origin, open in the owner's browser", async () => {
    const running = await start();
    const { id, body } = await holdOne(running);
    const token = await assertion({ key, clock });
    const attempts: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: `${origin(running.address)}.evil.example` },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of attempts) {
      const response = await post(running.address, `/api/commands/${id}/release`, { token, body, headers });
      expect(response.status).toBe(403);
      expect(Refusal.parse(await response.json()).error).toBe("forbidden");
    }
    const headers = new Headers({ "content-type": "application/json", "Cf-Access-Jwt-Assertion": token });
    const bare = await fetch(`${origin(running.address)}/api/commands/${id}/release`, { method: "POST", headers, body });
    expect(bare.status).toBe(403);
    expect(running.commands.get(id)?.state).toBe("held");
    expect(target.jobs).toEqual([]);
  });

  it("refuses a release that is not JSON or names no fingerprint", async () => {
    const running = await start();
    const { id, body } = await holdOne(running);
    const token = await assertion({ key, clock });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const response = await post(running.address, `/api/commands/${id}/release`, { token, body, headers: { "content-type": type } });
      expect(response.status).toBe(415);
    }
    for (const bad of ["", "{}", "not json", JSON.stringify({ fingerprint: "abc" })]) {
      const response = await post(running.address, `/api/commands/${id}/release`, { token, body: bad });
      expect(response.status).toBe(400);
    }
    const wrong = await post(running.address, `/api/commands/${id}/release`, { token, body: JSON.stringify({ fingerprint: "f".repeat(64) }) });
    expect(wrong.status).toBe(409);
    expect(running.commands.get(id)?.state).toBe("held");
    expect(target.jobs).toEqual([]);
  });

  it("answers not found for a command that was never held", async () => {
    const running = await start();
    const { id } = running.commands.start({ target: "hub", command: "git status" });
    await running.commands.finished(id);
    const response = await post(running.address, `/api/commands/${id}/release`, {
      token: await assertion({ key, clock }),
      body: JSON.stringify({ fingerprint: "0".repeat(64) }),
    });
    expect(response.status).toBe(404);
  });

  it("keeps a held command across a restart, then runs it exactly as held", async () => {
    const first = await start();
    const firstTarget = target;
    const { id, body } = await holdOne(first, "docker volume rm superagent-data");
    await first.close();
    hub = undefined;
    const second = await start();
    expect(second.commands.get(id)).toMatchObject({ state: "held", command: "docker volume rm superagent-data" });
    const response = await post(second.address, `/api/commands/${id}/release`, { token: await assertion({ key, clock }), body });
    expect(response.status).toBe(202);
    expect(await second.commands.finished(id)).toMatchObject({ state: "exited" });
    expect(target.jobs.map((job) => [job.command, job.cwd])).toEqual([["docker volume rm superagent-data", "/srv/projects/app"]]);
    expect(firstTarget.jobs).toEqual([]);
  });
});

describe("a front door that admits service tokens", () => {
  let server: HubServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("still refuses a release by a service token, because the lock checks the sign-in itself", async () => {
    const database = openDatabase({ dataDir, clock });
    try {
      const keys = createKeyCache({ source: staticKeySource(keySet(key)), clock });
      const verify = createAccessVerifier({ team, audience, keys, clock });
      const lock = createConfirmationLock({
        database,
        clock,
        verify,
        ownerEmail: testConfig(dataDir).ownerEmail,
        settings: lockSettings({ projectFolders: [], credentialPaths: [] }),
      });
      const commands = createCommandService({ database, clock, targets: [target], credentials: testCredentials, gate: lock.gate });
      server = createHubServer({ database, commands, verify, admit: () => true, lock });
      const address = await listenForFetch(server);
      const { id } = commands.start({ target: "hub", command: "gh repo delete novan-xu/old --yes" });
      const held = await waitForState(commands, id, "held");
      const body = JSON.stringify({ fingerprint: fingerprintOf(held) });
      const service = await assertion({ key, clock, claims: serviceClaims() });
      const session = await fetch(`${origin(address)}/api/session`, { headers: { "Cf-Access-Jwt-Assertion": service } });
      expect(session.status).toBe(200);
      const response = await post(address, `/api/commands/${id}/release`, { token: service, body });
      expect(response.status).toBe(403);
      expect(commands.get(id)?.state).toBe("held");
      expect(target.jobs).toEqual([]);
      await server.close();
      server = undefined;
      await commands.close();
    } finally {
      database.close();
    }
  });
});
