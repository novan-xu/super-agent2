import { text } from "@super-agent2/catalog";
import { cardParameter, type ChoiceChange, type PageRoute, type PageView, pagePath, type ReviewedStreamDestination, type StreamPreviewRequest, type StuckAnswer } from "@super-agent2/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Failure, hubApi } from "./hub/api.js";
import { PageController } from "./hub/controller.js";
import { browserPush } from "./hub/browser-push.js";
import { PushController } from "./hub/push.js";
import { browserSocket } from "./hub/socket.js";
import { destinationOfMessage } from "./live/address.js";
import { initialPage } from "./live/page.js";
import { conversationRepositories, scopeOfTopic, topicScopeKey, workbenchScope } from "./live/topic-scope.js";
import { initialPushFacts, pushPhase } from "./live/push.js";
import type { Verdict } from "./live/waiting.js";
import { Icon } from "./parts/icons.js";
import { AllowanceSidebar } from "./parts/Allowance.js";
import { useRoute } from "./parts/route.js";
import { Shell } from "./parts/Shell.js";
import { failureText } from "./views/HoldCard.js";
import { ConversationView } from "./views/ConversationView.js";
import { TransferView } from "./views/TransferView.js";
import { ConversationTabs } from "./views/ConversationTabs.js";
import type { TopicActions } from "./views/TopicActions.js";
import { HistoryView } from "./views/HistoryView.js";
import { type MemoryActions, MemoryView } from "./views/MemoryView.js";
import { type TicketActions, type TicketOrigin, TicketView } from "./views/TicketView.js";
import { CanvasWorkbench } from "./views/CanvasWorkbench.js";
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

  const [workRepository, setWorkRepository] = useState<string | null | undefined>(undefined);
  const [workTopic, setWorkTopic] = useState<string | null>(null);
  const [rearranging, setRearranging] = useState(false);
  const rearrangeInFlight = useRef(false);
  const [workTicket, setWorkTicket] = useState<number | null>(null);
  const pinnedRepositories = useMemo(() => page.settings?.repositories.filter((row) => row.pinned).map((row) => row.repository) ?? [], [page.settings?.repositories]);
  const selectWorkRepository = useCallback((repository: string | null | undefined) => { setWorkRepository(repository); setWorkTopic(null); }, []);
  useEffect(() => {
    if (typeof workRepository !== "string" || page.settings === null) return;
    const current = pinnedRepositories.find((name) => name.toLowerCase() === workRepository.toLowerCase());
    if (current !== workRepository) selectWorkRepository(current);
  }, [page.settings, pinnedRepositories, selectWorkRepository, workRepository]);
  const workScope = useMemo(() => workbenchScope(workRepository), [workRepository]);
  const inWorkbench = route.view === "workbench";
  const conversationId = inWorkbench ? workTopic : route.view === "conversations" ? route.conversation : null;
  const inConversation = route.view === "conversations" || route.view === "home";
  const inTransfer = route.view === "transfer";
  const inStream = (inConversation || inWorkbench) && conversationId === null;
  const currentTopic = page.current?.id === conversationId ? page.current : null;
  const selectedTopic = currentTopic?.conversation ?? page.list.find((topic) => topic.id === conversationId);
  const preferredScope = inWorkbench ? workScope : route.view === "conversations" ? route.scope : undefined;
  const scope = useMemo(() => scopeOfTopic(selectedTopic, preferredScope), [selectedTopic, preferredScope]);
  const streamRoute = useMemo<PageRoute>(() => ({ view: "conversations", conversation: null, scope }), [scope]);
  const repositories = useMemo(
    () => conversationRepositories(page.repositories, [...page.tickets.open, ...page.list], scope),
    [page.repositories, page.tickets.open, page.list, scope],
  );
  const ticketId = inWorkbench ? workTicket : route.view === "ticket" ? route.ticket : null;

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

  const inRepositories = route.view === "settings" && "section" in route && route.section === "repositories";
  useEffect(() => {
    if (inRepositories && page.status === "open") void hubApi.refreshRepositories();
  }, [inRepositories, page.status]);

  useEffect(() => {
    if (route.view === "history") {
      void controller.openHistory();
    }
  }, [controller, route.view]);

  useEffect(() => {
    controller.open(conversationId, inStream, scope);
  }, [controller, conversationId, inStream, scope]);

  useEffect(() => {
    const redirect = page.topicRedirect;
    if (redirect !== null && redirect.from === conversationId) {
      if (inWorkbench) setWorkTopic(redirect.to.id);
      else navigate({ view: "conversations", conversation: redirect.to.id, scope: scopeOfTopic(redirect.to, preferredScope) }, true);
    }
  }, [conversationId, inWorkbench, navigate, page.topicRedirect, preferredScope]);

  const topicActions = useMemo<TopicActions>(() => ({
    rename: (source: string, title: string) => controller.renameTopic(source, title),
    archive: (source: string) => controller.archiveTopic(source),
    merge: (source: string, destination: string) => controller.mergeTopic(source, destination),
    move: (source, message, destination) => controller.moveMessage(source, message, destination),
  }), [controller]);

  const destinationOf = useCallback(
    (view: PageView): PageRoute => (view === "conversations" ? { view, conversation: null } : { view }),
    [],
  );
  const hrefOf = useCallback((view: PageView) => pagePath(destinationOf(view)), [destinationOf]);
  const topicRoute = useCallback((conversation: string): PageRoute => ({
    view: "conversations", conversation, scope: scopeOfTopic(page.list.find((topic) => topic.id === conversation), scope),
  }), [page.list, scope]);
  const conversationHref = useCallback((conversation: string) => pagePath(topicRoute(conversation)), [topicRoute]);
  const openConversation = useCallback((conversation: string) => { if (inWorkbench) setWorkTopic(conversation); else navigate(topicRoute(conversation)); }, [inWorkbench, navigate, topicRoute]);
  const openStream = useCallback(() => { if (inWorkbench) setWorkTopic(null); else navigate(streamRoute); }, [inWorkbench, navigate, streamRoute]);
  const send = useCallback(
    (message: string, attachments: readonly string[] = [], quotedMessage?: string, destination?: ReviewedStreamDestination) =>
      controller.send(message, attachments, quotedMessage, conversationId, scope, destination),
    [controller, conversationId, scope],
  );
  const previewStream = useCallback((request: StreamPreviewRequest) => controller.previewStream(request), [controller]);
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
  const rearrange = useCallback(async () => {
    if (rearrangeInFlight.current) return false;
    rearrangeInFlight.current = true;
    setRearranging(true);
    try {
      const result = await hubApi.rearrange(workRepository);
      if (!result.ok) {
        setToast(text("workbench.rearrangeFailed"));
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), toastDuration);
        return false;
      }
      setWorkRepository(workRepository);
      setWorkTicket(null);
      setWorkTopic(result.value.conversation.id);
      return true;
    } finally {
      rearrangeInFlight.current = false;
      setRearranging(false);
    }
  }, [workRepository]);
  const togglePush = useCallback(() => void pushController.toggle(), [pushController]);
  const ticketHref = useCallback((ticket: number) => pagePath({ view: "ticket", ticket }), []);
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
      setMachineStorage: (name, storage) => controller.setMachineStorage(name, storage),
      setOrder: (order) => controller.setOrder(order),
      setAccount: (repository, account) => controller.setAccount(repository, account),
      setPinned: (repository, pinned) => controller.setPinned(repository, pinned),
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
  const conversationTabs = <ConversationTabs scope={scope} transfer={inTransfer} repositories={repositories} navigate={navigate} />;

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
      fill={inConversation || inTransfer || inWorkbench}
      subtitle={route.view === "settings" && "section" in route ? text(`settings.section.${route.section}`) : null}
      toast={toast}
      waiting={page.waiting.cards.length}
      suggestions={page.memory.suggestions.length}
      allowance={<AllowanceSidebar report={page.allowance} now={now} refresh={() => void controller.refreshAllowance()} />}
      actions={
        route.view === "memory" ? (
          <button className="btn btn-sm" type="button" onClick={openAdding}>
            <Icon name="plus" />
            {text("memory.new")}
          </button>
        ) : null
      }
    >
      {inConversation ? (
        <ConversationView
          conversation={conversationId}
          scope={scope}
          state={currentTopic}
          stream={inStream && page.streamKey === topicScopeKey(scope) ? page.stream : null}
          list={page.list}
          status={page.status}
          linked={page.linked}
          model={model}
          hrefOf={conversationHref}
          open={openConversation}
          streamHref={pagePath(streamRoute)}
          openStream={openStream}
          navigation={conversationTabs}
          send={send}
          previewStream={previewStream}
          stop={stop}
          topicActions={topicActions}
          loadOlder={() => controller.loadOlderStream()}
          now={now}
        />
      ) : inTransfer ? (
        <TransferView navigation={conversationTabs} />
      ) : route.view === "workbench" ? (
        <CanvasWorkbench
          tickets={page.tickets.open}
          topics={page.list}
          pinnedRepositories={pinnedRepositories}
          waiting={page.waiting}
          actions={cardActions}
          repository={workRepository}
          selectRepository={selectWorkRepository}
          selected={workTicket}
          selectTicket={setWorkTicket}
          ticketHref={ticketHref}
          focus={focus}
          focused={clearFocus}
          push={pushPhase(pushFacts)}
          togglePush={togglePush}
          rearrange={rearrange}
          rearranging={rearranging}
          panel={workTicket === null ? <ConversationView
            compact conversation={conversationId} scope={scope} state={currentTopic}
            stream={inStream && page.streamKey === topicScopeKey(scope) ? page.stream : null}
            list={page.list} status={page.status} linked={page.linked} model={model}
            hrefOf={conversationHref} open={openConversation} streamHref={pagePath(streamRoute)} openStream={openStream}
            send={send} previewStream={previewStream} stop={stop} topicActions={topicActions} loadOlder={() => controller.loadOlderStream()} now={now}
          /> : <TicketView detail={page.detail} known={known} actions={ticketActions} origin="workbench"
            backHref={pagePath({ view: "workbench" })} back={() => setWorkTicket(null)} ticketHref={ticketHref}
            openTicket={setWorkTicket} now={now} />}
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
