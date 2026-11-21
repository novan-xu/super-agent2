import type { QuestionEntry, StreamEntry } from "@super-agent2/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubApi } from "../hub/api.js";
import { initialTopicStream } from "../live/topic-stream.js";
import { TopicStream } from "./ConversationView.js";
import { QuestionCard } from "./QuestionCard.js";

const card: QuestionEntry = { id: "card", conversation: "topic", seq: 1, at: 1, kind: "question", turn: "turn", answer: null, questions: [
  { id: "first", prompt: "选择范围", required: true, multiple: false, options: [{ id: "a", label: "甲", recommended: true }, { id: "b", label: "乙" }] },
  { id: "second", prompt: "选择附加项", required: false, multiple: true, options: [{ id: "x", label: "一" }, { id: "y", label: "二", detail: "说明" }] },
] };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function submit() {
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".question-card button")!.click());
}

describe("question cards", () => {
  it("shows all questions, options and text fields together with one submit", () => {
    const html = renderToStaticMarkup(<QuestionCard entry={card} />);
    expect(html).toContain("选择范围");
    expect(html).toContain("选择附加项");
    expect(html).toContain("说明");
    expect(html).toContain("建议");
    expect(html.match(/自己写…/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html.match(/>提交<\/button>/g)).toHaveLength(1);
  });

  it("removes the question and its topic label as soon as the submit succeeds", async () => {
    const answer = vi.spyOn(hubApi, "answerQuestions").mockResolvedValue({ ok: true, value: { entry: {
      id: "answer", conversation: card.conversation, seq: 2, at: card.at, kind: "owner", text: "选择范围：甲", attachments: [], taken: false,
    } } });
    const item: StreamEntry = { position: 1, entry: card, topic: { id: card.conversation, title: "Topic", repository: "owner/repo" } };
    await act(async () => root.render(<TopicStream streamKey="code" state={null} stream={{ ...initialTopicStream, entries: [item] }} scope={{ kind: "code" }} list={[]} online now={card.at}
      following={{ current: true }} hrefOf={() => "#"} open={() => undefined} loadOlder={() => undefined} selectQuote={() => undefined} move={async () => false} openEdit={() => undefined} />));
    expect(host.querySelector("#entry-card .topic-label")?.textContent).toContain("Topic");
    await submit();
    expect(answer).toHaveBeenCalledWith(card.conversation, card.id, [{ question: "first", options: ["a"], text: "" }, { question: "second", options: [], text: "" }]);
    expect(host.querySelector("#entry-card")).toBeNull();
    expect(host.querySelector(".day")).toBeNull();
  });

  it("shows the error and keeps the selected answer available for retry", async () => {
    vi.spyOn(hubApi, "answerQuestions").mockResolvedValue({ ok: false, error: "network" });
    await act(async () => root.render(<QuestionCard entry={card} />));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("提交失败，请刷新后重试");
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".question-card button")?.disabled).toBe(false);
  });

});
