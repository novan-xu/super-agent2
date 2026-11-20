import type { CommandRecord, Conversation, OwnerEntry, Ticket, TicketHistory } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { Answer, Failure, HubApi } from "./api.js";
import { holdCard, settingsSnapshot, startCard, ticket, workEvent } from "../live/fixtures.js";
import { useOf } from "../live/waiting.js";
import { PageController } from "./controller.js";
import type { SocketEvents } from "./socket.js";

const conversation: Conversation = { id: "c9", title: "", state: "idle", topicState: "active", repository: null, provider: null, createdAt: 1, updatedAt: 1 };
const entry: OwnerEntry = { id: "o1", conversation: "c9", seq: 1, at: 2, kind: "owner", text: "你好", attachments: [], taken: false };

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
    rearrange: () => answer("rearrange", { conversation }),
    conversations: () => answer("conversations", { brain: { linked: true }, conversations: [] }),
    detail: (id) => answer(`detail ${id}`, { conversation, turns: [], entries: [] }),
    answerQuestions: (id) => answer(`questions ${id}`, { entry }),
    send: (id, text) => answer(`send ${id} ${text}`, { entry }),
    previewStream: () => Promise.resolve({ ok: false, error: "network" }),
    sendToStream: (text) => answer(`stream ${text}`, { entry, topic: conversation, position: 1 }),
    renameTopic: (id, title) => answer(`rename ${id} ${title}`, { conversation }),
    archiveTopic: (id) => answer(`archive ${id}`, { conversation }),
    mergeTopic: (id, destination) => answer(`merge ${id} ${destination}`, { conversation }),
    moveMessage: (id, message, destination) => answer(`move ${id} ${message} ${destination}`, { conversation }),
    interrupt: (id) => answer(`interrupt ${id}`, { conversation }),
    release: (id, fingerprint) => answer(`release ${id} ${fingerprint}`, { command: record(id) }),
    refuse: (id, fingerprint) => answer(`refuse ${id} ${fingerprint}`, { command: record(id) }),
    tickets: (scope) => answer(`tickets ${scope ?? "open"}`, { tickets: [] }),
    history: (page) => answer(`history ${page.query} ${page.before ?? ""}`, { tickets: [], next: null }),
    ticket: (id) => answer(`ticket ${id}`, { ticket: ticket(id), moves: [], attempts: [], rounds: [], switches: [] }),
    work: (id, after) => answer(`work ${id} ${after}`, { events: [] }),
    messageWorker: (id, text) => answer(`message ${id} ${text}`, { id: "m1" }),
    stopTicket: (id) => answer(`stop ${id}`, { ticket: ticket(id, { state: "stopped", updatedAt: 99_000 }) }),
    reviewDecision: (id, decision, review) => answer(`review ${id} ${decision} ${review.verdict}`, { ticket: ticket(id, { updatedAt: 99_000 }) }),
    answerStuck: (id, request) => answer(`answer ${id} ${JSON.stringify(request)}`, { ticket: ticket(id, { state: request.answer === "resume" ? "working" : "stopped", updatedAt: 99_000 }) }),
    machines: () => answer("machines", { machines: [] }),
    startChains: (chains) => answer(`start ${chains.map((chain) => `${chain.ticket}:${chain.fingerprint.slice(0, 1)}`).join(" ")}`, { tickets: [] }),
    chooseChain: (id, change) => answer(`choose ${id} ${JSON.stringify(change)}`, { tickets: [] }),
    reassign: (id, change) => answer(`reassign ${id} ${JSON.stringify(change)}`, { tickets: [] }),
    pushKey: () => answer("pushKey", { publicKey: null }),
    refreshAllowance: () => answer("refreshAllowance", { requested: 1 }),
    subscribePush: () => answer("subscribePush", { subscribed: true }),
    unsubscribePush: () => answer("unsubscribePush", { subscribed: false }),
    addMemory: (text) => answer(`addMemory ${text}`, { memories: [], suggestions: [] }),
    editMemory: (id, text) => answer(`editMemory ${id} ${text}`, { memories: [], suggestions: [] }),
    deleteMemory: (id) => answer(`deleteMemory ${id}`, { memories: [], suggestions: [] }),
    decideSuggestion: (id, decision) => answer(`decideSuggestion ${id} ${decision}`, { memories: [], suggestions: [] }),
    settings: () => answer("settings", settingsSnapshot()),
    addMachine: (name, system) => answer(`addMachine ${name} ${system}`, { name, system, command: "run" }),
    revokeMachine: (name) => answer(`revokeMachine ${name}`, { name, accessToken: "removed" as const }),
    setMachineStorage: (name, storage) => answer(`setMachineStorage ${name}`, storage),
    setOrder: (order) => answer(`setOrder ${order.join(",")}`, settingsSnapshot({ brain: { linked: true, order: [...order, "deepseek"], providers: [] } })),
    setAccount: (repository, account) => answer(`setAccount ${repository} ${account}`, settingsSnapshot()),
    setAlias: (repository, alias) => answer(`setAlias ${repository} ${alias}`, settingsSnapshot()),
    setPinned: (repository, pinned) => answer(`setPinned ${repository} ${pinned}`, settingsSnapshot()),
    refreshRepositories: () => answer("refreshRepositories", {}),
    setTable: (table) => answer("setTable", { table }),
    createAttachment: (name, size, mediaType) => answer(`createAttachment ${name}`, { attachment: { id: "0".repeat(32), name, size, mediaType }, received: 0 }),
    uploadState: (id) => answer(`uploadState ${id}`, { attachment: { id, name: "a", size: 0, mediaType: "text/plain" }, received: 0 }),
    uploadPart: (id, offset, part) => answer(`uploadPart ${id} ${offset}`, { attachment: { id, name: "a", size: part.size, mediaType: "text/plain" }, received: offset + part.size }),
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
  it("refreshes a scoped stream when a topic moves into or out of it", () => {
    for (const scope of [{ kind: "daily" } as const, { kind: "repository", repository: "owner/project" } as const]) {
      let events: SocketEvents | undefined;
      const sent: unknown[] = [];
      const page = new PageController({
        api: api(),
        socket: { url: "ws://hub/ws", create: (_url, given) => {
          events = given;
          return { isOpen: () => true, send: (data) => sent.push(JSON.parse(data)), close: () => undefined };
        }, schedule: () => () => undefined },
        onFailure: () => undefined,
      });
      page.store.dispatch({ type: "list", list: { brain: { linked: true }, conversations: [conversation] } });
      page.start();
      page.open(null, true, scope);
      events?.message(JSON.stringify({ type: "conversation", conversation: { ...conversation, repository: "owner/project", updatedAt: 2 } }));
      expect(sent.filter((message) => (message as { type: string }).type === "watch.stream")).toHaveLength(2);
      expect(page.store.getState().stream.entries).toEqual([]);
      page.stop();
    }
  });

  it("sends a new-topic move using the selected message and its source", async () => {
    const hub = api();
    const page = controller(hub);
    expect(await page.moveMessage("source", "entry", null)).toBe(true);
    expect(hub.calls).toEqual(["move source entry null"]);
  });

  it("sends to the stream without opening a topic", async () => {
    const hub = api();
    const page = controller(hub);
    page.open(null, true);
    expect(await page.send("你好")).toBe(true);
    expect(hub.calls).toEqual(["stream 你好"]);
    expect(page.store.getState().current).toBeNull();
  });

  it("carries a quote to the stream or to the topic that owned the draft", async () => {
    const sent: unknown[][] = [];
    const page = controller(api({
      send: async (...args) => {
        sent.push(args);
        return { ok: true, value: { entry } };
      },
      sendToStream: async (...args) => {
        sent.push(args);
        return { ok: true, value: { entry, topic: conversation, position: 1 } };
      },
    }));
    const scope = { kind: "repository", repository: "owner/project" } as const;
    page.open(null, true, scope);
    expect(await page.send("回复", [], "source")).toBe(true);
    page.open("c8");
    expect(await page.send("继续", [], "source", "c9")).toBe(true);
    const attempt = { id: undefined, signal: expect.any(AbortSignal) };
    expect(sent).toEqual([["回复", [], "source", scope, undefined, attempt], ["c9", "继续", [], "source", attempt]]);
  });

  it("opens an existing topic and sends directly to it", async () => {
    const hub = api();
    const page = controller(hub);
    page.open("c9");
    expect(await page.send("你好")).toBe(true);
    expect(hub.calls).toEqual(["detail c9", "send c9 你好"]);
    expect(page.store.getState().list.map((item) => item.id)).toEqual(["c9"]);
    expect(page.store.getState().current?.entries).toEqual([entry]);
  });

  it("keeps the message when the hub refuses it, and says why", async () => {
    const failures: Failure[] = [];
    const page = controller(api({ send: () => Promise.resolve({ ok: false, error: "network" }) }), failures);
    page.open("c9");
    expect(await page.send("你好")).toBe(false);
    expect(failures).toEqual(["network"]);
    expect(page.store.getState().current?.entries).toEqual([]);
  });

  it.each([null, "c9"])("ends a send to %s that gets no answer within the limit, says so, and passes the send's id", async (topic) => {
    const failures: Failure[] = [];
    const limits: { readonly delay: number; readonly run: () => void; cancelled: boolean }[] = [];
    const signals: AbortSignal[] = [];
    const ids: (string | undefined)[] = [];
    const never = <T,>(attempt: { id?: string | undefined; signal?: AbortSignal | undefined } = {}) => {
      ids.push(attempt.id);
      signals.push(attempt.signal!);
      return new Promise<T>(() => undefined);
    };
    const page = new PageController({
      api: api({ send: (...args) => never(args[4]), sendToStream: (...args) => never(args[5]) }),
      socket: { url: "ws://hub/ws", create: () => ({ isOpen: () => false, send: () => undefined, close: () => undefined }), schedule: (run, delay) => {
        const limit = { delay, run, cancelled: false };
        limits.push(limit);
        return () => {
          limit.cancelled = true;
        };
      } },
      onFailure: (failure) => failures.push(failure),
    });
    page.open(topic, topic === null);
    const id = "4f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
    const sending = page.send("你好", [], undefined, topic, undefined, undefined, id);
    expect(limits.map(({ delay }) => delay)).toEqual([20_000]);
    expect(ids).toEqual([id]);
    expect(signals[0]?.aborted).toBe(false);
    limits[0]!.run();
    expect(await sending).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(failures).toEqual(["timeout"]);

    const answered = controller(api(), failures);
    answered.open(topic, topic === null);
    expect(await answered.send("你好", [], undefined, topic, undefined, undefined, id)).toBe(true);
    expect(failures).toEqual(["timeout"]);
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

    it("releases with one press, with the fingerprint the owner saw, and removes the card", async () => {
      const hub = api();
      const page = shown(hub);
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
      expect(await page.answer("hold:a1", "release")).toBe(false);
      expect(useOf(page.store.getState().waiting, "hold:a1")).toEqual({ step: "idle", verdict: null, failure: "conflict" });
      expect(page.store.getState().waiting.cards).toHaveLength(2);
      refuse = false;
      expect(await page.answer("hold:a1", "release")).toBe(true);
    });

    it("does nothing for a card that is not there", async () => {
      const hub = api();
      const page = shown(hub);
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

describe("PageController and the history", () => {
  function ended(id: number, at: number, overrides: Partial<Ticket> = {}): Ticket {
    return ticket(id, { state: "merged", updatedAt: at, endedAt: at, ...overrides });
  }

  function pagesOf(given: Readonly<Record<string, TicketHistory>>): HubApi["history"] {
    return (request) => Promise.resolve({ ok: true, value: given[`${request.query}|${request.before ?? ""}`] ?? { tickets: [], next: null } });
  }

  function open(hub: HubApi) {
    let events: SocketEvents | undefined;
    const page = new PageController({
      api: hub,
      socket: {
        url: "ws://hub/ws",
        create: (_url, given) => {
          events = given;
          return { isOpen: () => true, send: () => undefined, close: () => undefined };
        },
        schedule: () => () => undefined,
      },
      onFailure: () => undefined,
    });
    page.start();
    const deliver = (message: unknown) => events?.message(JSON.stringify(message));
    return { page, deliver };
  }

  const ids = (page: PageController) => page.store.getState().history.tickets.map((entry) => entry.id);

  it("reads the first page when the view is opened, and not again while it is known", async () => {
    const asked: string[] = [];
    const read = pagesOf({ "|": { tickets: [ended(2, 2000), ended(1, 1000)], next: null } });
    const page = controller(
      api({
        history: (request) => {
          asked.push(`${request.query}|${request.before ?? ""}`);
          return read(request);
        },
      }),
    );
    await page.openHistory();
    await page.openHistory();
    expect(ids(page)).toEqual([2, 1]);
    expect(page.store.getState().history.status).toBe("ready");
    expect(asked).toEqual(["|"]);
  });

  it("says it failed, and reads again when asked", async () => {
    let answers = 0;
    const page = controller(
      api({
        history: () => {
          answers += 1;
          return Promise.resolve(answers === 1 ? { ok: false, error: "network" } : { ok: true, value: { tickets: [ended(1, 1000)], next: null } });
        },
      }),
    );
    await page.openHistory();
    expect(page.store.getState().history.status).toBe("failed");
    await page.openHistory();
    expect(page.store.getState().history.status).toBe("ready");
    expect(ids(page)).toEqual([1]);
  });

  it("searches in the hub with the words as the owner typed them, and shows the answer", async () => {
    const page = controller(
      api({
        history: pagesOf({ "|": { tickets: [ended(2, 2000), ended(1, 1000)], next: null }, "日期|": { tickets: [ended(1, 1000)], next: null } }),
      }),
    );
    await page.openHistory();
    await page.searchHistory("  日期 ");
    expect(page.store.getState().history).toMatchObject({ query: "  日期 ", applied: "日期", status: "ready" });
    expect(ids(page)).toEqual([1]);
    await page.searchHistory("日期  ");
    expect(ids(page)).toEqual([1]);
    await page.searchHistory("");
    expect(ids(page)).toEqual([2, 1]);
  });

  it("drops the answer to a search that is no longer in the box", async () => {
    const waiting = new Map<string, (answer: Answer<TicketHistory>) => void>();
    const page = controller(api({ history: (request) => new Promise((resolve) => waiting.set(request.query, resolve)) }));
    const first = page.openHistory();
    const slow = page.searchHistory("a");
    const fast = page.searchHistory("ab");
    waiting.get("ab")?.({ ok: true, value: { tickets: [ended(2, 2000)], next: null } });
    await fast;
    waiting.get("a")?.({ ok: true, value: { tickets: [ended(1, 1000)], next: null } });
    waiting.get("")?.({ ok: true, value: { tickets: [ended(3, 3000)], next: null } });
    await Promise.all([first, slow]);
    expect(page.store.getState().history).toMatchObject({ applied: "ab", status: "ready" });
    expect(ids(page)).toEqual([2]);
  });

  it("reads the next page after the last one read, and only while there is one", async () => {
    const page = controller(
      api({
        history: pagesOf({ "|": { tickets: [ended(3, 3000), ended(2, 2000)], next: "2000.2" }, "|2000.2": { tickets: [ended(1, 1000)], next: null } }),
      }),
    );
    await page.openHistory();
    await page.moreHistory();
    expect(ids(page)).toEqual([3, 2, 1]);
    expect(page.store.getState().history.next).toBeNull();
    await page.moreHistory();
    expect(ids(page)).toEqual([3, 2, 1]);
  });

  it("keeps the list and offers the next page again when it could not be read", async () => {
    let more = 0;
    const page = controller(
      api({
        history: (request) => {
          if (request.before === null) {
            return Promise.resolve({ ok: true, value: { tickets: [ended(3, 3000)], next: "3000.3" } });
          }
          more += 1;
          return Promise.resolve(more === 1 ? { ok: false, error: "network" } : { ok: true, value: { tickets: [ended(2, 2000)], next: null } });
        },
      }),
    );
    await page.openHistory();
    await page.moreHistory();
    expect(page.store.getState().history.more).toBe("failed");
    expect(ids(page)).toEqual([3]);
    await page.moreHistory();
    expect(ids(page)).toEqual([3, 2]);
  });

  it("puts a ticket that ends while the view is open at the top of the list and takes it off the open tickets, without asking the hub", async () => {
    const asked: string[] = [];
    const read = pagesOf({ "|": { tickets: [ended(1, 1000)], next: null } });
    const { page, deliver } = open(
      api({
        history: (request) => {
          asked.push(request.query);
          return read(request);
        },
      }),
    );
    await page.openHistory();
    deliver({ type: "tickets", tickets: [ticket(2, { state: "verifying" })] });
    expect(page.store.getState().tickets.open.map((entry) => entry.id)).toEqual([2]);
    deliver({ type: "ticket", ticket: ended(2, 2000) });
    expect(ids(page)).toEqual([2, 1]);
    expect(page.store.getState().tickets.open).toEqual([]);
    expect(asked).toEqual([""]);
  });

  it("asks the hub for the first page again when a ticket ends while a search is shown, and ignores one that was joined into another", async () => {
    const asked: string[] = [];
    let answers = 0;
    const { page, deliver } = open(
      api({
        history: (request) => {
          asked.push(`${request.query}|${request.before ?? ""}`);
          answers += 1;
          return Promise.resolve({ ok: true, value: { tickets: answers < 3 ? [ended(1, 1000)] : [ended(2, 2000), ended(1, 1000)], next: null } });
        },
      }),
    );
    await page.openHistory();
    await page.searchHistory("日期");
    const changed = new Promise<void>((resolve) => {
      const off = page.store.subscribe(() => {
        if (ids(page).includes(2)) {
          off();
          resolve();
        }
      });
    });
    deliver({ type: "ticket", ticket: ended(3, 3000, { state: "stopped", joinedInto: 1 }) });
    deliver({ type: "ticket", ticket: ended(2, 2000) });
    await changed;
    expect(ids(page)).toEqual([2, 1]);
    expect(asked).toEqual(["|", "日期|", "日期|"]);
  });

  it("reads the first page again when the connection comes back, to take what ended meanwhile", async () => {
    let round = 0;
    const { page } = open(
      api({
        history: () => {
          round += 1;
          return Promise.resolve({ ok: true, value: { tickets: round === 1 ? [ended(1, 1000)] : [ended(2, 2000), ended(1, 1000)], next: null } });
        },
      }),
    );
    await page.openHistory();
    await page.refresh();
    expect(ids(page)).toEqual([2, 1]);
  });

  it("adds, edits and deletes a memory, confirms and declines a suggestion, and reports a refusal", async () => {
    const hub = api({ editMemory: () => Promise.resolve({ ok: false, error: "not_found" }) });
    const failures: Failure[] = [];
    const page = controller(hub, failures);
    expect(await page.addMemory(" 先说结论\n再列细节 ")).toBe(true);
    expect(await page.deleteMemory(3)).toBe(true);
    expect(await page.decideSuggestion(4, "confirm")).toBe(true);
    expect(await page.decideSuggestion(5, "decline")).toBe(true);
    expect(hub.calls).toEqual(["addMemory  先说结论\n再列细节 ", "deleteMemory 3", "decideSuggestion 4 confirm", "decideSuggestion 5 decline"]);
    expect(await page.editMemory(3, "先说结论")).toBe(false);
    expect(failures).toEqual(["not_found"]);
  });

  it("reads the settings and keeps what a change answers", async () => {
    const hub = api();
    const page = controller(hub);
    await page.loadSettings();
    expect(page.store.getState().settings?.brain.order).toEqual(["gpt", "claude", "deepseek"]);
    expect(await page.setOrder(["claude", "gpt"])).toBe(true);
    expect(page.store.getState().settings?.brain.order).toEqual(["claude", "gpt", "deepseek"]);
    expect(await page.addMachine("studio", "macos")).toEqual({ name: "studio", system: "macos", command: "run" });
    expect(hub.calls).toContain("addMachine studio macos");
  });

  it("keeps a newer settings update when an earlier pin response arrives", async () => {
    const page = controller(api({ setPinned: async () => ({ ok: true, value: settingsSnapshot() }) }));
    const update = page.setPinned("org/project", true);
    const current = settingsSnapshot({ repositories: [{ repository: "org/project", account: "nuofan-island", chosen: false, pinned: true }] });
    page.store.dispatch({ type: "server", message: { type: "settings", settings: current } });
    expect(await update).toBe(true);
    expect(page.store.getState().settings).toBe(current);
  });

  it("tells a refused table change apart from other failures", async () => {
    const failures: Failure[] = [];
    const refused = controller(api({ setTable: () => Promise.resolve({ ok: false, error: "unsupported" }) }), failures);
    expect(await refused.setTable(settingsSnapshot().table)).toBe("unsupported");
    expect(failures).toEqual([]);
    const lost = controller(api({ setTable: () => Promise.resolve({ ok: false, error: "network" }) }), failures);
    expect(await lost.setTable(settingsSnapshot().table)).toBe("failed");
    expect(failures).toEqual(["network"]);
  });

  it("says when adding a machine is refused for want of Cloudflare", async () => {
    const failures: Failure[] = [];
    const page = controller(api({ addMachine: () => Promise.resolve({ ok: false, error: "cloudflare" }) }), failures);
    expect(await page.addMachine("studio", "windows")).toBeUndefined();
    expect(failures).toEqual(["cloudflare"]);
  });

  it("hands Cloudflare's reason to the form instead of a passing notice when it refuses the token", async () => {
    const failures: Failure[] = [];
    const page = controller(api({ addMachine: () => Promise.resolve({ ok: false, error: "cloudflare_refused", reason: "Cloudflare refused to create the service token (HTTP 403)" }) }), failures);
    expect(await page.addMachine("studio", "windows")).toEqual({ refused: "Cloudflare refused to create the service token (HTTP 403)" });
    expect(failures).toEqual([]);
  });
});
