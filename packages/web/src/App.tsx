import { text } from "@super-agent2/catalog";
import { cardParameter, type ChoiceChange, type PageRoute, type PageView, type ReviewedStreamDestination, type StreamPreviewRequest, type StuckAnswer } from "@super-agent2/protocol";
import { appPath, pagePath, remoteName } from "./parts/app-path.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Failure, hubApi } from "./hub/api.js";
import { PageController } from "./hub/controller.js";
import { browserPush } from "./hub/browser-push.js";
import { PushController } from "./hub/push.js";
import { browserSocket } from "./hub/socket.js";
import { destinationOfMessage } from "./live/address.js";
import { emptyFeatures, FeatureContext, featureEnabled, transferEnabled } from "./live/features.js";
import { initialPage } from "./live/page.js";
import { conversationRepositories, scopeOfTopic, topicScopeKey, workbenchScope } from "./live/topic-scope.js";
import { initialPushFacts, pushPhase } from "./live/push.js";
import type { Verdict } from "./live/waiting.js";
import { Icon } from "./parts/icons.js";
import { AllowanceSidebar, AllowanceRings } from "./parts/Allowance.js";
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
import { RepositoryTabs } from "./views/RepositoryTabs.js";
import { CanvasWorkbench } from "./views/CanvasWorkbench.js";
import { type SettingsActions, settingsSectionEnabled, SettingsView } from "./views/SettingsView.js";
import { RemoteView } from "./views/RemoteView.js";
import { SchedulesView } from "./views/SchedulesView.js";
import { type Appearance, appearanceEvent, readAppearance, writeAppearance, themeKey, accentKey } from "./live/appearance.js";

const toastDuration = 4000;

const workFlushDelay = 40;

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${appPath("/ws")}`;
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
  const peer = remoteName();
  const reportedFeatures = page.settings === null ? emptyFeatures : page.settings.features;
  const features = peer === undefined || reportedFeatures === undefined ? reportedFeatures
    : { ...reportedFeatures, enabled: reportedFeatures.enabled.filter((feature) => feature !== "push") };
  const pushEnabled = featureEnabled(features, "push");
  const canTransfer = transferEnabled(features);

  const [pushController] = useState(() => new PushController({ api: hubApi, browser: browserPush(), onFailure: (failure) => showFailure(failure) }));
  const pushFacts = useSyncExternalStore(pushController.store.subscribe, pushController.store.getState, () => initialPushFacts);
  const [focus, setFocus] = useState<string | null>(() => new URLSearchParams(window.location.search).get(cardParameter));
  const clearFocus = useCallback(() => setFocus(null), []);

  useEffect(() => {
    if (page.status === "open" && pushEnabled) {
      void pushController.start();
    }
  }, [page.status, pushController, pushEnabled]);

  useEffect(() => {
    if (peer !== undefined || !("serviceWorker" in navigator)) {
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
  }, [navigate, peer]);

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
  const [workPane, setWorkPane] = useState<"canvas" | "panel">("canvas");
  const [workTicket, setWorkTicket] = useState<number | null>(null);
  const pinnedRepositories = useMemo(() => page.settings?.repositories.filter((row) => row.pinned).map(({ repository, alias }) => ({ repository, alias })) ?? [], [page.settings?.repositories]);
  const selectWorkRepository = useCallback((repository: string | null | undefined) => { setWorkRepository(repository); setWorkTopic(null); }, []);
  useEffect(() => {
    if (typeof workRepository !== "string" || page.settings === null) return;
    const current = pinnedRepositories.find((row) => row.repository.toLowerCase() === workRepository.toLowerCase())?.repository;
    if (current !== workRepository) selectWorkRepository(current);
  }, [page.settings, pinnedRepositories, selectWorkRepository, workRepository]);
  const workScope = useMemo(() => workbenchScope(workRepository), [workRepository]);
  const inWorkbench = route.view === "workbench";
  const conversationId = inWorkbench ? workTopic : route.view === "conversations" ? route.conversation : null;
  const inConversation = route.view === "conversations" || route.view === "home";
  const inTransfer = route.view === "transfer";
  useEffect(() => {
    if (inTransfer && page.settings !== null && !canTransfer) {
      navigate({ view: "conversations", conversation: null }, true);
    }
  }, [inTransfer, page.settings, canTransfer, navigate]);
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
    if ((route.view === "settings" || route.view === "workbench") && page.settings === null && page.status === "open") {
      void controller.loadSettings();
    }
  }, [controller, route.view, page.settings, page.status]);

  const inRepositories = route.view === "settings" && "section" in route && route.section === "repositories";
  const section = route.view === "settings" && "section" in route ? route.section : null;
  useEffect(() => {
    if (page.settings !== null && section !== null && !settingsSectionEnabled(section, page.settings)) {
      navigate({ view: "settings" }, true);
    }
  }, [navigate, page.settings, section]);
  useEffect(() => {
    if (inRepositories && page.status === "open") void hubApi.refreshRepositories();
  }, [inRepositories, page.status]);

  const inHistory = route.view === "settings" && "section" in route && route.section === "history";
  useEffect(() => {
    if (inHistory) void controller.openHistory();
  }, [controller, inHistory]);

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
    undoMerge: (source: string, destination: string) => controller.undoTopicMerge(source, destination),
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
    (message: string, attachments: readonly string[] = [], quotedMessage?: string, destination?: ReviewedStreamDestination, id?: string) =>
      controller.send(message, attachments, quotedMessage, conversationId, scope, destination, id),
    [controller, conversationId, scope],
  );
  const previewStream = useCallback((request: StreamPreviewRequest, signal?: AbortSignal) => controller.previewStream(request, signal), [controller]);
  const stop = useCallback(() => void controller.interrupt(), [controller]);
  const cardActions = useMemo(
    () => ({
      stop: (ticket: number) => controller.stopTicket(ticket),
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
  const fromSchedules = useCallback((destination: PageRoute, replace?: boolean) => {
    if (destination.view === "ticket") setOrigin("schedules");
    navigate(destination, replace);
  }, [navigate]);
  const backRoute: PageRoute = origin === "history" ? { view: "settings", section: "history" } : { view: origin };
  const backFromTicket = useCallback(() => navigate(backRoute), [navigate, origin]);
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
      add: (words, scope) => controller.addMemory(words, scope),
      edit: (id, words, scope) => controller.editMemory(id, words, scope),
      remove: (id) => controller.deleteMemory(id),
      decide: (id, decision, scope) => controller.decideSuggestion(id, decision, scope),
    }),
    [controller],
  );
  const [addingMemory, setAddingMemory] = useState(false);
  const openAdding = useCallback(() => setAddingMemory(true), []);
  const closeAdding = useCallback(() => setAddingMemory(false), []);
  const settingsCounts = { memory: page.memory.suggestions.length };
  const settingsActions = useMemo<SettingsActions>(
    () => ({
      addMachine: (name, system) => controller.addMachine(name, system),
      revokeMachine: (name) => controller.revokeMachine(name),
      setMachineStorage: (name, storage) => controller.setMachineStorage(name, storage),
      setMachineLoad: (limits) => controller.setMachineLoad(limits),
      setOrder: (role, order) => controller.setOrder(role, order),
      setAccount: (repository, account) => controller.setAccount(repository, account),
      setPinned: (repository, pinned) => controller.setPinned(repository, pinned),
      setAlias: (repository, alias) => controller.setAlias(repository, alias),
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

  const { linked, model } = page.brain;
  const conversationTabs = <ConversationTabs scope={scope} transfer={inTransfer} repositories={repositories} navigate={navigate} />;

  return (
    <FeatureContext.Provider value={features}>
    <Shell
      route={route}
      ticketFrom={origin}
      navigate={navigate}
      destinationOf={destinationOf}
      hrefOf={hrefOf}
      status={page.status}
      linked={linked}
      model={model}
      fill={inConversation || inTransfer || inWorkbench}
      subtitle={section === null ? null : text(`settings.section.${section}`)}
      toast={toast}
      waiting={page.waiting.cards.length}
      settingsCount={Object.values(settingsCounts).reduce((sum, count) => sum + count, 0)}
      pendingSchedules={page.schedules?.pending ?? 0}
      hasPeers={Boolean(page.peers?.length)}
      allowance={<AllowanceSidebar report={page.allowance} now={now} />}
      collapsedAllowance={<AllowanceRings report={page.allowance} now={now} />}
      headerTabs={inWorkbench ? <RepositoryTabs repositories={page.settings?.repositories ?? []} tickets={page.tickets.open} topics={page.list} waiting={page.waiting} selected={workRepository} select={(repository) => { selectWorkRepository(repository); setWorkTicket(null); setWorkPane("canvas"); }} pin={(repository, pinned) => controller.setPinned(repository, pinned)} order={(repositories) => controller.setRepositoryOrder(repositories)} /> : undefined}
      actions={<>
        {peer === undefined ? null : <a className="btn btn-sm remote-return" href="/remote" aria-label={text("remote.back")}><Icon name="screen" /><span className="od-truncate">{peer}</span><span>{text("remote.back")}</span></a>}
        {section === "memory" ? (
          <button className="btn btn-sm" type="button" onClick={openAdding}>
            <Icon name="plus" />
            {text("memory.new")}
          </button>
        ) : null}
      </>}
    >
      {inConversation ? (
        <ConversationView
          waiting={page.waiting} tickets={page.tickets.open} stopTicket={cardActions.stop} startChains={(keys, fingerprints) => void controller.startChains(keys, fingerprints)}
          conversation={conversationId}
          focusEntry={route.view === "conversations" ? route.entry : undefined}
          scope={scope}
          state={currentTopic}
          stream={inStream && page.streamKey === topicScopeKey(scope) ? page.stream : null}
          list={page.list}
          status={page.status}
          linked={linked}
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
        canTransfer ? <TransferView navigation={conversationTabs} /> : null
      ) : route.view === "workbench" ? (
        <CanvasWorkbench
          tickets={page.tickets.open}
          pane={workPane}
          setPane={setWorkPane}
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
          push={pushEnabled ? pushPhase(pushFacts) : "hidden"}
          togglePush={togglePush}
          rearrange={rearrange}
          rearranging={rearranging}
          panel={workTicket === null ? <ConversationView
            waiting={page.waiting} tickets={page.tickets.open} stopTicket={cardActions.stop} startChains={(keys, fingerprints) => void controller.startChains(keys, fingerprints)}
            compact conversation={conversationId} scope={scope} state={currentTopic}
            stream={inStream && page.streamKey === topicScopeKey(scope) ? page.stream : null}
            list={page.list} status={page.status} linked={linked} model={model}
            hrefOf={conversationHref} open={openConversation} streamHref={pagePath(streamRoute)} openStream={openStream}
            send={send} previewStream={previewStream} stop={stop} topicActions={topicActions} loadOlder={() => controller.loadOlderStream()} now={now}
          /> : <TicketView detail={page.detail} known={known} actions={ticketActions} origin="workbench"
            backHref={pagePath({ view: "workbench" })} back={() => setWorkTicket(null)} ticketHref={ticketHref}
            openTicket={setWorkTicket} now={now} />}
        />
      ) : route.view === "remote" ? (
        <RemoteView peers={page.peers ?? []} online={page.status === "open"} />
      ) : route.view === "schedules" ? (
        <SchedulesView navigate={fromSchedules} update={page.schedules} focusedProposal={"proposal" in route ? route.proposal : undefined} />
      ) : route.view === "ticket" ? (
        <TicketView detail={page.detail} known={known} actions={ticketActions} origin={origin} backHref={pagePath(backRoute)} back={backFromTicket} ticketHref={ticketHref} openTicket={openLinked} now={now} />
      ) : route.view === "settings" ? (
        <SettingsView
          history={<HistoryView
          history={page.history}
          ticketHref={ticketHref}
          openTicket={openFromHistory}
          search={searchHistory}
          more={moreHistory}
          retry={retryHistory}
          scroll={historyScroll.current}
          scrolled={historyScrolled}
          now={now}
        />}
          memory={<MemoryView memory={page.memory} actions={memoryActions} adding={addingMemory} closeAdding={closeAdding} now={now} />}
          section={section}
          sectionCounts={settingsCounts}
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
    </FeatureContext.Provider>
  );
}
