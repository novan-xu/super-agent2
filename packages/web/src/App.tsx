import { text } from "@super-agent2/catalog";
import { type PageRoute, type PageView, pagePath } from "@super-agent2/protocol";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Failure, hubApi } from "./hub/api.js";
import { PageController } from "./hub/controller.js";
import { browserSocket } from "./hub/socket.js";
import { initialPage } from "./live/page.js";
import { Icon } from "./parts/icons.js";
import { useRoute } from "./parts/route.js";
import { followLink, Shell } from "./parts/Shell.js";
import { ConversationView } from "./views/ConversationView.js";

const toastDuration = 4000;

function failureText(failure: Failure): string {
  return failure === "network" ? text("failure.network") : text(`refusal.${failure}`);
}

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function App() {
  const [route, navigate] = useRoute();
  const [toast, setToast] = useState<string | null>(null);
  const now = useNow();
  const toastTimer = useRef<number | undefined>(undefined);
  const lastConversation = useRef<PageRoute>({ view: "home" });

  const showFailure = useCallback((failure: Failure) => {
    setToast(failureText(failure));
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), toastDuration);
  }, []);

  const [controller] = useState(
    () =>
      new PageController({
        api: hubApi,
        socket: {
          url: socketUrl(),
          create: browserSocket,
          schedule: (run, delay) => {
            const timer = window.setTimeout(run, delay);
            return () => window.clearTimeout(timer);
          },
        },
        onFailure: (failure) => showFailure(failure),
      }),
  );

  const page = useSyncExternalStore(controller.store.subscribe, controller.store.getState, () => initialPage);

  useEffect(() => {
    controller.start();
    const online = () => controller.reconnect(true);
    const visible = () => {
      if (document.visibilityState === "visible") {
        controller.reconnect(false);
      }
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
      controller.stop();
    };
  }, [controller]);

  const conversationId = route.view === "conversations" ? route.conversation : null;

  useEffect(() => {
    if (route.view === "conversations") {
      lastConversation.current = route;
    }
    controller.open(conversationId);
  }, [controller, conversationId, route]);

  useEffect(() => {
    if (route.view === "home" && page.listed) {
      const latest = page.list[0];
      navigate({ view: "conversations", conversation: latest === undefined ? null : latest.id }, true);
    }
  }, [navigate, page.listed, page.list, route.view]);

  const destinationOf = useCallback(
    (view: PageView): PageRoute => (view === "conversations" ? lastConversation.current : { view }),
    [],
  );
  const hrefOf = useCallback((view: PageView) => pagePath(destinationOf(view)), [destinationOf]);
  const conversationHref = useCallback((conversation: string) => pagePath({ view: "conversations", conversation }), []);
  const openConversation = useCallback((conversation: string) => navigate({ view: "conversations", conversation }), [navigate]);
  const send = useCallback(
    (message: string) => controller.send(message, (conversation) => navigate({ view: "conversations", conversation }, true)),
    [controller, navigate],
  );
  const stop = useCallback(() => void controller.interrupt(), [controller]);

  const inConversation = route.view === "conversations" || route.view === "home";
  const model = page.current?.turns.at(-1)?.model ?? null;
  const newConversation = { view: "conversations", conversation: null } as const;

  return (
    <Shell
      route={route}
      navigate={navigate}
      destinationOf={destinationOf}
      hrefOf={hrefOf}
      status={page.status}
      linked={page.linked}
      model={model}
      fill={inConversation}
      toast={toast}
      actions={
        inConversation ? (
          <a className="btn btn-sm" href={pagePath(newConversation)} onClick={(event) => followLink(event, () => navigate(newConversation))}>
            <Icon name="plus" />
            {text("conversation.new")}
          </a>
        ) : null
      }
    >
      {inConversation ? (
        <ConversationView
          state={page.current}
          list={page.list}
          status={page.status}
          linked={page.linked}
          model={model}
          hrefOf={conversationHref}
          open={openConversation}
          send={send}
          stop={stop}
          now={now}
        />
      ) : (
        <div className="page" />
      )}
    </Shell>
  );
}
