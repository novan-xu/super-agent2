import { ConversationId } from "./conversations.js";
import { SettingsSection } from "./settings.js";

export const pageViews = ["workbench", "conversations", "history", "memory", "settings"] as const;
export type PageView = (typeof pageViews)[number];

export type PageRoute =
  | { readonly view: "home" }
  | { readonly view: "conversations"; readonly conversation: string | null }
  | { readonly view: "ticket"; readonly ticket: number }
  | { readonly view: "settings"; readonly section: SettingsSection }
  | { readonly view: Exclude<PageView, "conversations"> };

export const pageAssetsPath = "/assets/";

export const pageIconsPath = "/icons/";

export const serviceWorkerPath = "/sw.js";

export const themeScriptPath = "/theme.js";

export const manifestPath = "/manifest.webmanifest";

export const cardParameter = "card";

export const ticketsPathSegment = "tickets";

export function ticketAddress(ticket: number): string {
  return `/${ticketsPathSegment}/${ticket}`;
}

export function cardAddress(key: string): string {
  return `/workbench?${cardParameter}=${encodeURIComponent(key)}`;
}

function isView(value: string): value is PageView {
  return (pageViews as readonly string[]).includes(value);
}

export function pageRoute(path: string): PageRoute | undefined {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "/") {
    return { view: "home" };
  }
  const parts = trimmed.split("/").slice(1);
  const [view, conversation, ...rest] = parts;
  if (view === ticketsPathSegment) {
    return conversation !== undefined && rest.length === 0 && /^[1-9][0-9]{0,15}$/.test(conversation) ? { view: "ticket", ticket: Number(conversation) } : undefined;
  }
  if (view === undefined || !isView(view) || rest.length > 0) {
    return undefined;
  }
  if (view === "conversations") {
    if (conversation === undefined) {
      return { view, conversation: null };
    }
    return ConversationId.safeParse(conversation).success ? { view, conversation } : undefined;
  }
  if (view === "settings" && conversation !== undefined) {
    const section = SettingsSection.safeParse(conversation);
    return section.success ? { view, section: section.data } : undefined;
  }
  return conversation === undefined ? { view } : undefined;
}

export function pagePath(route: PageRoute): string {
  switch (route.view) {
    case "home":
      return "/";
    case "conversations":
      return route.conversation === null ? "/conversations" : `/conversations/${route.conversation}`;
    case "ticket":
      return ticketAddress(route.ticket);
    case "settings":
      return "section" in route ? `/settings/${route.section}` : "/settings";
    default:
      return `/${route.view}`;
  }
}
