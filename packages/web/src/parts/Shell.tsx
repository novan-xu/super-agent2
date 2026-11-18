import { text } from "@super-agent2/catalog";
import type { PageRoute, PageView } from "@super-agent2/protocol";
import type { MouseEvent, ReactNode } from "react";
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
  { view: "history", icon: "history", label: text("navigation.history") },
  { view: "memory", icon: "memory", label: text("navigation.memory") },
];

const foot: readonly Destination[] = [{ view: "settings", icon: "gear", label: text("navigation.settings") }];

export function viewOf(route: PageRoute, ticketFrom: PageView = "workbench"): PageView {
  if (route.view === "home") {
    return "conversations";
  }
  return route.view === "ticket" ? ticketFrom : route.view;
}

export function titleOf(view: PageView): string {
  return [...main, ...foot].find((destination) => destination.view === view)?.label ?? "";
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
  readonly fill: boolean;
  readonly subtitle?: string | null;
  readonly toast: string | null;
  readonly waiting: number;
  readonly suggestions?: number;
  readonly children?: ReactNode;
}

export function countOf(view: PageView, waiting: number, suggestions = 0): number {
  return view === "workbench" ? waiting : view === "memory" ? suggestions : 0;
}

export function Shell(props: ShellProps) {
  const current = viewOf(props.route, props.ticketFrom);
  const link = (destination: Destination, className: string, inner: ReactNode) => (
    <a
      key={destination.view}
      className={className}
      href={props.hrefOf(destination.view)}
      aria-label={countOf(destination.view, props.waiting, props.suggestions) > 0 ? `${destination.label} ${countOf(destination.view, props.waiting, props.suggestions)}` : destination.label}
      aria-current={current === destination.view ? "page" : undefined}
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
          {countOf(destination.view, props.waiting, props.suggestions) > 0 ? <span className="count count--hot">{countOf(destination.view, props.waiting, props.suggestions)}</span> : null}
        </>,
      )}
    </li>
  );
  const online = props.status === "open";
  return (
    <>
      <div className="app">
        <nav className="side" aria-label={text("navigation.main")}>
          <div className="brand">
            <Logo />
            <span>{text("app.name")}</span>
          </div>
          <ul className="nav">{main.map(navItem)}</ul>
          <div className="side-foot">
            <div className="hub-card">
              <div className="hub-line">
                <span className={`dot ${online ? "dot--ok" : "dot--warn"}`} />
                <span>{text("hub.name")}</span>
                <span className="od-fill">{online ? text("hub.online") : text("hub.reconnecting")}</span>
              </div>
              <div className="hub-line">
                <span className={`dot ${online && props.linked ? "dot--ok" : "dot--bad"}`} />
                <span>{text("brain.name")}</span>
                <span className="od-fill mono od-truncate">{props.linked ? (props.model ?? "") : text("brain.offline")}</span>
              </div>
            </div>
            <ul className="nav">{foot.map(navItem)}</ul>
          </div>
        </nav>
        <div className="body">
          <header className="top">
            <div className="top-title">
              <h1>{titleOf(current)}</h1>
              {props.subtitle === undefined || props.subtitle === null ? null : (
                <>
                  <span className="muted">/</span>
                  <span className="muted top-sub">{props.subtitle}</span>
                </>
              )}
            </div>
            <div className="od-row">{props.actions}</div>
          </header>
          <main className={props.fill ? "main is-fill" : "main"} id="main" tabIndex={-1}>
            {props.children}
          </main>
        </div>
        <nav className="tabbar" aria-label={text("navigation.main")}>
          {[...main, ...foot].map((destination) =>
            link(
              destination,
              "tab",
              <>
                <span>
                  <Icon name={destination.icon} />
                </span>
                <span>{destination.label}</span>
                {countOf(destination.view, props.waiting, props.suggestions) > 0 ? <span className="tab-badge">{countOf(destination.view, props.waiting, props.suggestions)}</span> : null}
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
