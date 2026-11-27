import { type PageRoute, pageRoute, remotePeerRoute } from "@super-agent2/protocol";
import { appPath, pagePath } from "./app-path.js";
import { useCallback, useEffect, useState } from "react";

export type Navigate = (route: PageRoute, replace?: boolean) => void;

function current(): PageRoute {
  const pathname = remotePeerRoute(window.location.pathname)?.path ?? window.location.pathname;
  if (pathname.replace(/\/$/, "") === "/history") {
    window.history.replaceState(window.history.state, "", appPath("/settings/history"));
    return { view: "settings", section: "history" };
  }
  return pageRoute(pathname, window.location.search) ?? { view: "home" };
}

export function useRoute(): readonly [PageRoute, Navigate] {
  const [route, setRoute] = useState<PageRoute>(current);
  useEffect(() => {
    const changed = () => setRoute(current());
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  const navigate = useCallback<Navigate>((next, replace = false) => {
    const path = pagePath(next);
    if (path !== window.location.pathname + window.location.search) {
      if (replace) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }
    }
    setRoute(next);
  }, []);
  return [route, navigate];
}
