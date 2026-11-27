import { openMessage, pickWindow, readPush, targetOf } from "./notification.js";

interface WorkerEvent {
  waitUntil(work: Promise<unknown>): void;
}

interface PushWorkerEvent extends WorkerEvent {
  readonly data: { json(): unknown } | null;
}

interface ClickWorkerEvent extends WorkerEvent {
  readonly notification: { close(): void; readonly data: unknown };
}

interface WorkerPage {
  readonly url: string;
  readonly focused: boolean;
  readonly visibilityState: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

interface WorkerScope {
  readonly registration: { showNotification(title: string, options: ShownOptions): Promise<void> };
  readonly clients: {
    matchAll(options: { readonly type: "window"; readonly includeUncontrolled: boolean }): Promise<WorkerPage[]>;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install", listener: (event: WorkerEvent) => void): void;
  addEventListener(type: "activate", listener: (event: WorkerEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushWorkerEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: ClickWorkerEvent) => void): void;
}

type ShownOptions = NonNullable<ReturnType<typeof readPush>>["options"];

const scope = self as unknown as WorkerScope;

async function openAddress(url: string): Promise<void> {
  const pages = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const page = pickWindow(pages.filter((client) => !/^\/remote\/[^/]/.test(new URL(client.url).pathname)));
  if (page === undefined) {
    await scope.clients.openWindow(url);
    return;
  }
  page.postMessage(openMessage(url));
  await page.focus().catch(() => undefined);
}

scope.addEventListener("install", (event) => {
  event.waitUntil(scope.skipWaiting());
});

scope.addEventListener("activate", (event) => {
  event.waitUntil(scope.clients.claim());
});

scope.addEventListener("push", (event) => {
  let payload: unknown;
  try {
    payload = event.data?.json();
  } catch {
    payload = undefined;
  }
  const shown = readPush(payload);
  if (shown !== undefined) {
    event.waitUntil(scope.registration.showNotification(shown.title, shown.options));
  }
});

scope.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = targetOf(event.notification.data);
  if (url !== undefined) {
    event.waitUntil(openAddress(url));
  }
});
