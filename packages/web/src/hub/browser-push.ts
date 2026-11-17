import { isIosDevice, type Permission } from "../live/push.js";
import type { DeviceSubscription, PushBrowser } from "./push.js";

function toBase64Url(buffer: ArrayBuffer | null): string {
  if (buffer === null) {
    return "";
  }
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function describe(subscription: PushSubscription): DeviceSubscription | null {
  const p256dh = toBase64Url(subscription.getKey("p256dh"));
  const auth = toBase64Url(subscription.getKey("auth"));
  const key = toBase64Url(subscription.options.applicationServerKey);
  return p256dh === "" || auth === "" ? null : { endpoint: subscription.endpoint, p256dh, auth, key };
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

export function browserPush(): PushBrowser {
  return {
    supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    ios: () => isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    standalone: () =>
      (navigator as Navigator & { readonly standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    permission: () => Notification.permission as Permission,
    requestPermission: async () => (await Notification.requestPermission()) as Permission,
    register: async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await registration();
    },
    subscription: async () => {
      const existing = await (await registration()).pushManager.getSubscription();
      return existing === null ? null : describe(existing);
    },
    subscribe: async (key) => {
      const created = await (await registration()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
      return describe(created);
    },
    unsubscribe: async () => {
      const existing = await (await registration()).pushManager.getSubscription();
      await existing?.unsubscribe();
    },
  };
}
