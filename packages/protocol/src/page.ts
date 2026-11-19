import { ConversationId, type TopicScope } from "./conversations.js";
import { RepositoryName } from "./repositories.js";
import { SettingsSection } from "./settings.js";

export const pageViews = ["workbench", "conversations", "history", "memory", "settings"] as const;
export type PageView = (typeof pageViews)[number];

export type PageRoute =
  | { readonly view: "home" }
  | { readonly view: "conversations"; readonly conversation: string | null; readonly scope?: TopicScope | undefined }
  | { readonly view: "transfer" }
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

export function pageRoute(path: string, search = ""): PageRoute | undefined {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "/") {
    return { view: "home" };
  }
  if (trimmed === "/transfer") {
    return { view: "transfer" };
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
    if (conversation !== undefined && !ConversationId.safeParse(conversation).success) {
      return undefined;
    }
    const params = new URLSearchParams(search);
    const repository = RepositoryName.safeParse(params.get("repository"));
    const scope: TopicScope | undefined = repository.success ? { kind: "repository", repository: repository.data }
      : params.get("scope") === "code" ? { kind: "code" } : params.get("scope") === "daily" ? { kind: "daily" } : undefined;
    return { view, conversation: conversation ?? null, ...(scope === undefined ? {} : { scope }) };
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
    case "conversations": {
      const path = route.conversation === null ? "/conversations" : `/conversations/${route.conversation}`;
      const scope = route.scope;
      if (scope?.kind === "repository") {
        return `${path}?${new URLSearchParams({ repository: scope.repository })}`;
      }
      return scope?.kind === "code" || scope?.kind === "daily" ? `${path}?scope=${scope.kind}` : path;
    }
    case "ticket":
      return ticketAddress(route.ticket);
    case "settings":
      return "section" in route ? `/settings/${route.section}` : "/settings";
    default:
      return `/${route.view}`;
  }
}
