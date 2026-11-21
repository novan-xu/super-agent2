import {
  type ReviewedStreamDestination,
  type StreamPreviewRequest,
  type ChoiceChange,
  type ConversationResponse,
  type Conversation,
  type DecisionReview,
  type EngineTable,
  type GitHubAccount,
  type MachineAdded,
  type MachineChoice,
  machineChoices,
  type MachineRevoked,
  type MachineSystem,
  type StorageSettings,
  type MemoryList,
  type Provider,
  type StoredWorkEvent,
  type StuckAnswer,
  type TopicMove,
  type TopicScope,
  topicInScope,
} from "@super-agent2/protocol";
import { startedWith } from "../live/chains.js";
import { resumeAfter } from "../live/conversation.js";
import { needsMoves } from "../live/detail.js";
import { canLoadMore, needsCatchUp } from "../live/history.js";
import { createPageStore, type PageStore } from "../live/page.js";
import { topicScopeKey } from "../live/topic-scope.js";
import { resumeStream } from "../live/topic-stream.js";
import { lastEventId } from "../live/work.js";
import { canAnswer, canStart, cardOf, type Verdict } from "../live/waiting.js";
import type { Answer, Failure, HubApi } from "./api.js";
import { HubSocket, type HubSocketOptions } from "./socket.js";

export interface ControllerOptions {
  readonly api: HubApi;
  readonly socket: Pick<HubSocketOptions, "url" | "create" | "schedule">;
  readonly onFailure: (failure: Failure) => void;
  readonly frame?: (run: () => void) => void;
  readonly sendLimit?: number;
}

export const defaultSendLimit = 20_000;

export class PageController {
  readonly store: PageStore = createPageStore();
  private readonly socket: HubSocket;
  private opened: string | null = null;
  private scope: TopicScope | undefined;
  private openedTicket: number | null = null;
  private pendingWork: StoredWorkEvent[] = [];
  private flushing = false;

  constructor(private readonly options: ControllerOptions) {
    this.socket = new HubSocket({
      ...options.socket,
      topicSnapshots: true,
      streamRevision: () => this.store.getState().stream.revision,
      resume: (conversation) => {
        const current = this.store.getState().current;
        return current?.id === conversation ? resumeAfter(current) : 0;
      },
      resumeStream: () => resumeStream(this.store.getState().stream),
      resumeTicket: (ticket) => {
        const detail = this.store.getState().detail;
        return detail?.id === ticket ? lastEventId(detail.log) : 0;
      },
      onMessage: (message) => {
        if (message.type === "transfer.changed") {
          if (typeof window !== "undefined") window.dispatchEvent(new Event("transfer.changed"));
          return;
        }
        if (message.type === "work") {
          this.queueWork(message.event);
          return;
        }
        const previous = this.store.getState();
        const before = previous.detail;
        this.store.dispatch({ type: "server", message });
        if (message.type === "topic.history" && this.store.getState().streaming) {
          this.socket.watchStream(true, this.scope, true);
        }
        if (message.type === "conversation") {
          this.recheckStream(previous.list, [message.conversation]);
        }
        if (message.type === "ticket" && before !== null && message.ticket.id === before.id && needsMoves(before, message.ticket)) {
          void this.readTicket(before.id);
        }
        if (message.type === "ticket" && needsCatchUp(this.store.getState().history, message.ticket)) {
          void this.refreshHistory();
        }
      },
      onStatus: (status) => this.store.dispatch({ type: "status", status }),
      onOpen: () => {
        if (typeof window !== "undefined") window.dispatchEvent(new Event("transfer.changed"));
        void this.refresh();
      },
    });
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
  }

  reconnect(force: boolean): void {
    this.socket.reconnect(force);
  }

  open(conversation: string | null, stream = false, scope?: TopicScope): void {
    this.scope = scope;
    this.store.dispatch({ type: "stream.open", watching: stream, key: topicScopeKey(scope) });
    this.socket.watchStream(stream, scope);
    if (conversation === this.opened) {
      return;
    }
    this.opened = conversation;
    this.store.dispatch({ type: "open", conversation });
    this.socket.watch(conversation);
    if (conversation !== null) {
      void this.readDetail(conversation);
    }
  }

  private recheckStream(previous: readonly Conversation[], topics: readonly Conversation[]): void {
    const scope = this.scope;
    if (scope === undefined || !this.store.getState().streaming) {
      return;
    }
    const old = new Set(previous.filter((topic) => topicInScope(topic, scope)).map((topic) => topic.id));
    const seen = new Set(previous.map((topic) => topic.id));
    const streamed = new Set(this.store.getState().stream.entries.map(({ topic }) => topic.id));
    if (topics.some((topic) => seen.has(topic.id) ? old.has(topic.id) !== topicInScope(topic, scope)
      : streamed.has(topic.id) || topicInScope(topic, scope))) {
      this.store.dispatch({ type: "stream.open", watching: true, key: topicScopeKey(scope), restart: true });
      this.socket.watchStream(true, scope, true);
    }
  }

  loadOlderStream(): void {
    const { status, stream } = this.store.getState();
    if (status === "open" && !stream.loading && stream.before !== null) {
      this.store.dispatch({ type: "stream.more" });
      this.socket.readStream(stream.before);
    }
  }

  openTicket(ticket: number | null): Promise<void> {
    if (ticket === this.openedTicket) {
      return Promise.resolve();
    }
    this.openedTicket = ticket;
    this.pendingWork = [];
    this.socket.watchTicket(null);
    this.store.dispatch({ type: "ticket.open", ticket });
    return ticket === null ? Promise.resolve() : this.loadTicket(ticket);
  }

  async refresh(): Promise<void> {
    const { list: known, brain } = this.store.getState();
    const list = await this.options.api.conversations();
    if (list.ok) {
      const current = this.store.getState();
      const previous = current.list;
      this.store.dispatch({ type: "list", list: list.value, preserveBrain: current.brain !== brain, ...(list.value.repositories === undefined ? {} : { known }) });
      this.recheckStream(previous, this.store.getState().list);
    }
    if (this.opened !== null) {
      await this.readDetail(this.opened);
    }
    if (this.openedTicket !== null) {
      await this.readTicket(this.openedTicket);
      await this.catchUp(this.openedTicket);
    }
    if (this.store.getState().history.status !== "idle") {
      await this.refreshHistory();
    }
  }

  openHistory(): Promise<void> {
    const status = this.store.getState().history.status;
    return status === "idle" || status === "failed" ? this.loadHistory() : Promise.resolve();
  }

  searchHistory(query: string): Promise<void> {
    const before = this.store.getState().history.applied;
    this.store.dispatch({ type: "history.query", query });
    return this.store.getState().history.applied === before ? Promise.resolve() : this.loadHistory();
  }

  async loadHistory(): Promise<void> {
    this.store.dispatch({ type: "history.loading" });
    const applied = this.store.getState().history.applied;
    const answer = await this.options.api.history({ query: applied, before: null });
    this.store.dispatch(answer.ok ? { type: "history.page", applied, page: answer.value } : { type: "history.failed", applied });
  }

  async moreHistory(): Promise<void> {
    const history = this.store.getState().history;
    const before = history.next;
    if (!canLoadMore(history) || before === null) {
      return;
    }
    this.store.dispatch({ type: "history.more.started" });
    const answer = await this.options.api.history({ query: history.applied, before });
    this.store.dispatch(
      answer.ok ? { type: "history.more", applied: history.applied, before, page: answer.value } : { type: "history.more.failed", applied: history.applied },
    );
  }

  private async refreshHistory(): Promise<void> {
    const applied = this.store.getState().history.applied;
    const answer = await this.options.api.history({ query: applied, before: null });
    if (answer.ok) {
      this.store.dispatch({ type: "history.page", applied, page: answer.value });
    }
  }

  private async memoryCall(run: () => Promise<Answer<MemoryList>>): Promise<boolean> {
    const answer = await run();
    if (!answer.ok) {
      this.options.onFailure(answer.error);
      return false;
    }
    return true;
  }

  addMemory(text: string): Promise<boolean> {
    return this.memoryCall(() => this.options.api.addMemory(text));
  }

  editMemory(id: number, text: string): Promise<boolean> {
    return this.memoryCall(() => this.options.api.editMemory(id, text));
  }

  deleteMemory(id: number): Promise<boolean> {
    return this.memoryCall(() => this.options.api.deleteMemory(id));
  }

  decideSuggestion(id: number, decision: "confirm" | "decline"): Promise<boolean> {
    return this.memoryCall(() => this.options.api.decideSuggestion(id, decision));
  }

  async refreshAllowance(): Promise<void> {
    const answer = await this.options.api.refreshAllowance();
    if (!answer.ok) this.options.onFailure(answer.error);
  }

  async loadSettings(): Promise<void> {
    const before = this.store.getState().settings;
    const answer = await this.options.api.settings();
    if (answer.ok && this.store.getState().settings === before) {
      this.store.dispatch({ type: "settings", settings: answer.value });
    }
  }

  async addMachine(name: string, system: MachineSystem): Promise<MachineAdded | { readonly refused: string } | undefined> {
    const answer = await this.options.api.addMachine(name, system);
    if (!answer.ok) {
      if (answer.error === "cloudflare_refused" && answer.reason !== undefined) {
        return { refused: answer.reason };
      }
      this.options.onFailure(answer.error);
      return undefined;
    }
    void this.loadSettings();
    return answer.value;
  }

  async revokeMachine(name: string): Promise<MachineRevoked | undefined> {
    const answer = await this.options.api.revokeMachine(name);
    if (!answer.ok) {
      this.options.onFailure(answer.error);
      return undefined;
    }
    void this.loadSettings();
    return answer.value;
  }

  async setMachineStorage(name: string, storage: StorageSettings): Promise<boolean> {
    const answer = await this.options.api.setMachineStorage(name, storage);
    if (!answer.ok) {
      this.options.onFailure(answer.error);
      return false;
    }
    await this.loadSettings();
    return true;
  }

  setOrder(order: readonly Provider[]): Promise<boolean> {
    return this.changeSettings(() => this.options.api.setOrder(order));
  }

  setAccount(repository: string, account: GitHubAccount): Promise<boolean> {
    return this.changeSettings(() => this.options.api.setAccount(repository, account));
  }

  setAlias(repository: string, alias: string | null): Promise<boolean> {
    return this.changeSettings(() => this.options.api.setAlias(repository, alias));
  }

  setPinned(repository: string, pinned: boolean): Promise<boolean> {
    return this.changeSettings(() => this.options.api.setPinned(repository, pinned));
  }

  private async changeSettings(update: HubApi["settings"]): Promise<boolean> {
    const before = this.store.getState().settings;
    const answer = await update();
    if (!answer.ok) {
      this.options.onFailure(answer.error);
      return false;
    }
    if (this.store.getState().settings === before) {
      this.store.dispatch({ type: "settings", settings: answer.value });
    }
    return true;
  }

  async setTable(table: EngineTable): Promise<"saved" | "unsupported" | "failed"> {
    const answer = await this.options.api.setTable(table);
    if (!answer.ok) {
      if (answer.error === "unsupported") {
        return "unsupported";
      }
      this.options.onFailure(answer.error);
      return "failed";
    }
    void this.loadSettings();
    return "saved";
  }

  async messageTicket(ticket: number, text: string, attachments: readonly string[] = []): Promise<boolean> {
    const sent = await this.options.api.messageWorker(ticket, text, attachments);
    if (!sent.ok) {
      this.options.onFailure(sent.error);
      return false;
    }
    return true;
  }

  async stopTicket(ticket: number): Promise<boolean> {
    const stopped = await this.options.api.stopTicket(ticket);
    if (!stopped.ok) {
      this.options.onFailure(stopped.error);
      return false;
    }
    this.store.dispatch({ type: "server", message: { type: "ticket", ticket: stopped.value.ticket } });
    void this.readTicket(ticket);
    return true;
  }

  async reviewDecision(ticket: number, decision: number, review: DecisionReview): Promise<boolean> {
    const reviewed = await this.options.api.reviewDecision(ticket, decision, review);
    if (!reviewed.ok) {
      this.options.onFailure(reviewed.error);
      return false;
    }
    this.store.dispatch({ type: "server", message: { type: "ticket", ticket: reviewed.value.ticket } });
    return true;
  }

  async reassignTicket(ticket: number, change: ChoiceChange): Promise<boolean> {
    const answer = await this.options.api.reassign(ticket, change);
    if (!answer.ok) {
      this.options.onFailure(answer.error);
      return false;
    }
    for (const changed of answer.value.tickets) {
      this.store.dispatch({ type: "server", message: { type: "ticket", ticket: changed } });
    }
    void this.readTicket(ticket);
    return true;
  }

  async machines(): Promise<MachineChoice[] | undefined> {
    const answer = await this.options.api.machines();
    if (!answer.ok) {
      this.options.onFailure(answer.error);
      return undefined;
    }
    return machineChoices(answer.value.machines);
  }

  private queueWork(event: StoredWorkEvent): void {
    if (this.options.frame === undefined) {
      this.store.dispatch({ type: "ticket.work", events: [event] });
      return;
    }
    this.pendingWork.push(event);
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    this.options.frame(() => {
      this.flushing = false;
      const events = this.pendingWork;
      this.pendingWork = [];
      if (events.length > 0) {
        this.store.dispatch({ type: "ticket.work", events });
      }
    });
  }

  private async loadTicket(ticket: number): Promise<void> {
    await this.readTicket(ticket);
    await this.catchUp(ticket);
    if (this.openedTicket === ticket) {
      this.socket.watchTicket(ticket);
    }
  }

  private async readTicket(ticket: number): Promise<void> {
    const detail = await this.options.api.ticket(ticket);
    if (this.openedTicket !== ticket) {
      return;
    }
    if (detail.ok) {
      this.store.dispatch({ type: "ticket.detail", detail: detail.value });
    } else if (detail.error === "not_found") {
      this.store.dispatch({ type: "ticket.missing", ticket });
    }
  }

  private async catchUp(ticket: number): Promise<void> {
    for (;;) {
      const detail = this.store.getState().detail;
      if (this.openedTicket !== ticket || detail?.id !== ticket) {
        return;
      }
      const page = await this.options.api.work(ticket, lastEventId(detail.log));
      if (!page.ok || page.value.events.length === 0 || this.openedTicket !== ticket) {
        return;
      }
      const before = lastEventId(detail.log);
      this.store.dispatch({ type: "ticket.work", events: page.value.events });
      const after = this.store.getState().detail;
      if (after === null || lastEventId(after.log) === before) {
        return;
      }
    }
  }

  async previewStream(request: StreamPreviewRequest, signal?: AbortSignal) {
    const preview = await this.options.api.previewStream(request, signal);
    return preview.ok ? preview.value : undefined;
  }

  private async limited<T>(run: (signal: AbortSignal) => Promise<Answer<T>>): Promise<Answer<T>> {
    const abort = new AbortController();
    const cancel = this.options.socket.schedule(() => abort.abort(), this.options.sendLimit ?? defaultSendLimit);
    const answer = await Promise.race([
      run(abort.signal),
      new Promise<Answer<T>>((resolve) => abort.signal.addEventListener("abort", () => resolve({ ok: false, error: "timeout" }), { once: true })),
    ]);
    cancel();
    return answer;
  }

  async send(text: string, attachments: readonly string[] = [], quotedMessage?: string, conversation = this.opened, scope = this.scope, destination?: ReviewedStreamDestination, id?: string): Promise<boolean | "stale"> {
    if (conversation === null) {
      const sent = await this.limited((signal) => this.options.api.sendToStream(text, attachments, quotedMessage, scope, destination, { id, signal }));
      if (!sent.ok) {
        this.options.onFailure(sent.error);
        if (sent.error === "not_found" && destination?.topic !== undefined) return "stale";
      }
      return sent.ok;
    }
    const sent = await this.limited((signal) => this.options.api.send(conversation, text, attachments, quotedMessage, { id, signal }));
    if (!sent.ok) {
      this.options.onFailure(sent.error);
      return false;
    }
    this.store.dispatch({ type: "own", entry: sent.value.entry });
    return true;
  }

  renameTopic(source: string, title: string): Promise<boolean> {
    return this.editTopic(() => this.options.api.renameTopic(source, title));
  }

  archiveTopic(source: string): Promise<boolean> {
    return this.editTopic(() => this.options.api.archiveTopic(source));
  }

  mergeTopic(source: string, destination: string): Promise<boolean> {
    return this.editTopic(() => this.options.api.mergeTopic(source, destination));
  }

  moveMessage(source: string, message: string, destination: TopicMove["destination"]): Promise<boolean> {
    return this.editTopic(() => this.options.api.moveMessage(source, message, destination));
  }

  private async editTopic(run: () => Promise<Answer<ConversationResponse>>): Promise<boolean> {
    const answer = await run();
    if (!answer.ok) {
      this.options.onFailure(answer.error);
    }
    return answer.ok;
  }

  async interrupt(): Promise<void> {
    if (this.opened === null) {
      return;
    }
    const answer = await this.options.api.interrupt(this.opened);
    if (!answer.ok) {
      this.options.onFailure(answer.error);
    }
  }

  async answer(key: string, verdict: Verdict): Promise<boolean> {
    const waiting = this.store.getState().waiting;
    const card = cardOf(waiting, key);
    if (card === undefined || card.kind !== "hold" || !canAnswer(waiting, key)) {
      return false;
    }
    this.store.dispatch({ type: "waiting", action: { type: "sending", key, verdict } });
    const send = verdict === "release" ? this.options.api.release : this.options.api.refuse;
    const answer = await send(card.command.id, card.hold.fingerprint);
    if (!answer.ok) {
      this.store.dispatch({ type: "waiting", action: { type: "failed", key, failure: answer.error } });
      return false;
    }
    this.store.dispatch({ type: "waiting", action: { type: "answered", key } });
    return true;
  }

  async answerStuck(key: string, verdict: StuckAnswer, words: string): Promise<boolean> {
    const waiting = this.store.getState().waiting;
    const card = cardOf(waiting, key);
    const at = card?.kind === "stuck" ? card.ticket.stuck?.at : undefined;
    if (card === undefined || card.kind !== "stuck" || at === undefined || !canAnswer(waiting, key)) {
      return false;
    }
    this.store.dispatch({ type: "waiting", action: { type: "sending", key, verdict } });
    const trimmed = words.trim();
    const answer = await this.options.api.answerStuck(card.ticket.id, { at, answer: verdict, ...(trimmed === "" ? {} : { words: trimmed }) });
    if (!answer.ok) {
      this.store.dispatch({ type: "waiting", action: { type: "failed", key, failure: answer.error } });
      return false;
    }
    this.store.dispatch({ type: "waiting", action: { type: "answered", key } });
    return true;
  }

  async startChains(keys: readonly string[]): Promise<boolean> {
    const waiting = this.store.getState().waiting;
    if (!canStart(waiting, keys)) {
      return false;
    }
    const cards = startedWith(waiting.cards, keys);
    this.store.dispatch({ type: "waiting", action: { type: "starting", keys } });
    const answer = await this.options.api.startChains(cards.map((card) => ({ ticket: card.ticket.id, fingerprint: card.fingerprint })));
    if (!answer.ok) {
      for (const key of keys) {
        this.store.dispatch({ type: "waiting", action: { type: "failed", key, failure: answer.error } });
      }
      return false;
    }
    for (const key of keys) {
      this.store.dispatch({ type: "waiting", action: { type: "answered", key } });
    }
    return true;
  }

  async chooseChain(key: string, change: ChoiceChange): Promise<boolean> {
    const card = cardOf(this.store.getState().waiting, key);
    if (card === undefined || card.kind !== "start") {
      return false;
    }
    this.store.dispatch({ type: "waiting", action: { type: "choosing", key } });
    const answer = await this.options.api.chooseChain(card.ticket.id, change);
    if (!answer.ok) {
      this.store.dispatch({ type: "waiting", action: { type: "failed", key, failure: answer.error } });
      return false;
    }
    this.store.dispatch({ type: "waiting", action: { type: "chosen", key } });
    return true;
  }

  private async readDetail(conversation: string): Promise<void> {
    const detail = await this.options.api.detail(conversation);
    if (detail.ok && this.opened === conversation) {
      this.store.dispatch({ type: "detail", detail: detail.value, requested: conversation });
    }
  }
}
