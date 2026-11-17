import { ConversationId } from "./conversations.js";

export const pageViews = ["workbench", "conversations", "history", "memory", "settings"] as const;
export type PageView = (typeof pageViews)[number];

export type PageRoute =
  | { readonly view: "home" }
  | { readonly view: "conversations"; readonly conversation: string | null }
  | { readonly view: Exclude<PageView, "conversations"> };

export const pageAssetsPath = "/assets/";

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
  if (view === undefined || !isView(view) || rest.length > 0) {
    return undefined;
  }
  if (view === "conversations") {
    if (conversation === undefined) {
      return { view, conversation: null };
    }
    return ConversationId.safeParse(conversation).success ? { view, conversation } : undefined;
  }
  return conversation === undefined ? { view } : undefined;
}

export function pagePath(route: PageRoute): string {
  switch (route.view) {
    case "home":
      return "/";
    case "conversations":
      return route.conversation === null ? "/conversations" : `/conversations/${route.conversation}`;
    default:
      return `/${route.view}`;
  }
}
