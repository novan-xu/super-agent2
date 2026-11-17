import { text } from "@super-agent2/catalog";
import { cardParameter, type PageRoute, type PageView, pagePath } from "@super-agent2/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Failure, hubApi } from "./hub/api.js";
import { PageController } from "./hub/controller.js";
import { browserPush } from "./hub/browser-push.js";
import { PushController } from "./hub/push.js";
import { browserSocket } from "./hub/socket.js";
import { destinationOfMessage } from "./live/address.js";
import { initialPage } from "./live/page.js";
import { initialPushFacts, pushPhase } from "./live/push.js";
import type { Verdict } from "./live/waiting.js";
import { Icon } from "./parts/icons.js";
import { useRoute } from "./parts/route.js";
import { followLink, Shell } from "./parts/Shell.js";
import { failureText } from "./views/HoldCard.js";
import { ConversationView } from "./views/ConversationView.js";
import { WorkbenchView } from "./views/WorkbenchView.js";

const toastDuration = 4000;

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

  const [pushController] = useState(() => new PushController({ api: hubApi, browser: browserPush(), onFailure: (failure) => showFailure(failure) }));
  const pushFacts = useSyncExternalStore(pushController.store.subscribe, pushController.store.getState, () => initialPushFacts);
  const [focus, setFocus] = useState<string | null>(() => new URLSearchParams(window.location.search).get(cardParameter));
  const clearFocus = useCallback(() => setFocus(null), []);

  useEffect(() => {
    if (page.status === "open") {
      void pushController.start();
    }
  }, [page.status, pushController]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    const received = (event: MessageEvent) => {
      const destination = destinationOfMessage(event.data, window.location.origin);
      if (destination !== undefined) {
        navigate(destination.route);
        setFocus(destination.card);
      }
    };
    navigator.serviceWorker.addEventListener("message", received);
    return () => navigator.serviceWorker.removeEventListener("message", received);
  }, [navigate]);

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
  const cardActions = useMemo(
    () => ({
      arm: (key: string) => controller.arm(key),
      disarm: (key: string) => controller.disarm(key),
      answer: (key: string, verdict: Verdict) => void controller.answer(key, verdict),
    }),
    [controller],
  );
  const togglePush = useCallback(() => void pushController.toggle(), [pushController]);

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
      waiting={page.waiting.cards.length}
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
      ) : route.view === "workbench" ? (
        <WorkbenchView
          waiting={page.waiting}
          actions={cardActions}
          focus={focus}
          focused={clearFocus}
          push={pushPhase(pushFacts)}
          togglePush={togglePush}
        />
      ) : (
        <div className="page" />
      )}
    </Shell>
  );
}
