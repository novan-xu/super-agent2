import { startedWith } from "../live/chains.js";
import { resumeAfter } from "../live/conversation.js";
import { createPageStore, type PageStore } from "../live/page.js";
import { canAnswer, canStart, cardOf, type Verdict } from "../live/waiting.js";
import type { Failure, HubApi } from "./api.js";
import { HubSocket, type HubSocketOptions } from "./socket.js";

export interface ControllerOptions {
  readonly api: HubApi;
  readonly socket: Pick<HubSocketOptions, "url" | "create" | "schedule">;
  readonly onFailure: (failure: Failure) => void;
}

export class PageController {
  readonly store: PageStore = createPageStore();
  private readonly socket: HubSocket;
  private opened: string | null = null;

  constructor(private readonly options: ControllerOptions) {
    this.socket = new HubSocket({
      ...options.socket,
      resume: (conversation) => {
        const current = this.store.getState().current;
        return current?.id === conversation ? resumeAfter(current) : 0;
      },
      onMessage: (message) => this.store.dispatch({ type: "server", message }),
      onStatus: (status) => this.store.dispatch({ type: "status", status }),
      onOpen: () => {
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

  open(conversation: string | null): void {
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

  async refresh(): Promise<void> {
    const list = await this.options.api.conversations();
    if (list.ok) {
      this.store.dispatch({ type: "list", list: list.value });
    }
    if (this.opened !== null) {
      await this.readDetail(this.opened);
    }
  }

  async send(text: string, onCreated: (conversation: string) => void): Promise<boolean> {
    let conversation = this.opened;
    if (conversation === null) {
      const created = await this.options.api.create();
      if (!created.ok) {
        this.options.onFailure(created.error);
        return false;
      }
      conversation = created.value.conversation.id;
      this.store.dispatch({ type: "created", conversation: created.value.conversation });
      onCreated(conversation);
      this.open(conversation);
    }
    const sent = await this.options.api.send(conversation, text);
    if (!sent.ok) {
      this.options.onFailure(sent.error);
      return false;
    }
    this.store.dispatch({ type: "own", entry: sent.value.entry });
    return true;
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

  arm(key: string): void {
    this.store.dispatch({ type: "waiting", action: { type: "arm", key } });
  }

  disarm(key: string): void {
    this.store.dispatch({ type: "waiting", action: { type: "disarm", key } });
  }

  async answer(key: string, verdict: Verdict): Promise<boolean> {
    const waiting = this.store.getState().waiting;
    const card = cardOf(waiting, key);
    if (card === undefined || card.kind !== "hold" || !canAnswer(waiting, key, verdict)) {
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

  private async readDetail(conversation: string): Promise<void> {
    const detail = await this.options.api.detail(conversation);
    if (detail.ok) {
      this.store.dispatch({ type: "detail", detail: detail.value });
    }
  }
}
