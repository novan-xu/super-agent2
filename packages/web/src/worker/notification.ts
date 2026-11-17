export const notificationIcon = "/icons/icon-192.png";

export interface ShownNotification {
  readonly title: string;
  readonly options: {
    readonly body: string;
    readonly tag: string;
    readonly icon: string;
    readonly data: { readonly url: string };
  };
}

export interface OpenMessage {
  readonly type: "open";
  readonly url: string;
}

export interface WindowPage {
  readonly focused: boolean;
  readonly visibilityState: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^\/(?![/\\])/.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function readPush(payload: unknown): ShownNotification | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const { title, body, tag, url } = payload;
  if (!isText(title) || !isText(body) || !isText(tag) || !isAddress(url)) {
    return undefined;
  }
  return { title, options: { body, tag, icon: notificationIcon, data: { url } } };
}

export function targetOf(data: unknown): string | undefined {
  return isRecord(data) && isAddress(data["url"]) ? data["url"] : undefined;
}

export function openMessage(url: string): OpenMessage {
  return { type: "open", url };
}

export function pickWindow<Page extends WindowPage>(pages: readonly Page[]): Page | undefined {
  return pages.find((page) => page.focused) ?? pages.find((page) => page.visibilityState === "visible") ?? pages[0];
}
