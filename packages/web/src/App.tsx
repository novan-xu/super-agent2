import { text } from "@super-agent2/catalog";
import { cardParameter, type ChoiceChange, type PageRoute, type PageView, pagePath, type StuckAnswer } from "@super-agent2/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Failure, hubApi } from "./hub/api.js";
import { PageController } from "./hub/controller.js";
import { browserPush } from "./hub/browser-push.js";
import { PushController } from "./hub/push.js";
import { browserSocket } from "./hub/socket.js";
import { destinationOfMessage } from "./live/address.js";
import { initialPage } from "./live/page.js";
import { reviewCount } from "./live/tickets.js";
import { initialPushFacts, pushPhase } from "./live/push.js";
import type { Verdict } from "./live/waiting.js";
import { Icon } from "./parts/icons.js";
import { useRoute } from "./parts/route.js";
import { Shell } from "./parts/Shell.js";
import { failureText } from "./views/HoldCard.js";
import { ConversationView } from "./views/ConversationView.js";
import { HistoryView } from "./views/HistoryView.js";
import { type MemoryActions, MemoryView } from "./views/MemoryView.js";
import { type TicketActions, type TicketOrigin, TicketView } from "./views/TicketView.js";
import { WorkbenchView } from "./views/WorkbenchView.js";
import { type SettingsActions, SettingsView } from "./views/SettingsView.js";
import { type Appearance, appearanceEvent, readAppearance, writeAppearance, themeKey, accentKey } from "./live/appearance.js";

const toastDuration = 4000;

const workFlushDelay = 40;

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

function storageOf(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function App() {
  const [route, navigate] = useRoute();
  const [toast, setToast] = useState<string | null>(null);
  const now = useNow();
  const toastTimer = useRef<number | undefined>(undefined);
  const [creatingTopic, setCreatingTopic] = useState(false);
  const historyScroll = useRef(0);
  const [origin, setOrigin] = useState<TicketOrigin>("workbench");
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance(storageOf()));

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
        frame: (run) => {
          window.setTimeout(run, workFlushDelay);
        },
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
        setOrigin("workbench");
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
  const inConversation = route.view === "conversations" || route.view === "home";
  const inStream = inConversation && conversationId === null;
  const ticketId = route.view === "ticket" ? route.ticket : null;

  useEffect(() => {
    void controller.openTicket(ticketId);
  }, [controller, ticketId]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === themeKey || event.key === accentKey) {
        setAppearance(readAppearance(storageOf()));
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);

  useEffect(() => {
    if (route.view === "settings" && page.settings === null && page.status === "open") {
      void controller.loadSettings();
    }
  }, [controller, route.view, page.settings, page.status]);

  useEffect(() => {
    if (route.view === "history") {
      void controller.openHistory();
    }
  }, [controller, route.view]);

  useEffect(() => {
    controller.open(conversationId, inStream);
  }, [controller, conversationId, inStream]);

  const destinationOf = useCallback(
    (view: PageView): PageRoute => (view === "conversations" ? { view, conversation: null } : { view }),
    [],
  );
  const hrefOf = useCallback((view: PageView) => pagePath(destinationOf(view)), [destinationOf]);
  const conversationHref = useCallback((conversation: string) => pagePath({ view: "conversations", conversation }), []);
  const openConversation = useCallback((conversation: string) => navigate({ view: "conversations", conversation }), [navigate]);
  const newTopic = async () => {
    setCreatingTopic(true);
    try {
      const id = await controller.createTopic();
      if (id !== undefined) {
        openConversation(id);
      }
    } finally {
      setCreatingTopic(false);
    }
  };
  const send = useCallback(
    (message: string, attachments: readonly string[] = [], quotedMessage?: string) => controller.send(message, attachments, quotedMessage, conversationId),
    [controller, conversationId],
  );
  const stop = useCallback(() => void controller.interrupt(), [controller]);
  const cardActions = useMemo(
    () => ({
      answer: (key: string, verdict: Verdict) => void controller.answer(key, verdict),
      start: (keys: readonly string[]) => void controller.startChains(keys),
      choose: (key: string, change: ChoiceChange) => void controller.chooseChain(key, change),
      answerStuck: (key: string, verdict: StuckAnswer, words: string) => void controller.answerStuck(key, verdict, words),
    }),
    [controller],
  );
  const togglePush = useCallback(() => void pushController.toggle(), [pushController]);
  const ticketHref = useCallback((ticket: number) => pagePath({ view: "ticket", ticket }), []);
  const openTicket = useCallback(
    (ticket: number) => {
      setOrigin("workbench");
      navigate({ view: "ticket", ticket });
    },
    [navigate],
  );
  const openFromHistory = useCallback(
    (ticket: number) => {
      setOrigin("history");
      navigate({ view: "ticket", ticket });
    },
    [navigate],
  );
  const openLinked = useCallback((ticket: number) => navigate({ view: "ticket", ticket }), [navigate]);
  const backFromTicket = useCallback(() => navigate({ view: origin }), [navigate, origin]);
  const searchHistory = useCallback((query: string) => void controller.searchHistory(query), [controller]);
  const moreHistory = useCallback(() => void controller.moreHistory(), [controller]);
  const retryHistory = useCallback(() => void controller.loadHistory(), [controller]);
  const historyScrolled = useCallback((top: number) => {
    historyScroll.current = top;
  }, []);
  const ticketActions = useMemo<TicketActions>(
    () => ({
      stop: (ticket) => controller.stopTicket(ticket),
      reassign: (ticket, change) => controller.reassignTicket(ticket, change),
      message: (ticket, message, attachments) => controller.messageTicket(ticket, message, attachments),
      review: (ticket, decision, review) => controller.reviewDecision(ticket, decision, review),
      machines: () => controller.machines(),
    }),
    [controller],
  );
  const memoryActions = useMemo<MemoryActions>(
    () => ({
      add: (words) => controller.addMemory(words),
      edit: (id, words) => controller.editMemory(id, words),
      remove: (id) => controller.deleteMemory(id),
      decide: (id, decision) => controller.decideSuggestion(id, decision),
    }),
    [controller],
  );
  const [addingMemory, setAddingMemory] = useState(false);
  const openAdding = useCallback(() => setAddingMemory(true), []);
  const closeAdding = useCallback(() => setAddingMemory(false), []);
  const settingsActions = useMemo<SettingsActions>(
    () => ({
      addMachine: (name, system) => controller.addMachine(name, system),
      revokeMachine: (name) => controller.revokeMachine(name),
      setOrder: (order) => controller.setOrder(order),
      setAccount: (repository, account) => controller.setAccount(repository, account),
      setTable: (table) => controller.setTable(table),
      setAppearance: (change) => {
        writeAppearance(storageOf(), change);
        setAppearance((current) => ({ ...current, ...change }));
        window.dispatchEvent(new Event(appearanceEvent));
      },
    }),
    [controller],
  );
  const known = useMemo(() => new Map(page.tickets.open.map((ticket) => [ticket.id, ticket])), [page.tickets.open]);

  const model = page.current?.turns.at(-1)?.model ?? null;

  return (
    <Shell
      route={route}
      ticketFrom={origin}
      navigate={navigate}
      destinationOf={destinationOf}
      hrefOf={hrefOf}
      status={page.status}
      linked={page.linked}
      model={model}
      fill={inConversation}
      subtitle={route.view === "settings" && "section" in route ? text(`settings.section.${route.section}`) : null}
      toast={toast}
      waiting={page.waiting.cards.length}
      suggestions={page.memory.suggestions.length}
      reviews={reviewCount(page.tickets)}
      actions={
        inConversation ? (
          <button className="btn btn-sm" type="button" disabled={creatingTopic} onClick={() => void newTopic()}>
            <Icon name="plus" />
            {text("conversation.new")}
          </button>
        ) : route.view === "memory" ? (
          <button className="btn btn-sm" type="button" onClick={openAdding}>
            <Icon name="plus" />
            {text("memory.new")}
          </button>
        ) : null
      }
    >
      {inConversation ? (
        <ConversationView
          state={page.current?.id === conversationId ? page.current : null}
          stream={inStream ? page.stream : null}
          list={page.list}
          status={page.status}
          linked={page.linked}
          model={model}
          hrefOf={conversationHref}
          open={openConversation}
          send={send}
          stop={stop}
          loadOlder={() => controller.loadOlderStream()}
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
          tickets={page.tickets}
          ticketHref={ticketHref}
          openTicket={openTicket}
          now={now}
        />
      ) : route.view === "history" ? (
        <HistoryView
          history={page.history}
          ticketHref={ticketHref}
          openTicket={openFromHistory}
          search={searchHistory}
          more={moreHistory}
          retry={retryHistory}
          scroll={historyScroll.current}
          scrolled={historyScrolled}
          now={now}
        />
      ) : route.view === "memory" ? (
        <MemoryView memory={page.memory} actions={memoryActions} adding={addingMemory} closeAdding={closeAdding} now={now} />
      ) : route.view === "ticket" ? (
        <TicketView detail={page.detail} known={known} actions={ticketActions} origin={origin} backHref={pagePath({ view: origin })} back={backFromTicket} ticketHref={ticketHref} openTicket={openLinked} now={now} />
      ) : route.view === "settings" ? (
        <SettingsView
          section={"section" in route ? route.section : null}
          settings={page.settings}
          tickets={page.tickets.open}
          appearance={appearance}
          actions={settingsActions}
          navigate={navigate}
          now={now}
        />
      ) : (
        <div className="page" />
      )}
    </Shell>
  );
}
