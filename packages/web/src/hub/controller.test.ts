import type { CommandRecord, Conversation, OwnerEntry } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { Answer, Failure, HubApi } from "./api.js";
import { holdCard, startCard, ticket, workEvent } from "../live/fixtures.js";
import { useOf } from "../live/waiting.js";
import { PageController } from "./controller.js";
import type { SocketEvents } from "./socket.js";

const conversation: Conversation = { id: "c9", title: "", state: "idle", provider: null, createdAt: 1, updatedAt: 1 };
const entry: OwnerEntry = { id: "o1", conversation: "c9", seq: 1, at: 2, kind: "owner", text: "你好", taken: false };

function record(id: string): CommandRecord {
  const { command } = holdCard(id) as { command: CommandRecord };
  return { ...command, state: "running" };
}

function api(overrides: Partial<HubApi> = {}): HubApi & { readonly calls: string[] } {
  const calls: string[] = [];
  const answer = <T,>(name: string, value: T): Promise<Answer<T>> => {
    calls.push(name);
    return Promise.resolve({ ok: true, value });
  };
  return {
    calls,
    conversations: () => answer("conversations", { brain: { linked: true }, conversations: [] }),
    detail: (id) => answer(`detail ${id}`, { conversation, turns: [], entries: [] }),
    create: () => answer("create", { conversation }),
    send: (id, text) => answer(`send ${id} ${text}`, { entry }),
    interrupt: (id) => answer(`interrupt ${id}`, { conversation }),
    release: (id, fingerprint) => answer(`release ${id} ${fingerprint}`, { command: record(id) }),
    refuse: (id, fingerprint) => answer(`refuse ${id} ${fingerprint}`, { command: record(id) }),
    tickets: (scope) => answer(`tickets ${scope ?? "open"}`, { tickets: [] }),
    ticket: (id) => answer(`ticket ${id}`, { ticket: ticket(id), moves: [], attempts: [] }),
    work: (id, after) => answer(`work ${id} ${after}`, { events: [] }),
    messageWorker: (id, text) => answer(`message ${id} ${text}`, { id: "m1" }),
    stopTicket: (id) => answer(`stop ${id}`, { ticket: ticket(id, { state: "stopped", updatedAt: 99_000 }) }),
    machines: () => answer("machines", { machines: [] }),
    startChains: (chains) => answer(`start ${chains.map((chain) => `${chain.ticket}:${chain.fingerprint.slice(0, 1)}`).join(" ")}`, { tickets: [] }),
    chooseChain: (id, change) => answer(`choose ${id} ${JSON.stringify(change)}`, { tickets: [] }),
    reassign: (id, change) => answer(`reassign ${id} ${JSON.stringify(change)}`, { tickets: [] }),
    pushKey: () => answer("pushKey", { publicKey: null }),
    subscribePush: () => answer("subscribePush", { subscribed: true }),
    unsubscribePush: () => answer("unsubscribePush", { subscribed: false }),
    ...overrides,
  };
}

function controller(hub: HubApi, failures: Failure[] = []): PageController {
  return new PageController({
    api: hub,
    socket: { url: "ws://hub/ws", create: () => ({ isOpen: () => false, send: () => undefined, close: () => undefined }), schedule: () => () => undefined },
    onFailure: (failure) => failures.push(failure),
  });
}

describe("PageController", () => {
  it("opens a conversation for the first message of a new one", async () => {
    const hub = api();
    const page = controller(hub);
    const created: string[] = [];
    page.open(null);
    expect(await page.send("你好", (id) => created.push(id))).toBe(true);
    expect(created).toEqual(["c9"]);
    expect(hub.calls).toEqual(["create", "detail c9", "send c9 你好"]);
    expect(page.store.getState().list.map((item) => item.id)).toEqual(["c9"]);
    expect(page.store.getState().current?.entries).toEqual([entry]);
  });

  it("keeps the message when the hub refuses it, and says why", async () => {
    const failures: Failure[] = [];
    const page = controller(api({ send: () => Promise.resolve({ ok: false, error: "network" }) }), failures);
    page.open("c9");
    expect(await page.send("你好", () => undefined)).toBe(false);
    expect(failures).toEqual(["network"]);
    expect(page.store.getState().current?.entries).toEqual([]);
  });

  it("interrupts the conversation that is open", async () => {
    const hub = api();
    const page = controller(hub);
    await page.interrupt();
    page.open("c9");
    await page.interrupt();
    expect(hub.calls.filter((call) => call.startsWith("interrupt"))).toEqual(["interrupt c9"]);
  });

  describe("answering a held command", () => {
    const first = holdCard("a1");

    function shown(hub: HubApi, failures: Failure[] = []): PageController {
      const page = controller(hub, failures);
      page.store.dispatch({ type: "waiting", action: { type: "snapshot", cards: [first, holdCard("b2", { at: 2000 })] } });
      return page;
    }

    it("releases with the fingerprint the owner saw, only after the card was armed, and removes the card", async () => {
      const hub = api();
      const page = shown(hub);
      expect(await page.answer("hold:a1", "release")).toBe(false);
      expect(hub.calls).toEqual([]);
      page.arm("hold:a1");
      expect(await page.answer("hold:a1", "release")).toBe(true);
      expect(hub.calls).toEqual([`release a1 ${first.kind === "hold" ? first.hold.fingerprint : ""}`]);
      expect(page.store.getState().waiting.cards.map((card) => card.key)).toEqual(["hold:b2"]);
    });

    it("refuses with one press", async () => {
      const hub = api();
      const page = shown(hub);
      expect(await page.answer("hold:b2", "refuse")).toBe(true);
      expect(hub.calls).toHaveLength(1);
      expect(hub.calls[0]).toMatch(/^refuse b2 /);
      expect(page.store.getState().waiting.cards.map((card) => card.key)).toEqual(["hold:a1"]);
    });

    it("sends only one request however many times the button is pressed", async () => {
      let release: (value: Answer<{ command: CommandRecord }>) => void = () => undefined;
      let requests = 0;
      const hub = api({
        release: () =>
          new Promise((resolve) => {
            requests += 1;
            release = resolve;
          }),
      });
      const page = shown(hub);
      page.arm("hold:a1");
      const presses = [page.answer("hold:a1", "release"), page.answer("hold:a1", "release"), page.answer("hold:a1", "refuse")];
      expect(useOf(page.store.getState().waiting, "hold:a1").step).toBe("sending");
      release({ ok: true, value: { command: record("a1") } });
      expect(await Promise.all(presses)).toEqual([true, false, false]);
      expect(requests).toBe(1);
      expect(hub.calls).toEqual([]);
    });

    it("keeps the card and says why when the hub refuses, so the owner can try again", async () => {
      const failures: Failure[] = [];
      let refuse = true;
      const hub = api({
        release: (id) => (refuse ? Promise.resolve({ ok: false, error: "conflict" }) : Promise.resolve({ ok: true, value: { command: record(id) } })),
      });
      const page = shown(hub, failures);
      page.arm("hold:a1");
      expect(await page.answer("hold:a1", "release")).toBe(false);
      expect(useOf(page.store.getState().waiting, "hold:a1")).toEqual({ step: "idle", verdict: null, failure: "conflict" });
      expect(page.store.getState().waiting.cards).toHaveLength(2);
      refuse = false;
      page.arm("hold:a1");
      expect(await page.answer("hold:a1", "release")).toBe(true);
    });

    it("does nothing for a card that is not there", async () => {
      const hub = api();
      const page = shown(hub);
      page.arm("hold:zz");
      expect(await page.answer("hold:zz", "refuse")).toBe(false);
      expect(hub.calls).toEqual([]);
    });

    it("shows the cards the hub lists over the socket", () => {
      const page = controller(api());
      page.store.dispatch({ type: "server", message: { type: "waiting", cards: [first] } });
      expect(page.store.getState().waiting.cards).toHaveLength(1);
      page.store.dispatch({ type: "server", message: { type: "waiting", cards: [] } });
      expect(page.store.getState().waiting.cards).toEqual([]);
      expect(page.store.getState().waiting.known).toBe(true);
    });
  });

  describe("starting chains", () => {
    function shown(hub: HubApi): PageController {
      const page = controller(hub);
      const cards = [startCard(1), startCard(2, { before: [{ id: 1, zh: "工作 1" }], startable: false }), startCard(3), holdCard("a1")];
      page.store.dispatch({ type: "server", message: { type: "waiting", cards } });
      return page;
    }

    it("names each chain with the arrangement the page showed", async () => {
      const hub = api();
      const page = shown(hub);
      expect(await page.startChains(["start:1"])).toBe(true);
      expect(hub.calls).toEqual(["start 1:1"]);
      expect(page.store.getState().waiting.cards.map((card) => card.key)).not.toContain("start:1");
    });

    it("starts everything shown with one request", async () => {
      const hub = api();
      const page = shown(hub);
      expect(await page.startChains(["start:1", "start:2", "start:3"])).toBe(true);
      expect(hub.calls).toEqual(["start 1:1 2:2 3:3"]);
    });

    it("sends one request however many times 开始 is pressed", async () => {
      let finish: (value: Answer<{ tickets: never[] }>) => void = () => undefined;
      let requests = 0;
      const hub = api({
        startChains: () =>
          new Promise((resolve) => {
            requests += 1;
            finish = resolve;
          }),
      });
      const page = shown(hub);
      const presses = [page.startChains(["start:1"]), page.startChains(["start:1"]), page.startChains(["start:1", "start:3"])];
      expect(useOf(page.store.getState().waiting, "start:1").step).toBe("sending");
      finish({ ok: true, value: { tickets: [] } });
      expect(await Promise.all(presses)).toEqual([true, false, false]);
      expect(requests).toBe(1);
    });

    it("keeps the cards and says why when the hub refuses", async () => {
      const page = shown(api({ startChains: () => Promise.resolve({ ok: false, error: "conflict" }) }));
      expect(await page.startChains(["start:1", "start:3"])).toBe(false);
      expect(useOf(page.store.getState().waiting, "start:1")).toEqual({ step: "idle", verdict: null, failure: "conflict" });
      expect(useOf(page.store.getState().waiting, "start:3").failure).toBe("conflict");
      expect(page.store.getState().waiting.cards).toHaveLength(4);
    });

    it("does not start a hold, or a card that is not there", async () => {
      const hub = api();
      const page = shown(hub);
      expect(await page.startChains(["hold:a1"])).toBe(false);
      expect(await page.startChains(["start:9"])).toBe(false);
      expect(await page.startChains([])).toBe(false);
      expect(hub.calls).toEqual([]);
    });

    it("sends a change of the card for its ticket and keeps the card", async () => {
      const hub = api();
      const page = shown(hub);
      expect(await page.chooseChain("start:1", { model: "gpt-6.1-sol", effort: "medium" })).toBe(true);
      expect(hub.calls).toEqual(['choose 1 {"model":"gpt-6.1-sol","effort":"medium"}']);
      expect(useOf(page.store.getState().waiting, "start:1")).toEqual({ step: "idle", verdict: null, failure: null });
      expect(await page.chooseChain("hold:a1", { engine: "codex" })).toBe(false);
    });

    it("says why the hub refused a change of the card", async () => {
      const page = shown(api({ chooseChain: () => Promise.resolve({ ok: false, error: "unsupported" }) }));
      expect(await page.chooseChain("start:1", { model: "gpt-6.1-sol", effort: "max" })).toBe(false);
      expect(useOf(page.store.getState().waiting, "start:1").failure).toBe("unsupported");
    });

    it("forgets a failure when the card's arrangement changes", () => {
      const page = controller(api());
      page.store.dispatch({ type: "server", message: { type: "waiting", cards: [startCard(1)] } });
      page.store.dispatch({ type: "waiting", action: { type: "failed", key: "start:1", failure: "conflict" } });
      page.store.dispatch({ type: "server", message: { type: "waiting", cards: [startCard(1)] } });
      expect(useOf(page.store.getState().waiting, "start:1").failure).toBe("conflict");
      page.store.dispatch({ type: "server", message: { type: "waiting", cards: [startCard(1, { fingerprint: "e".repeat(64) })] } });
      expect(useOf(page.store.getState().waiting, "start:1").failure).toBeNull();
    });
  });

  describe("a ticket's detail", () => {
    function open(hub: HubApi, frame?: (run: () => void) => void) {
      const sent: unknown[] = [];
      let events: SocketEvents | undefined;
      const page = new PageController({
        api: hub,
        socket: {
          url: "ws://hub/ws",
          create: (_url, given) => {
            events = given;
            return { isOpen: () => true, send: (data) => void sent.push(JSON.parse(data)), close: () => undefined };
          },
          schedule: () => () => undefined,
        },
        onFailure: () => undefined,
        ...(frame === undefined ? {} : { frame }),
      });
      page.start();
      events?.open();
      const deliver = (message: unknown) => events?.message(JSON.stringify(message));
      return { page, sent, deliver };
    }

    it("reads the ticket and its history, then watches for what comes next", async () => {
      const event = workEvent(41, { kind: "text", block: "a", delta: "hello" });
      let pages = 0;
      const hub = api({ work: () => Promise.resolve({ ok: true, value: { events: pages++ === 0 ? [event] : [] } }) });
      const { page, sent } = open(hub);
      await page.openTicket(1);
      expect(page.store.getState().detail?.ticket?.id).toBe(1);
      expect(page.store.getState().detail?.log.events.map((entry) => entry.id)).toEqual([41]);
      expect(sent.at(-1)).toEqual({ type: "watch.ticket", ticket: 1, after: 41 });
      expect(pages).toBeGreaterThanOrEqual(2);
    });

    it("takes the worker's output from the socket, once each", async () => {
      const { page, deliver } = open(api());
      await page.openTicket(1);
      const event = workEvent(5, { kind: "text", block: "a", delta: "x" });
      deliver({ type: "work", event });
      deliver({ type: "work", event });
      expect(page.store.getState().detail?.log.attempts[0]?.items).toMatchObject([{ text: "x" }]);
    });

    it("gathers a burst of output into one change of the page", async () => {
      const queued: (() => void)[] = [];
      const { page, deliver } = open(api(), (run) => void queued.push(run));
      await page.openTicket(1);
      let changes = 0;
      page.store.subscribe(() => {
        changes += 1;
      });
      for (let id = 1; id <= 50; id += 1) {
        deliver({ type: "work", event: workEvent(id, { kind: "text", block: "a", delta: "y" }) });
      }
      expect(queued).toHaveLength(1);
      queued[0]?.();
      expect(changes).toBe(1);
      expect(page.store.getState().detail?.log.attempts[0]?.items).toMatchObject([{ text: "y".repeat(50) }]);
    });

    it("says a ticket the hub does not have is missing, and stops watching the last one", async () => {
      const { page, sent } = open(api({ ticket: () => Promise.resolve({ ok: false, error: "not_found" }) }));
      await page.openTicket(1);
      await page.openTicket(2);
      expect(page.store.getState().detail?.missing).toBe(true);
      expect(sent).toContainEqual({ type: "unwatch.ticket", ticket: 1 });
    });

    it("sends the owner's message, 停止 and 改派 to the hub", async () => {
      const hub = api();
      const { page } = open(hub);
      await page.openTicket(1);
      expect(await page.messageTicket(1, "use tabs")).toBe(true);
      expect(await page.stopTicket(1)).toBe(true);
      expect(page.store.getState().detail?.ticket?.state).toBe("stopped");
      expect(await page.reassignTicket(1, { machine: "pc", engine: "claude" })).toBe(true);
      expect(hub.calls).toContain("message 1 use tabs");
      expect(hub.calls).toContain("stop 1");
      expect(hub.calls).toContain('reassign 1 {"machine":"pc","engine":"claude"}');
    });

    it("says why the hub refused a message", async () => {
      const failures: Failure[] = [];
      const page = controller(api({ messageWorker: () => Promise.resolve({ ok: false, error: "conflict" }) }), failures);
      expect(await page.messageTicket(1, "hi")).toBe(false);
      expect(failures).toEqual(["conflict"]);
    });
  });
});
