import { text } from "@super-agent2/catalog";
import type { Conversation, StreamPreview } from "@super-agent2/protocol";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyScope } from "../live/topic-scope.js";
import { TopicComposer } from "./ConversationView.js";

const now = new Date("2026-11-18T12:00:00Z");
const first: Conversation = {
  id: "first", title: "First topic", repository: null, state: "idle", topicState: "active",
  provider: null, createdAt: now.getTime(), updatedAt: now.getTime(),
};
const second: Conversation = { ...first, id: "second", title: "Another topic" };
const archived: Conversation = { ...first, id: "archived", topicState: "archived" };
const merging: Conversation = { ...first, id: "merging", mergePending: true };
const system: Conversation = { ...first, id: "system", system: true };

const proposal = (topic: Conversation | null): StreamPreview => ({
  title: topic?.title ?? null,
  proposal: {
    candidates: 2, shadow: null, fallback: "model not configured",
    decided: { configuration: "bigram", rule: topic === null ? "d" : "b", topic: topic?.id ?? null, best: null, bestScore: null, runnerUpScore: null },
  },
});

type Props = ComponentProps<typeof TopicComposer>;
type Preview = NonNullable<Props["routing"]>["preview"];
const ignore = () => undefined;
const anyId = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const field = () => host.querySelector("textarea")!;
const picker = () => host.querySelector("select")!;
const sendButton = () => host.querySelector<HTMLButtonElement>('[type="submit"]')!;

async function render(preview: Preview, send: Props["send"], props: Partial<Props> = {}) {
  await act(async () => root.render(<TopicComposer draftKey="scope:daily" working={false} canStop={false}
    stop={ignore} clearQuote={ignore} send={send} quote={undefined}
    routing={{ scope: dailyScope, status: "open", topics: [first, second, archived, merging, system], preview }} {...props} />));
}

async function type(value: string) {
  await act(async () => {
    const textarea = field();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
}

async function choose(value: string) {
  await act(async () => {
    picker().value = value;
    picker().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function requestPreview() {
  await act(async () => vi.runOnlyPendingTimersAsync());
}

async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("stream composer destinations", () => {
  it("shows a debounced suggestion in the same control without disturbing focus or using an older response", async () => {
    const firstEdit = Promise.withResolvers<StreamPreview>();
    const secondEdit = Promise.withResolvers<StreamPreview>();
    const preview = vi.fn<Preview>()
      .mockResolvedValueOnce(proposal(first))
      .mockReturnValueOnce(firstEdit.promise)
      .mockReturnValueOnce(secondEdit.promise);
    await render(preview, async () => true);
    const select = picker();
    expect(select.hidden).toBe(true);
    field().focus();
    await requestPreview();
    expect(preview).toHaveBeenNthCalledWith(1, { scope: dailyScope, text: "", attachmentNames: [] }, expect.any(AbortSignal));
    expect(select.hidden).toBe(false);
    expect(select.options[select.selectedIndex]?.textContent).toBe(first.title);
    expect([...select.options].map(({ value }) => value)).toEqual([":new", first.id, second.id]);
    expect(select.options[0]?.textContent).toBe(text("conversation.newTopic"));

    await type("De");
    await type("Details");
    expect(preview).toHaveBeenCalledTimes(1);
    await requestPreview();
    expect(preview).toHaveBeenNthCalledWith(2, { scope: dailyScope, text: "Details", attachmentNames: [] }, expect.any(AbortSignal));
    expect(select.value).toBe(first.id);
    await type("More details");
    await requestPreview();
    expect(preview).toHaveBeenNthCalledWith(3, { scope: dailyScope, text: "More details", attachmentNames: [] }, expect.any(AbortSignal));
    await act(async () => secondEdit.resolve(proposal(null)));
    await act(async () => firstEdit.resolve(proposal(second)));
    expect(picker()).toBe(select);
    expect(select.value).toBe(":new");
    expect(select.options[select.selectedIndex]?.textContent).toBe(text("conversation.newTopic"));
    expect(document.activeElement).toBe(field());
  });

  it.each([first, null])("sends the visible suggestion while a later request is pending", async (destination) => {
    const preview = vi.fn<Preview>().mockResolvedValueOnce(proposal(destination)).mockReturnValueOnce(Promise.withResolvers<StreamPreview>().promise);
    const send = vi.fn<Props["send"]>().mockResolvedValue(true);
    await render(preview, send);
    await requestPreview();
    await type("Updated draft");
    await requestPreview();
    await submit();
    expect(send).toHaveBeenCalledWith("Updated draft", [], undefined, {
      ...(destination === null ? { newTopic: true } : { topic: destination.id }), proposal: proposal(destination).proposal,
    }, anyId);
  });

  it.each([second.id, ":new"])("keeps the picked destination %s through typing and a reload", async (destination) => {
    const preview = vi.fn<Preview>().mockResolvedValue(proposal(first));
    const send = vi.fn<Props["send"]>().mockResolvedValue(true);
    await render(preview, send);
    await requestPreview();
    await choose(destination);
    await type("More to say");
    await requestPreview();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(picker().value).toBe(destination);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(preview, send);
    await requestPreview();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("More to say");
    expect(picker().value).toBe(destination);
    await submit();
    expect(send).toHaveBeenCalledWith("More to say", [], undefined, {
      ...(destination === ":new" ? { newTopic: true } : { topic: destination }), proposal: proposal(first).proposal,
    }, anyId);
    expect(field().value).toBe("");
  });

  it("sends an unassigned message when the first preview has yet to arrive", async () => {
    const preview = vi.fn<Preview>().mockReturnValue(Promise.withResolvers<StreamPreview>().promise);
    const send = vi.fn<Props["send"]>().mockResolvedValue(true);
    await render(preview, send);
    await type("Send without waiting");
    await requestPreview();
    expect(picker().hidden).toBe(true);
    expect(sendButton().disabled).toBe(false);
    await submit();
    expect(send).toHaveBeenCalledWith("Send without waiting", [], undefined, undefined, anyId);
  });

  it("keeps the draft and asks for a fresh preview after a stale topic is refused, and can send before it arrives", async () => {
    const fresh = Promise.withResolvers<StreamPreview>();
    const preview = vi.fn<Preview>().mockResolvedValueOnce(proposal(first)).mockReturnValue(fresh.promise);
    const send = vi.fn<Props["send"]>().mockResolvedValueOnce("stale").mockResolvedValueOnce("stale").mockResolvedValue(true);
    await render(preview, send);
    await requestPreview();
    await choose(second.id);
    await type("Keep this draft");
    await submit();
    expect(field().value).toBe("Keep this draft");
    expect(sendButton().disabled).toBe(false);
    await requestPreview();
    expect(preview).toHaveBeenLastCalledWith({ scope: dailyScope, text: "Keep this draft", attachmentNames: [] }, expect.any(AbortSignal));
    await submit();
    expect(send).toHaveBeenLastCalledWith("Keep this draft", [], undefined, undefined, anyId);
    await requestPreview();
    await act(async () => fresh.resolve(proposal(null)));
    await submit();
    expect(send).toHaveBeenLastCalledWith("Keep this draft", [], undefined, { newTopic: true, proposal: proposal(null).proposal }, anyId);
  });

  it("keeps quoted replies and topic messages on the direct send path", async () => {
    const preview = vi.fn<Preview>();
    const send = vi.fn<Props["send"]>().mockResolvedValue(true);
    await render(preview, send, { quote: { id: "quoted", text: "Previous message" } });
    await type("A reply");
    await requestPreview();
    expect(preview).not.toHaveBeenCalled();
    expect(picker()).toBeNull();
    await submit();
    expect(send).toHaveBeenLastCalledWith("A reply", [], "quoted", undefined, anyId);
    await render(preview, send, { routing: undefined });
    await type("Inside the topic");
    await submit();
    expect(send).toHaveBeenLastCalledWith("Inside the topic", [], undefined, undefined, anyId);
  });

  it("aborts a preview when the draft changes, when sending and when the composer goes away", async () => {
    const signals: AbortSignal[] = [];
    const preview = vi.fn<Preview>((_request, signal) => {
      signals.push(signal!);
      return Promise.withResolvers<StreamPreview>().promise;
    });
    await render(preview, async () => true);
    await type("First");
    await requestPreview();
    expect(signals.map(({ aborted }) => aborted)).toEqual([false]);
    await type("First and more");
    expect(signals.map(({ aborted }) => aborted)).toEqual([true]);
    await requestPreview();
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, false]);
    await submit();
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, true]);
    await requestPreview();
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, true, false]);
    await act(async () => root.unmount());
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, true, true]);
    root = createRoot(host);
  });

  it("keeps the draft and its id after a send that gets no answer, sends the same id again after a reload, and a new one for a changed draft", async () => {
    const preview = vi.fn<Preview>().mockReturnValue(Promise.withResolvers<StreamPreview>().promise);
    const send = vi.fn<Props["send"]>().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    await render(preview, send);
    await type("Did this arrive?");
    await submit();
    expect(field().value).toBe("Did this arrive?");
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().classList.contains("is-busy")).toBe(false);
    const first = send.mock.lastCall?.[4];
    expect(first).toEqual(anyId);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(preview, send);
    expect(field().value).toBe("Did this arrive?");
    await submit();
    expect(send.mock.lastCall?.[4]).toBe(first);
    await type("Did this arrive at all?");
    await submit();
    const changed = send.mock.lastCall?.[4];
    expect(changed).toEqual(anyId);
    expect(changed).not.toBe(first);
    expect(field().value).toBe("");
    await type("Did this arrive at all?");
    await submit();
    expect(send.mock.lastCall?.[4]).not.toBe(changed);
  });
});
