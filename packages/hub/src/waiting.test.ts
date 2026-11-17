import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushPayload, PushKey, PushState, type ServerMessage, WaitingList, type WaitingCard } from "@super-agent2/protocol";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hub } from "./hub.js";
import { fingerprintOf } from "./lock.js";
import { createPushDevice, type PushDevice, receivePush } from "./push-device.js";
import { generateVapidKeys, type VapidKeys } from "./push.js";
import { assertion, keySet, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { fakeTarget, testCredentials, waitForState } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";
import type { Waiting } from "./waiting.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
let keys: VapidKeys;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-waiting-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  keys = generateVapidKeys();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

interface Push {
  readonly endpoint: string;
  readonly body: Buffer;
}

type PushAnswer = number | "hang" | "unreachable";

interface PushService {
  readonly received: Push[];
  answer: PushAnswer;
  readonly fetch: typeof fetch;
}

function pushService(): PushService {
  const received: Push[] = [];
  const service: PushService = {
    received,
    answer: 201,
    fetch: (input, init) => {
      received.push({ endpoint: String(input), body: Buffer.from(init?.body as Uint8Array) });
      if (service.answer === "unreachable") {
        return Promise.reject(new Error("unreachable"));
      }
      if (service.answer === "hang") {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(new Response(null, { status: service.answer as number }));
    },
  };
  return service;
}

async function start(options: { readonly push?: PushService; readonly vapid?: boolean } = {}): Promise<Hub> {
  hub = await startTestHub({
    config: { ...testConfig(dataDir), projectFolders: ["/srv/projects"], ...(options.vapid === false ? {} : { vapid: keys }) },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [fakeTarget("hub")],
    credentials: testCredentials,
    ...(options.push === undefined ? {} : { pushFetch: options.push.fetch }),
  });
  return hub;
}

function origin(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}`;
}

async function owner(running: Hub, path: string, init: RequestInit & { readonly token?: string | null } = {}): Promise<Response> {
  const { token, ...rest } = init;
  const headers = new Headers({ origin: origin(running.address), "content-type": "application/json", ...(rest.headers as Record<string, string> | undefined) });
  const proof = token === undefined ? await assertion({ key, clock }) : token;
  if (proof !== null) {
    headers.set("Cf-Access-Jwt-Assertion", proof);
  }
  return fetch(`${origin(running.address)}${path}`, { ...rest, headers });
}

class Inbox {
  readonly messages: ServerMessage[] = [];
  private readonly wakers = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage);
      for (const wake of this.wakers) {
        wake();
      }
    });
  }

  until(predicate: (messages: readonly ServerMessage[]) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (predicate(this.messages)) {
          this.wakers.delete(check);
          resolve();
        }
      };
      this.wakers.add(check);
      check();
    });
  }

  lastCards(): readonly WaitingCard[] | undefined {
    const updates = this.messages.flatMap((message) => (message.type === "waiting" ? [message.cards] : []));
    return updates.at(-1);
  }

  untilCards(count: number): Promise<void> {
    return this.until(() => this.lastCards()?.length === count);
  }
}

async function open(running: Hub): Promise<Inbox> {
  const token = await assertion({ key, clock });
  const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws`, { headers: { "Cf-Access-Jwt-Assertion": token } });
  sockets.push(socket);
  const inbox = new Inbox(socket);
  await inbox.until((messages) => messages.some((message) => message.type === "waiting"));
  return inbox;
}

function hold(running: Hub, command = "gh repo delete novan-xu/old --yes") {
  const { id } = running.commands.start({ target: "hub", command, cwd: "/srv/projects/app" });
  return waitForState(running.commands, id, "held");
}

function decision(id: string, fingerprint: string, verdict: "release" | "refuse", running: Hub): Promise<Response> {
  return owner(running, `/api/commands/${id}/${verdict}`, { method: "POST", body: JSON.stringify({ fingerprint }) });
}

function untilCards(waiting: Waiting, count: number): Promise<void> {
  return new Promise((resolve) => {
    if (waiting.cards().length === count) {
      resolve();
      return;
    }
    const unsubscribe = waiting.subscribe((cards) => {
      if (cards.length === count) {
        unsubscribe();
        resolve();
      }
    });
  });
}

async function subscribe(running: Hub, device: PushDevice, endpoint = "http://127.0.0.1:9/device/one"): Promise<Response> {
  return owner(running, "/api/push/subscription", {
    method: "POST",
    body: JSON.stringify({ endpoint, keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: keys.publicKey }),
  });
}

describe("what waits for the owner, live", () => {
  it("shows a held command to a page that is already connected, with everything the card needs", async () => {
    const running = await start();
    const page = await open(running);
    expect(page.lastCards()).toEqual([]);
    const held = await hold(running);
    await page.untilCards(1);
    const [card] = page.lastCards() ?? [];
    expect(card).toMatchObject({
      kind: "hold",
      key: `hold:${held.id}`,
      command: { id: held.id, state: "held", target: "hub", command: "gh repo delete novan-xu/old --yes", account: "novan-xu", cwd: "/srv/projects/app" },
      hold: { form: "repository-deletion", fingerprint: fingerprintOf(held), answer: null },
    });
  });

  it("tells a page that connects later what already waits, newest first", async () => {
    const running = await start();
    const first = await hold(running, "gh repo delete novan-xu/one --yes");
    clock.advance(1000);
    const second = await hold(running, "gh repo delete novan-xu/two --yes");
    const page = await open(running);
    expect(page.lastCards()?.map((card) => (card.kind === "hold" ? card.command.id : card.key))).toEqual([second.id, first.id]);
    const list = WaitingList.parse(await (await owner(running, "/api/waiting", { method: "GET" })).json());
    expect(list.cards.map((card) => (card.kind === "hold" ? card.command.id : card.key))).toEqual([second.id, first.id]);
  });

  it("runs the command when the owner releases it, and every other page sees the card leave", async () => {
    const running = await start();
    const mine = await open(running);
    const other = await open(running);
    const held = await hold(running);
    await Promise.all([mine.untilCards(1), other.untilCards(1)]);
    const response = await decision(held.id, fingerprintOf(held), "release", running);
    expect(response.status).toBe(202);
    await Promise.all([mine.untilCards(0), other.untilCards(0)]);
    expect(await running.commands.finished(held.id)).toMatchObject({ state: "exited" });
  });

  it("drops the command when the owner refuses it, and the card leaves", async () => {
    const running = await start();
    const page = await open(running);
    const held = await hold(running);
    await page.untilCards(1);
    expect((await decision(held.id, fingerprintOf(held), "refuse", running)).status).toBe(202);
    await page.untilCards(0);
    expect(await running.commands.finished(held.id)).toMatchObject({ state: "dropped" });
  });

  it("takes the card away when the command is stopped while it waits", async () => {
    const running = await start();
    const page = await open(running);
    const held = await hold(running);
    await page.untilCards(1);
    running.commands.stop(held.id);
    await page.untilCards(0);
    expect(running.waiting.cards()).toEqual([]);
  });

  it("keeps a card for a hold that a wrong fingerprint failed to answer", async () => {
    const running = await start();
    const page = await open(running);
    const held = await hold(running);
    await page.untilCards(1);
    expect((await decision(held.id, "0".repeat(64), "release", running)).status).toBe(409);
    expect(running.waiting.cards()).toHaveLength(1);
    expect(running.commands.get(held.id)?.state).toBe("held");
  });

  it("shows only commands the lock holds", async () => {
    const running = await start();
    const page = await open(running);
    const { id } = running.commands.start({ target: "hub", command: "echo hello" });
    await running.commands.finished(id);
    expect(page.lastCards()).toEqual([]);
  });

  it("shows a command that was still held when the hub started", async () => {
    const first = await start();
    const held = await hold(first);
    await hub?.close();
    hub = undefined;
    const second = await start();
    const page = await open(second);
    expect(page.lastCards()?.map((card) => (card.kind === "hold" ? card.command.id : card.key))).toEqual([held.id]);
  });
});

describe("notifying a device", () => {
  it("offers the public key, and none when the hub has no keys", async () => {
    const running = await start();
    expect(PushKey.parse(await (await owner(running, "/api/push", { method: "GET" })).json())).toEqual({ publicKey: keys.publicKey });
    await running.close();
    hub = undefined;
    const bare = await start({ vapid: false });
    expect(PushKey.parse(await (await owner(bare, "/api/push", { method: "GET" })).json())).toEqual({ publicKey: null });
  });

  it("sends a Chinese notification to a subscribed device when a command is held, without the command in it", async () => {
    const service = pushService();
    const running = await start({ push: service });
    const device = createPushDevice();
    const subscribed = await subscribe(running, device);
    expect(PushState.parse(await subscribed.json())).toEqual({ subscribed: true });
    const held = await hold(running, "gh repo delete novan-xu/secret-project --yes");
    await untilCards(running.waiting, 1);
    await running.push?.idle();
    expect(service.received).toHaveLength(1);
    const [received] = service.received;
    expect(received?.endpoint).toBe("http://127.0.0.1:9/device/one");
    const readable = receivePush(device, received?.body ?? Buffer.alloc(0));
    const payload = PushPayload.parse(JSON.parse(readable));
    expect(payload).toEqual({ title: "等你", body: "有一条命令等你确认", url: `/workbench?card=${encodeURIComponent(`hold:${held.id}`)}`, tag: `hold:${held.id}` });
    expect(readable).not.toContain("secret-project");
    expect(readable).not.toContain("gh repo");
  });

  it("sends once for each hold and not when the hold is answered", async () => {
    const service = pushService();
    const running = await start({ push: service });
    await subscribe(running, createPushDevice());
    const first = await hold(running, "gh repo delete novan-xu/one --yes");
    await untilCards(running.waiting, 1);
    await decision(first.id, fingerprintOf(first), "refuse", running);
    await untilCards(running.waiting, 0);
    await running.push?.idle();
    expect(service.received).toHaveLength(1);
    await hold(running, "gh repo delete novan-xu/two --yes");
    await untilCards(running.waiting, 1);
    await running.push?.idle();
    expect(service.received).toHaveLength(2);
  });

  it("does not send again for what already waited when the hub started", async () => {
    const service = pushService();
    const first = await start({ push: service });
    await subscribe(first, createPushDevice());
    await hold(first);
    await untilCards(first.waiting, 1);
    await first.push?.idle();
    expect(service.received).toHaveLength(1);
    await hub?.close();
    hub = undefined;
    const second = await start({ push: service });
    await second.push?.idle();
    expect(service.received).toHaveLength(1);
  });

  it("sends to every subscribed device", async () => {
    const service = pushService();
    const running = await start({ push: service });
    await subscribe(running, createPushDevice(), "http://127.0.0.1:9/device/one");
    await subscribe(running, createPushDevice(), "http://127.0.0.1:9/device/two");
    await hold(running);
    await untilCards(running.waiting, 1);
    await running.push?.idle();
    expect(service.received.map((push) => push.endpoint).sort()).toEqual(["http://127.0.0.1:9/device/one", "http://127.0.0.1:9/device/two"]);
  });

  it("forgets a subscription the push service reports as gone", async () => {
    const service = pushService();
    service.answer = 410;
    const running = await start({ push: service });
    await subscribe(running, createPushDevice());
    await hold(running, "gh repo delete novan-xu/one --yes");
    await untilCards(running.waiting, 1);
    await running.push?.idle();
    expect(service.received).toHaveLength(1);
    await hold(running, "gh repo delete novan-xu/two --yes");
    await untilCards(running.waiting, 2);
    await running.push?.idle();
    expect(service.received).toHaveLength(1);
  });

  it("keeps a subscription when the push service only fails", async () => {
    const service = pushService();
    service.answer = 503;
    const running = await start({ push: service });
    await subscribe(running, createPushDevice());
    await hold(running, "gh repo delete novan-xu/one --yes");
    await untilCards(running.waiting, 1);
    await running.push?.idle();
    await hold(running, "gh repo delete novan-xu/two --yes");
    await untilCards(running.waiting, 2);
    await running.push?.idle();
    expect(service.received).toHaveLength(2);
  });

  it("stores and shows a hold when no device is subscribed", async () => {
    const service = pushService();
    const running = await start({ push: service });
    const page = await open(running);
    await hold(running);
    await page.untilCards(1);
    await running.push?.idle();
    expect(service.received).toEqual([]);
  });

  it.each<PushAnswer>(["unreachable", 500])("stores, shows and runs a hold when the push service answers %s", async (answer) => {
    const service = pushService();
    service.answer = answer;
    const running = await start({ push: service });
    await subscribe(running, createPushDevice());
    const page = await open(running);
    const held = await hold(running);
    await page.untilCards(1);
    expect((await decision(held.id, fingerprintOf(held), "release", running)).status).toBe(202);
    expect(await running.commands.finished(held.id)).toMatchObject({ state: "exited" });
    await page.untilCards(0);
  });

  it("shows and releases a hold while the push service never answers, and still stops", async () => {
    const service = pushService();
    service.answer = "hang";
    const running = await start({ push: service });
    await subscribe(running, createPushDevice());
    const page = await open(running);
    const held = await hold(running);
    await page.untilCards(1);
    expect((await decision(held.id, fingerprintOf(held), "release", running)).status).toBe(202);
    expect(await running.commands.finished(held.id)).toMatchObject({ state: "exited" });
    await running.close();
    hub = undefined;
  });

  it("starts without keys, shows holds and offers no subscription", async () => {
    const running = await start({ vapid: false });
    const page = await open(running);
    await hold(running);
    await page.untilCards(1);
    expect(running.push).toBeUndefined();
    const device = createPushDevice();
    const response = await owner(running, "/api/push/subscription", {
      method: "POST",
      body: JSON.stringify({ endpoint: "https://push.example.net/x", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: keys.publicKey }),
    });
    expect(response.status).toBe(404);
  });
});

describe("subscribing a device", () => {
  it("replaces a subscription made again for the same device", async () => {
    const service = pushService();
    const running = await start({ push: service });
    const device = createPushDevice();
    await subscribe(running, device);
    await subscribe(running, device);
    await hold(running);
    await untilCards(running.waiting, 1);
    await running.push?.idle();
    expect(service.received).toHaveLength(1);
  });

  it("stops sending after the device unsubscribes", async () => {
    const service = pushService();
    const running = await start({ push: service });
    await subscribe(running, createPushDevice());
    const removed = await owner(running, "/api/push/subscription", { method: "DELETE", body: JSON.stringify({ endpoint: "http://127.0.0.1:9/device/one" }) });
    expect(PushState.parse(await removed.json())).toEqual({ subscribed: false });
    await hold(running);
    await untilCards(running.waiting, 1);
    await running.push?.idle();
    expect(service.received).toEqual([]);
  });

  it("refuses a subscription that cannot be used", async () => {
    const running = await start();
    const device = createPushDevice();
    const attempt = (body: Record<string, unknown>) =>
      owner(running, "/api/push/subscription", { method: "POST", body: JSON.stringify({ endpoint: "https://push.example.net/x", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: keys.publicKey, ...body }) });
    expect((await attempt({ endpoint: "http://push.example.net/x" })).status).toBe(400);
    expect((await attempt({ endpoint: "not a url" })).status).toBe(400);
    expect((await attempt({ keys: { p256dh: "AAAA", auth: device.auth } })).status).toBe(400);
    expect((await attempt({ keys: { p256dh: device.p256dh, auth: "AAAA" } })).status).toBe(400);
    expect((await attempt({ applicationServerKey: generateVapidKeys().publicKey })).status).toBe(409);
    expect((await attempt({})).status).toBe(200);
  });

  it("accepts a subscription only from the owner's own page", async () => {
    const running = await start();
    const device = createPushDevice();
    const body = JSON.stringify({ endpoint: "https://push.example.net/x", keys: { p256dh: device.p256dh, auth: device.auth }, applicationServerKey: keys.publicKey });
    expect((await owner(running, "/api/push/subscription", { method: "POST", body, token: null })).status).toBe(403);
    const service = await assertion({ key, clock, claims: serviceClaims() });
    expect((await owner(running, "/api/push/subscription", { method: "POST", body, token: service })).status).toBe(403);
    expect((await owner(running, "/api/push/subscription", { method: "POST", body, headers: { origin: "https://elsewhere.example.com" } })).status).toBe(403);
    expect((await owner(running, "/api/push/subscription", { method: "POST", body, headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await owner(running, "/api/push/subscription", { method: "POST", body: "{}" })).status).toBe(400);
  });
});
