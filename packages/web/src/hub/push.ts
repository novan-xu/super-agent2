import type { PushSubscriptionRequest } from "@super-agent2/protocol";
import { initialPushFacts, type Permission, type PushFacts, pushPhase, type PushPhase } from "../live/push.js";
import { createStore, type Store } from "../live/store.js";
import type { Failure, HubApi } from "./api.js";

export interface DeviceSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly key: string;
}

export interface PushBrowser {
  supported(): boolean;
  ios(): boolean;
  standalone(): boolean;
  permission(): Permission;
  requestPermission(): Promise<Permission>;
  register(): Promise<void>;
  subscription(): Promise<DeviceSubscription | null>;
  subscribe(key: string): Promise<DeviceSubscription | null>;
  unsubscribe(): Promise<void>;
}

export interface PushOptions {
  readonly api: Pick<HubApi, "pushKey" | "subscribePush" | "unsubscribePush">;
  readonly browser: PushBrowser;
  readonly onFailure: (failure: Failure) => void;
}

function requestOf(subscription: DeviceSubscription): PushSubscriptionRequest {
  return { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth }, applicationServerKey: subscription.key };
}

export class PushController {
  readonly store: Store<PushFacts> = createStore(initialPushFacts);
  private starting: Promise<void> | undefined;

  constructor(private readonly options: PushOptions) {}

  phase(): PushPhase {
    return pushPhase(this.store.getState());
  }

  start(): Promise<void> {
    this.starting ??= this.read().finally(() => {
      if (this.store.getState().key === undefined) {
        this.starting = undefined;
      }
    });
    return this.starting;
  }

  async toggle(): Promise<void> {
    const phase = this.phase();
    if (phase === "on") {
      await this.turnOff();
    } else if (phase === "off") {
      await this.turnOn();
    }
  }

  private patch(change: Partial<PushFacts>): void {
    this.store.update((facts) => ({ ...facts, ...change }));
  }

  private async read(): Promise<void> {
    const { api, browser } = this.options;
    const key = await api.pushKey();
    if (!key.ok) {
      return;
    }
    const base = { ios: browser.ios(), standalone: browser.standalone(), supported: browser.supported() };
    if (key.value.publicKey === null || !base.supported) {
      this.patch({ ...base, key: key.value.publicKey });
      return;
    }
    let current: DeviceSubscription | null = null;
    try {
      await browser.register();
      current = await browser.subscription();
    } catch {
      this.patch({ ...base, supported: false, key: key.value.publicKey });
      return;
    }
    const permission = browser.permission();
    if (current !== null && current.key !== key.value.publicKey) {
      await api.unsubscribePush(current.endpoint);
      await browser.unsubscribe().catch(() => undefined);
      current = null;
    }
    if (current !== null && permission === "granted") {
      await api.subscribePush(requestOf(current));
    }
    this.patch({ ...base, key: key.value.publicKey, permission, subscribed: current !== null && permission === "granted" });
  }

  private async turnOn(): Promise<void> {
    const { api, browser } = this.options;
    const key = this.store.getState().key;
    if (key === undefined || key === null) {
      return;
    }
    this.patch({ working: true });
    try {
      const permission = await browser.requestPermission();
      if (permission !== "granted") {
        this.patch({ permission });
        return;
      }
      const subscription = await browser.subscribe(key);
      if (subscription === null) {
        this.options.onFailure("network");
        return;
      }
      const saved = await api.subscribePush(requestOf(subscription));
      if (!saved.ok) {
        await browser.unsubscribe().catch(() => undefined);
        this.options.onFailure(saved.error);
        return;
      }
      this.patch({ permission, subscribed: true });
    } catch {
      this.options.onFailure("network");
    } finally {
      this.patch({ working: false });
    }
  }

  private async turnOff(): Promise<void> {
    const { api, browser } = this.options;
    this.patch({ working: true });
    try {
      const current = await browser.subscription();
      if (current !== null) {
        await api.unsubscribePush(current.endpoint);
      }
      await browser.unsubscribe();
      this.patch({ subscribed: false });
    } catch {
      this.options.onFailure("network");
    } finally {
      this.patch({ working: false });
    }
  }
}
