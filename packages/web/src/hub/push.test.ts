import type { PushKey, PushSubscriptionRequest } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { Permission } from "../live/push.js";
import type { Answer, Failure } from "./api.js";
import { type DeviceSubscription, PushController, type PushBrowser } from "./push.js";

const key = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

interface FakeBrowser extends PushBrowser {
  readonly calls: string[];
  held: DeviceSubscription | null;
  permissionNow: Permission;
  grant: Permission;
  supportedNow: boolean;
  iosNow: boolean;
  standaloneNow: boolean;
  registerFails: boolean;
}

function browser(): FakeBrowser {
  const fake: FakeBrowser = {
    calls: [],
    held: null,
    permissionNow: "default",
    grant: "granted",
    supportedNow: true,
    iosNow: false,
    standaloneNow: false,
    registerFails: false,
    supported: () => fake.supportedNow,
    ios: () => fake.iosNow,
    standalone: () => fake.standaloneNow,
    permission: () => fake.permissionNow,
    requestPermission: () => {
      fake.calls.push("requestPermission");
      fake.permissionNow = fake.grant;
      return Promise.resolve(fake.grant);
    },
    register: () => {
      fake.calls.push("register");
      return fake.registerFails ? Promise.reject(new Error("no")) : Promise.resolve();
    },
    subscription: () => Promise.resolve(fake.held),
    subscribe: (applicationServerKey) => {
      fake.calls.push(`subscribe ${applicationServerKey}`);
      fake.held = { endpoint: "https://push.example.net/device", p256dh: "p256dh", auth: "auth", key: applicationServerKey };
      return Promise.resolve(fake.held);
    },
    unsubscribe: () => {
      fake.calls.push("unsubscribe");
      fake.held = null;
      return Promise.resolve();
    },
  };
  return fake;
}

interface FakeApi {
  readonly calls: string[];
  publicKey: string | null | "down";
  subscribeAnswer: Answer<{ subscribed: boolean }>;
  readonly pushKey: () => Promise<Answer<PushKey>>;
  readonly subscribePush: (subscription: PushSubscriptionRequest) => Promise<Answer<{ subscribed: boolean }>>;
  readonly unsubscribePush: (endpoint: string) => Promise<Answer<{ subscribed: boolean }>>;
}

function api(): FakeApi {
  const fake: FakeApi = {
    calls: [],
    publicKey: key,
    subscribeAnswer: { ok: true, value: { subscribed: true } },
    pushKey: () => (fake.publicKey === "down" ? Promise.resolve({ ok: false, error: "network" }) : Promise.resolve({ ok: true, value: { publicKey: fake.publicKey } })),
    subscribePush: (subscription) => {
      fake.calls.push(`subscribe ${subscription.endpoint} ${subscription.applicationServerKey}`);
      return Promise.resolve(fake.subscribeAnswer);
    },
    unsubscribePush: (endpoint) => {
      fake.calls.push(`unsubscribe ${endpoint}`);
      return Promise.resolve({ ok: true, value: { subscribed: false } });
    },
  };
  return fake;
}

function push(hub: FakeApi, device: FakeBrowser, failures: Failure[] = []): PushController {
  return new PushController({ api: hub, browser: device, onFailure: (failure) => failures.push(failure) });
}

describe("PushController", () => {
  it("stays out of the way when the hub has no keys, and does not even register the worker", async () => {
    const hub = api();
    hub.publicKey = null;
    const device = browser();
    const controller = push(hub, device);
    await controller.start();
    expect(controller.phase()).toBe("hidden");
    expect(device.calls).toEqual([]);
  });

  it("does not offer push in a browser that cannot do it", async () => {
    const device = browser();
    device.supportedNow = false;
    const controller = push(api(), device);
    await controller.start();
    expect(controller.phase()).toBe("hidden");
    expect(device.calls).toEqual([]);
  });

  it("asks an iPhone that has not been added to the home screen to add it", async () => {
    const device = browser();
    device.supportedNow = false;
    device.iosNow = true;
    const controller = push(api(), device);
    await controller.start();
    expect(controller.phase()).toBe("install");
  });

  it("is off for a device that has not subscribed", async () => {
    const device = browser();
    const controller = push(api(), device);
    await controller.start();
    expect(controller.phase()).toBe("off");
    expect(device.calls).toEqual(["register"]);
  });

  it("is blocked when the browser has refused notifications", async () => {
    const device = browser();
    device.permissionNow = "denied";
    const controller = push(api(), device);
    await controller.start();
    expect(controller.phase()).toBe("blocked");
  });

  it("asks for permission first, then subscribes with the hub's key and tells the hub", async () => {
    const hub = api();
    const device = browser();
    const controller = push(hub, device);
    await controller.start();
    await controller.toggle();
    expect(device.calls).toEqual(["register", "requestPermission", `subscribe ${key}`]);
    expect(hub.calls).toEqual([`subscribe https://push.example.net/device ${key}`]);
    expect(controller.phase()).toBe("on");
  });

  it("does not subscribe when the owner declines the permission", async () => {
    const hub = api();
    const device = browser();
    device.grant = "denied";
    const controller = push(hub, device);
    await controller.start();
    await controller.toggle();
    expect(device.calls).toEqual(["register", "requestPermission"]);
    expect(hub.calls).toEqual([]);
    expect(controller.phase()).toBe("blocked");
  });

  it("gives the subscription back when the hub does not take it", async () => {
    const hub = api();
    hub.subscribeAnswer = { ok: false, error: "network" };
    const device = browser();
    const failures: Failure[] = [];
    const controller = push(hub, device, failures);
    await controller.start();
    await controller.toggle();
    expect(device.held).toBeNull();
    expect(failures).toEqual(["network"]);
    expect(controller.phase()).toBe("off");
  });

  it("turns off by telling the hub and then dropping the subscription", async () => {
    const hub = api();
    const device = browser();
    const controller = push(hub, device);
    await controller.start();
    await controller.toggle();
    hub.calls.length = 0;
    await controller.toggle();
    expect(hub.calls).toEqual(["unsubscribe https://push.example.net/device"]);
    expect(device.held).toBeNull();
    expect(controller.phase()).toBe("off");
  });

  it("tells the hub again about a subscription the device already has, in case the hub lost it", async () => {
    const hub = api();
    const device = browser();
    device.permissionNow = "granted";
    device.held = { endpoint: "https://push.example.net/old", p256dh: "p", auth: "a", key };
    const controller = push(hub, device);
    await controller.start();
    expect(hub.calls).toEqual([`subscribe https://push.example.net/old ${key}`]);
    expect(controller.phase()).toBe("on");
  });

  it("drops a subscription made with keys the hub no longer uses", async () => {
    const hub = api();
    const device = browser();
    device.permissionNow = "granted";
    device.held = { endpoint: "https://push.example.net/old", p256dh: "p", auth: "a", key: "AAAA" };
    const controller = push(hub, device);
    await controller.start();
    expect(hub.calls).toEqual(["unsubscribe https://push.example.net/old"]);
    expect(device.held).toBeNull();
    expect(controller.phase()).toBe("off");
  });

  it("tries again to hear from the hub when the first attempt did not get through", async () => {
    const hub = api();
    hub.publicKey = "down";
    const controller = push(hub, browser());
    await controller.start();
    expect(controller.phase()).toBe("checking");
    hub.publicKey = key;
    await controller.start();
    expect(controller.phase()).toBe("off");
  });

  it("does not offer push when the worker cannot be registered", async () => {
    const device = browser();
    device.registerFails = true;
    const controller = push(api(), device);
    await controller.start();
    expect(controller.phase()).toBe("hidden");
  });

  it("ignores a press while it is working", async () => {
    const hub = api();
    const device = browser();
    const controller = push(hub, device);
    await controller.start();
    const first = controller.toggle();
    await controller.toggle();
    await first;
    expect(device.calls.filter((call) => call === "requestPermission")).toHaveLength(1);
  });
});
