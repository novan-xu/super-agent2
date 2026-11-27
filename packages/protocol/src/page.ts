import { ConversationId, MessageId, type TopicScope } from "./conversations.js";
import { RepositoryName } from "./repositories.js";
import { ScheduleId } from "./schedules.js";
import { SettingsSection } from "./settings.js";
import { TodoId, type TodoView } from "./todos.js";

export const pageViews = ["workbench", "conversations", "history", "todos", "schedules", "remote", "settings"] as const;
export type PageView = (typeof pageViews)[number];

export type PageRoute =
  | { readonly view: "home" }
  | { readonly view: "conversations"; readonly conversation: string | null; readonly scope?: TopicScope | undefined; readonly entry?: string | undefined }
  | { readonly view: "transfer" }
  | { readonly view: "ticket"; readonly ticket: number }
  | { readonly view: "settings"; readonly section: SettingsSection }
  | { readonly view: "schedules"; readonly proposal: string }
  | { readonly view: "todos"; readonly selection: TodoView }
  | { readonly view: "todos"; readonly todo: string }
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
  if (trimmed === "/memory") {
    return { view: "settings", section: "memory" };
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
    const entry = MessageId.safeParse(params.get("entry"));
    const scope: TopicScope | undefined = repository.success ? { kind: "repository", repository: repository.data }
      : params.get("scope") === "code" ? { kind: "code" } : params.get("scope") === "daily" ? { kind: "daily" } : undefined;
    return { view, conversation: conversation ?? null, ...(scope === undefined ? {} : { scope }), ...(conversation !== undefined && entry.success ? { entry: entry.data } : {}) };
  }
  if (view === "settings" && conversation !== undefined) {
    const section = SettingsSection.safeParse(conversation);
    return section.success ? { view, section: section.data } : undefined;
  }
  if (view === "schedules") {
    if (conversation !== undefined) return undefined;
    const proposal = ScheduleId.safeParse(new URLSearchParams(search).get("proposal"));
    return { view, ...(proposal.success ? { proposal: proposal.data } : {}) };
  }
  if (view === "todos") {
    if (conversation !== undefined) return undefined;
    const params = new URLSearchParams(search);
    const todo = TodoId.safeParse(params.get("todo"));
    if (todo.success) return { view, todo: todo.data };
    const list = TodoId.safeParse(params.get("list"));
    const section = params.get("view");
    if (list.success) return { view, selection: { list: list.data } };
    if (section === "planned" || section === "inbox" || section === "completed") return { view, selection: section };
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
      const params = new URLSearchParams();
      if (scope?.kind === "repository") {
        params.set("repository", scope.repository);
      } else if (scope !== undefined) {
        params.set("scope", scope.kind);
      }
      if (route.entry !== undefined && route.conversation !== null) params.set("entry", route.entry);
      return params.size === 0 ? path : `${path}?${params}`;
    }
    case "ticket":
      return ticketAddress(route.ticket);
    case "settings":
      return "section" in route ? `/settings/${route.section}` : "/settings";
    case "schedules":
      return "proposal" in route ? `/schedules?proposal=${encodeURIComponent(route.proposal)}` : "/schedules";
    case "todos":
      if ("todo" in route) return `/todos?todo=${encodeURIComponent(route.todo)}`;
      if (!("selection" in route) || route.selection === "today") return "/todos";
      return typeof route.selection === "string" ? `/todos?view=${route.selection}` : `/todos?list=${encodeURIComponent(route.selection.list)}`;
    default:
      return `/${route.view}`;
  }
}
