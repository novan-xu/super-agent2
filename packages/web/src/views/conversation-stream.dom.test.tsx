import { text } from "@super-agent2/catalog";
import { ClientMessage, type Conversation, type ServerMessage, type StreamEntry } from "@super-agent2/protocol";
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
      const button = [...host.querySelectorAll<HTMLButtonElement>(".wb-repo")].find((button) => button.querySelector(".od-truncate")?.textContent === label)!;
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

it("starts on archived repositories and updates the workbench rail after pinning and unpinning", async () => {
  const archived = "owner/empty";
  let snapshot = settingsSnapshot({
    repositories: [
      { repository: "owner/one", account: "novan-xu", chosen: false, pinned: true },
      { repository: archived, account: "nuofan-island", chosen: false, pinned: false },
    ],
  });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
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
  const rail = () => [...host.querySelectorAll(".wb-repos .od-truncate")].map((row) => row.textContent);
  const archivedTab = () => host.querySelector(".repository-tabs button:last-child");
  expect(fetcher).toHaveBeenCalledWith("/api/repositories/refresh", expect.objectContaining({ method: "POST" }));
  expect(archivedTab()?.getAttribute("aria-pressed")).toBe("true");
  expect(titles()).toEqual([archived]);
  await toggle("置顶");
  expect(titles()).toEqual([]);
  await visit("/workbench");
  expect(rail()).toContain(archived);

  await visit("/settings");
  await visit("/settings/repositories");
  expect(archivedTab()?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => host.querySelector<HTMLButtonElement>(".repository-tabs button:first-child")!.click());
  expect(titles()).toEqual(["owner/one", archived]);
  await toggle("取消置顶");
  expect(titles()).toEqual(["owner/one"]);
  await visit("/workbench");
  expect(rail()).not.toContain(archived);
});
