import { text } from "@super-agent2/catalog";
import type { PageRoute, PageView } from "@super-agent2/protocol";
import { type MouseEvent, type ReactNode, useState } from "react";
import type { SocketStatus } from "../hub/socket.js";
import { Icon, type IconName, Logo } from "./icons.js";
import type { Navigate } from "./route.js";

interface Destination {
  readonly view: PageView;
  readonly icon: IconName;
  readonly label: string;
}

const main: readonly Destination[] = [
  { view: "workbench", icon: "inbox", label: text("navigation.workbench") },
  { view: "conversations", icon: "chat", label: text("navigation.conversation") },
  { view: "memory", icon: "memory", label: text("navigation.memory") },
  { view: "schedules", icon: "calendar", label: text("navigation.schedules") },
];

const remote: Destination = { view: "remote", icon: "screen", label: text("navigation.remote") };
const foot: readonly Destination[] = [{ view: "settings", icon: "gear", label: text("navigation.settings") }];

export function viewOf(route: PageRoute, ticketFrom: PageView = "workbench"): PageView {
  if (route.view === "home" || route.view === "transfer") {
    return "conversations";
  }
  return route.view === "ticket" ? (ticketFrom === "history" ? "settings" : ticketFrom) : route.view;
}

export function titleOf(view: PageView): string {
  return (view === "remote" ? remote : [...main, ...foot].find((destination) => destination.view === view))?.label ?? "";
}

export function followLink(event: MouseEvent, go: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  go();
}

export interface ShellProps {
  readonly route: PageRoute;
  readonly ticketFrom?: PageView;
  readonly navigate: Navigate;
  readonly destinationOf: (view: PageView) => PageRoute;
  readonly hrefOf: (view: PageView) => string;
  readonly status: SocketStatus;
  readonly linked: boolean;
  readonly model: string | null;
  readonly actions?: ReactNode;
  readonly headerTabs?: ReactNode;
  readonly fill: boolean;
  readonly subtitle?: string | null;
  readonly toast: string | null;
  readonly waiting: number;
  readonly suggestions?: number;
  readonly pendingSchedules?: number;
  readonly hasPeers?: boolean;
  readonly allowance?: ReactNode;
  readonly collapsedAllowance?: ReactNode;
  readonly children?: ReactNode;
}

export function countOf(view: PageView, waiting: number, suggestions = 0, pendingSchedules = 0): number {
  return view === "workbench" ? waiting : view === "memory" ? suggestions : view === "schedules" ? pendingSchedules : 0;
}

const sidebarKey = "sidebar.collapsed";

function loadCollapsed(): boolean {
  try { return localStorage.getItem(sidebarKey) === "true"; } catch { return false; }
}

export function Shell(props: ShellProps) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(sidebarKey, String(next)); } catch {}
  };
  const destinations = props.hasPeers ? [...main, remote] : main;
  const current = viewOf(props.route, props.ticketFrom);
  const count = (view: PageView) => countOf(view, props.waiting, props.suggestions, props.pendingSchedules);
  const link = (destination: Destination, className: string, inner: ReactNode) => (
    <a
      key={destination.view}
      className={className}
      href={props.hrefOf(destination.view)}
      aria-label={count(destination.view) > 0 ? `${destination.label} ${count(destination.view)}` : destination.label}
      aria-current={current === destination.view ? "page" : undefined}
      title={destination.label}
      onClick={(event) => followLink(event, () => props.navigate(props.destinationOf(destination.view)))}
    >
      {inner}
    </a>
  );
  const navItem = (destination: Destination) => (
    <li key={destination.view}>
      {link(
        destination,
        "nav-btn",
        <>
          <Icon name={destination.icon} />
          <span className="nav-label">{destination.label}</span>
          {count(destination.view) > 0 ? <span className="count count--hot">{count(destination.view)}</span> : null}
        </>,
      )}
    </li>
  );
  const online = props.status === "open";
  const lamp = (label: string) => (collapsed ? { tabIndex: 0, role: "img", "aria-label": label, title: label } : {});
  return (
    <>
      <div className={collapsed ? "app app--collapsed" : "app"}>
        <nav className="side" aria-label={text("navigation.main")}>
          <div className="side-head"><div className="brand">
            <button className="side-toggle brand-toggle" type="button" aria-label={text(collapsed ? "navigation.expandSidebar" : "navigation.collapseSidebar")} title={text(collapsed ? "navigation.expandSidebar" : "navigation.collapseSidebar")} aria-expanded={!collapsed} onClick={toggleSidebar}><Logo size={48} /></button>
            <span>{text("app.name")}</span>
          </div></div>
          <ul className="nav">{destinations.map(navItem)}</ul>
          <div className="side-allowance-full">{props.allowance}</div>
          <div className="side-allowance-rings">{props.collapsedAllowance}</div>
          <div className="side-foot">
            <div className="hub-card">
              <div className="hub-line">
                <span className={`dot ${online ? "dot--ok" : "dot--warn"}`} {...lamp(`${text("hub.name")} ${online ? text("hub.online") : text("hub.reconnecting")}`)} />
                <span>{text("hub.name")}</span>
                <span className="od-fill">{online ? text("hub.online") : text("hub.reconnecting")}</span>
              </div>
              <div className="hub-line">
                <span className={`dot ${online && props.linked ? "dot--ok" : "dot--bad"}`} {...lamp(`${text("brain.name")} ${online && props.linked ? (props.model ?? text("hub.online")) : text("brain.offline")}`)} />
                <span>{text("brain.name")}</span>
                <span className="od-fill mono od-truncate">{props.linked ? (props.model ?? "") : text("brain.offline")}</span>
              </div>
            </div>
            <ul className="nav">{foot.map(navItem)}</ul>
          </div>
        </nav>
        <div className="body">
          <header className={props.headerTabs === undefined ? "top" : "top top--workbench"}>
            <div className={props.headerTabs === undefined ? "top-title" : "sr-only"}>
              <h1>{titleOf(current)}</h1>
              {props.subtitle === undefined || props.subtitle === null ? null : (
                <>
                  <span className="muted">/</span>
                  <span className="muted top-sub">{props.subtitle}</span>
                </>
              )}
            </div>
            {props.headerTabs}
            <div className="od-row">{props.actions}</div>
          </header>
          <main className={props.fill ? "main is-fill" : "main"} id="main" tabIndex={-1}>
            {props.children}
          </main>
        </div>
        <nav className="tabbar" aria-label={text("navigation.main")}>
          {[...destinations, ...foot].map((destination) =>
            link(
              destination,
              "tab",
              <>
                <span>
                  <Icon name={destination.icon} />
                </span>
                <span>{destination.label}</span>
                {count(destination.view) > 0 ? <span className="tab-badge">{count(destination.view)}</span> : null}
              </>,
            ),
          )}
        </nav>
      </div>
      <div className="toasts" aria-live="polite">
        {props.toast === null ? null : (
          <div className="toast toast--bad" role="status">
            <Icon name="alert" />
            <span>{props.toast}</span>
          </div>
        )}
      </div>
    </>
  );
}
