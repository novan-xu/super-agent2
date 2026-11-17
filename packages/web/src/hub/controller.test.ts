import type { Conversation, OwnerEntry } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { Answer, Failure, HubApi } from "./api.js";
import { PageController } from "./controller.js";

const conversation: Conversation = { id: "c9", title: "", state: "idle", provider: null, createdAt: 1, updatedAt: 1 };
const entry: OwnerEntry = { id: "o1", conversation: "c9", seq: 1, at: 2, kind: "owner", text: "你好", taken: false };

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
});
