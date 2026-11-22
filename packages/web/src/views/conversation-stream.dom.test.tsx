import { text } from "@super-agent2/catalog";
import { ClientMessage, type Conversation, EngineTableBody, type ServerMessage, type StreamEntry } from "@super-agent2/protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { settingsSnapshot } from "../live/fixtures.js";

const at = Date.UTC(2026, 10, 19);
const repositories = ["owner/one", "owner/two"];
const topics: Conversation[] = [null, ...repositories].map((repository, index) => ({
  id: `topic-${index}`, title: `Topic ${index}`, repository, state: "idle", topicState: "active",
  provider: null, createdAt: at, updatedAt: at,
}));

function record(topic: Conversation, position: number, words: string): StreamEntry {
  return {
    position,
    topic: { id: topic.id, title: topic.title, repository: topic.repository },
    entry: { id: `${topic.id}-reply`, conversation: topic.id, seq: 1, at, kind: "text", turn: `${topic.id}-turn`, text: words },
  };
}

const daily = record(topics[0]!, 1, "Daily reply");
const first = record(topics[1]!, 2, "First repository reply");
const second = record(topics[2]!, 3, "Second repository reply");

class TestSocket {
  static readonly OPEN = 1;
  static current: TestSocket;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  readonly messages: ClientMessage[] = [];

  constructor() {
    TestSocket.current = this;
  }

  open() {
    this.readyState = TestSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = 3;
  }

  send(data: string) {
    this.messages.push(ClientMessage.parse(JSON.parse(data)));
  }

  deliver(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/conversations?all=1"
    ? Response.json({ conversations: topics, repositories, brain: { linked: true } })
    : Response.json({}, { status: 404 })));
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () => root.render(<StrictMode><App /></StrictMode>));
  await act(async () => {
    TestSocket.current.open();
    TestSocket.current.deliver({ type: "settings", settings: settingsSnapshot({
      repositories: repositories.map((repository) => ({ repository, account: "novan-xu", chosen: false, pinned: true })),
    }) });
  });
}

it("shows the global brain model on the workbench and updates it live", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/conversations?all=1"
    ? Response.json({ conversations: topics, repositories, brain: { linked: true, model: "gpt-current" } })
    : Response.json({}, { status: 404 })));
  await open("/workbench");
  const brainLine = () => host.querySelector(".hub-card .hub-line:last-child .od-truncate")?.textContent;
  expect(brainLine()).toBe("gpt-current");
  await act(async () => TestSocket.current.deliver({ type: "brain", brain: { linked: true, model: "claude-current" } }));
  expect(brainLine()).toBe("claude-current");
  expect(host.querySelector(".brain-chip")?.textContent).toContain("claude-current");
  await act(async () => TestSocket.current.deliver({ type: "brain", brain: { linked: false, model: null } }));
  expect(brainLine()).toBe(text("brain.offline"));
});

function lastWatch() {
  return TestSocket.current.messages.findLast((message) => message.type === "watch.stream")!;
}

function showPage(subscription: number | undefined, entries: StreamEntry[], options: { resumed?: true; before?: number } = {}) {
  TestSocket.current.deliver({ type: "stream.page", subscription, entries, before: options.before ?? null, turns: [], resumed: options.resumed });
}

function log() {
  expect(host.querySelectorAll('[role="log"]')).toHaveLength(1);
  return host.querySelector('[role="log"]')!;
}

function replies() {
  return [...log().querySelectorAll(".msg-text")].map((message) => message.textContent);
}

async function selectTab(label: string) {
  const link = [...host.querySelectorAll<HTMLAnchorElement>(".conv-tabs a")].find((link) => link.textContent === label)!;
  await act(async () => link.click());
}

async function selectRepository(repository: string) {
  await act(async () => {
    const picker = host.querySelector<HTMLSelectElement>(".conv-repository")!;
    picker.value = repository;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("switching conversation streams", () => {
  it("discards previous subscriptions and renders each entry once, even when it is replayed at a new position", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await open("/conversations");
    const code = lastWatch();
    await act(async () => showPage(code.subscription, [first, second], { before: first.position }));
    expect(replies()).toEqual(["First repository reply", "Second repository reply"]);
    const scroller = log().parentElement!;
    Object.defineProperty(scroller, "scrollHeight", { get: () => 500 });
    scroller.scrollTop = 120;
    await act(async () => host.querySelector<HTMLButtonElement>(".stream-older")!.click());
    expect(TestSocket.current.messages.at(-1)).toEqual({ type: "read.stream", before: first.position });

    await selectTab(text("conversation.daily"));
    const personal = lastWatch();
    expect(personal).toMatchObject({ scope: { kind: "daily" } });
    expect(personal.after).toBeUndefined();
    expect(scroller.scrollTop).toBe(500);
    await act(async () => {
      showPage(code.subscription, [first, second], { resumed: true });
      TestSocket.current.deliver({ ...second, type: "stream.entry", subscription: code.subscription });
      showPage(personal.subscription, [daily]);
    });
    expect(replies()).toEqual(["Daily reply"]);

    await selectTab(text("conversation.code"));
    const nextCode = lastWatch();
    await act(async () => {
      showPage(nextCode.subscription, [first, second]);
      showPage(nextCode.subscription, [{ ...first, position: 20 }], { resumed: true });
      TestSocket.current.deliver({ ...second, position: 21, type: "stream.entry", subscription: nextCode.subscription });
      showPage(personal.subscription, [daily], { resumed: true });
      showPage(code.subscription, [record(topics[1]!, 12, "Stale code reply")]);
    });
    expect(replies()).toEqual(["First repository reply", "Second repository reply"]);
    expect(log().parentElement).toBe(scroller);

    await selectRepository(repositories[0]!);
    const one = lastWatch();
    await act(async () => showPage(one.subscription, [first]));
    expect(replies()).toEqual(["First repository reply"]);

    await selectRepository(repositories[1]!);
    const two = lastWatch();
    await act(async () => {
      showPage(two.subscription, [second]);
      TestSocket.current.deliver({ ...first, type: "stream.entry", subscription: one.subscription });
      showPage(nextCode.subscription, [record(topics[2]!, 22, "Stale repository reply")], { resumed: true });
    });
    expect(replies()).toEqual(["Second repository reply"]);
    expect(log().parentElement).toBe(scroller);
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps one scroll element in the compact workbench conversation", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await open("/workbench");
    const code = lastWatch();
    await act(async () => showPage(code.subscription, [first, second]));
    const scroller = log().parentElement;

    const select = async (label: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>(".wb-tab-select")].find((button) => button.querySelector(".od-truncate")?.textContent === label)!;
      await act(async () => button.click());
    };
    await select(text("conversation.daily"));
    const personal = lastWatch();
    await act(async () => {
      showPage(code.subscription, [first, second], { resumed: true });
      showPage(personal.subscription, [daily]);
    });
    expect(replies()).toEqual(["Daily reply"]);
    expect(log().parentElement).toBe(scroller);

    for (const [index, repository] of repositories.entries()) {
      await select(repository);
      const watch = lastWatch();
      expect(watch.scope).toEqual({ kind: "repository", repository });
      await act(async () => showPage(watch.subscription, [index === 0 ? first : second]));
      expect(replies()).toEqual([index === 0 ? "First repository reply" : "Second repository reply"]);
      expect(log().parentElement).toBe(scroller);
    }
    expect(errors).not.toHaveBeenCalled();
  });
});

it("starts on archived repositories and updates the workbench tabs after pinning and unpinning", async () => {
  const archived = "owner/empty";
  let snapshot = settingsSnapshot({
    repositories: [
      { repository: "owner/one", account: "novan-xu", chosen: false, pinned: true },
      { repository: archived, account: "nuofan-island", chosen: false, pinned: false },
    ],
  });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/repositories/alias") {
      const { repository, alias } = JSON.parse(String(init?.body));
      snapshot = { ...snapshot, repositories: snapshot.repositories.map((row) => row.repository === repository ? { ...row, alias } : row) };
      return Response.json(snapshot);
    }
    if (path === "/api/repositories/pin") {
      const { repository, pinned } = JSON.parse(String(init?.body));
      snapshot = { ...snapshot, repositories: snapshot.repositories.map((row) => row.repository === repository ? { ...row, pinned } : row) };
      return Response.json(snapshot);
    }
    if (path === "/api/settings") return Response.json(snapshot);
    if (path === "/api/repositories/refresh") return Response.json({}, { status: 202 });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  window.history.replaceState(null, "", "/settings/repositories");
  await act(async () => root.render(<App />));
  await act(async () => {
    TestSocket.current.open();
    TestSocket.current.deliver({ type: "settings", settings: snapshot });
  });

  const visit = async (path: string) => act(async () => host.querySelector<HTMLAnchorElement>(`a[href="${path}"]`)!.click());
  const toggle = async (label: string) => act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label} ${archived}"]`)!.click());
  const titles = () => [...host.querySelectorAll(".srow-title")].map((row) => row.textContent);
  const rail = () => [...host.querySelectorAll(".wb-tabs .od-truncate")].map((row) => row.textContent);
  const archivedTab = () => host.querySelector(".repository-tabs button:last-child");
  expect(fetcher).toHaveBeenCalledWith("/api/repositories/refresh", expect.objectContaining({ method: "POST" }));
  expect(archivedTab()?.getAttribute("aria-pressed")).toBe("true");
  expect(titles()).toEqual([archived]);
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${archived} 的别名"]`)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Short name");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.blur());
  expect(snapshot.repositories[1]?.alias).toBe("Short name");
  await toggle("置顶");
  expect(titles()).toEqual([]);
  await visit("/workbench");
  expect(rail()).toContain("Short name");

  await visit("/settings");
  await visit("/settings/repositories");
  expect(archivedTab()?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => host.querySelector<HTMLButtonElement>(".repository-tabs button:first-child")!.click());
  expect(titles()).toEqual(["owner/one", archived]);
  await toggle("取消置顶");
  expect(titles()).toEqual(["owner/one"]);
  await visit("/workbench");
  expect(rail()).not.toContain("Short name");
});

it("edits and saves Antigravity's model order on the Models page", async () => {
  const hydrogen = { model: "gemini-4-hydrogen", effort: "high" };
  const flash = { model: "gemini-3.8-flash", effort: "high" };
  let snapshot = settingsSnapshot({
    machines: [{
      name: "mac", online: true, createdAt: at, lastSeenAt: at,
      report: {
        hostname: "mac", platform: "darwin", arch: "arm64", release: "1", user: "owner", slots: { total: 1, free: 1 }, allowances: [],
        programs: [{ id: "antigravity", installed: true, path: "agy", version: "1", models: [{ id: hydrogen.model, efforts: [hydrogen.effort] }, { id: flash.model, efforts: [flash.effort] }], source: "program", problem: null }],
      },
    }],
  });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/settings") return Response.json(snapshot);
    if (path === "/api/engine-table") {
      const { table } = EngineTableBody.parse(JSON.parse(String(init?.body)));
      snapshot = { ...snapshot, table };
      return Response.json({ table });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  window.history.replaceState(null, "", "/settings/models");
  await act(async () => root.render(<App />));
  await act(async () => {
    TestSocket.current.open();
    TestSocket.current.deliver({ type: "settings", settings: snapshot });
  });

  const section = [...host.querySelectorAll("section")].find((item) => item.querySelector("h2")?.textContent === "Antigravity")!;
  const selected = () => [...section.querySelectorAll("select")].map((select) => select.options[select.selectedIndex]?.textContent);
  const buttons = (label: string) => [...section.querySelectorAll("button")].filter((button) => (button.getAttribute("aria-label") ?? button.textContent) === label);
  expect(selected()).toEqual(["gemini-4-hydrogen · high", "gemini-3.8-flash · high"]);
  await act(async () => buttons(text("models.earlier"))[1]!.click());
  expect(selected()).toEqual(["gemini-3.8-flash · high", "gemini-4-hydrogen · high"]);
  await act(async () => buttons(text("models.remove"))[1]!.click());
  expect(buttons(text("models.remove"))[0]?.disabled).toBe(true);
  await act(async () => buttons(text("models.add"))[0]!.click());
  await act(async () => buttons(text("models.save"))[0]!.click());
  expect(snapshot.table.antigravity).toEqual([flash, hydrogen]);
});

it("shows usage totals, daily provider figures, and top topics", async () => {
  const daily = [
    { day: "2026-11-21", provider: "gpt", input: 20, cacheRead: 80, cacheWrite: null, output: 5, reasoning: 2, costUsd: null, attempts: 1 },
    { day: "2026-11-20", provider: "gpt", input: 10, cacheRead: 40, cacheWrite: null, output: 3, reasoning: 1, costUsd: null, attempts: 1 },
  ];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/brain/usage"
    ? Response.json({ daily, topics: [{ topic: "topic-1", title: "Test topic", tokens: 158 }], seeds: [{ turn: "turn-1", at: 1, provider: "gpt", title: "Test topic", seed: { input: 42 } }] })
    : Response.json({}, { status: 404 })));
  window.history.replaceState(null, "", "/settings/usage");
  await act(async () => root.render(<App />));
  const tables = host.querySelectorAll("table");
  expect(tables).toHaveLength(2);
  expect(tables[0]?.textContent).toContain("120");
  expect(tables[0]?.textContent).toContain("30");
  expect(tables[1]?.textContent).toContain("2026-11-21");
  expect(host.textContent).toContain("Test topic");
  expect(host.textContent).toContain("158");
  expect(host.textContent).toContain("42");
});

it("redirects the old History URL into Settings and loads the history", async () => {
  const fetcher = vi.fn(async (path: string) => path.startsWith("/api/tickets?scope=ended")
    ? Response.json({ tickets: [], next: null })
    : Response.json({}, { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  await open("/history");
  expect(window.location.pathname).toBe("/settings/history");
  expect(host.querySelector('a[href="/settings/history"][aria-current="page"]')).not.toBeNull();
  expect(host.querySelector(`input[aria-label="${text("history.search")}"]`)).not.toBeNull();
  expect(fetcher).toHaveBeenCalledWith("/api/tickets?scope=ended", expect.anything());
});

it("opens and closes repository tabs through the shared pin API", async () => {
  let snapshot = settingsSnapshot({ repositories: [
    { repository: "owner/one", account: "novan-xu", chosen: false, pinned: true },
    { repository: "owner/two", account: "novan-xu", chosen: false, pinned: false, alias: "Second" },
  ] });
  let fail = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/repositories/pin") {
      if (fail) return Response.json({}, { status: 500 });
      const { repository, pinned } = JSON.parse(String(init?.body));
      snapshot = { ...snapshot, repositories: snapshot.repositories.map((row) => row.repository === repository ? { ...row, pinned } : row) };
      return Response.json(snapshot);
    }
    if (path === "/api/settings") return Response.json(snapshot);
    return Response.json({}, { status: 404 });
  }));
  await act(async () => root.render(<App />));
  await act(async () => { TestSocket.current.open(); TestSocket.current.deliver({ type: "settings", settings: snapshot }); });
  await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/workbench"]')!.click());
  const tabs = () => [...host.querySelectorAll<HTMLButtonElement>(".wb-tab-select")];
  expect(tabs().slice(0, 2).map((tab) => tab.textContent)).toEqual([text("workbench.all"), text("conversation.daily")]);
  expect(host.querySelectorAll(".wb-tab-close")).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>(".wb-add")!.click());
  expect(host.querySelector(".wb-repo-option")?.textContent).toBe("Second");
  const filter = host.querySelector<HTMLInputElement>(`input[aria-label="${text("workbench.filterRepositories")}"]`)!;
  expect(document.activeElement).toBe(filter);
  await act(async () => filter.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  expect(document.activeElement).toBe(host.querySelector(".wb-repo-option"));
  await act(async () => host.querySelector<HTMLButtonElement>(".wb-repo-option")!.click());
  expect(snapshot.repositories[1]?.pinned).toBe(true);
  expect(tabs().find((tab) => tab.title === "owner/two")?.getAttribute("aria-pressed")).toBe("true");
  fail = true;
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${text("workbench.closeRepository", { repository: "owner/two" })}"]`)!.click());
  expect(snapshot.repositories[1]?.pinned).toBe(true);
  expect(tabs().find((tab) => tab.title === "owner/two")?.getAttribute("aria-pressed")).toBe("true");
  fail = false;
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${text("workbench.closeRepository", { repository: "owner/two" })}"]`)!.click());
  expect(snapshot.repositories[1]?.pinned).toBe(false);
  expect(tabs()[0]?.getAttribute("aria-pressed")).toBe("true");
  expect(tabs().some((tab) => tab.title === "owner/two")).toBe(false);
});
