import type { QuestionEntry } from "@super-agent2/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuestionCard } from "./QuestionCard.js";

const card: QuestionEntry = { id: "card", conversation: "topic", seq: 1, at: 1, kind: "question", turn: "turn", answer: null, questions: [
  { id: "first", prompt: "选择范围", required: true, multiple: false, options: [{ id: "a", label: "甲", recommended: true }, { id: "b", label: "乙" }] },
  { id: "second", prompt: "选择附加项", required: false, multiple: true, options: [{ id: "x", label: "一" }, { id: "y", label: "二", detail: "说明" }] },
] };

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

  it("shows the submitted answer without an active submit", () => {
    const answered: QuestionEntry = { ...card, answer: { kind: "card", answers: [{ question: "first", options: [], text: "自定义" }] } };
    const html = renderToStaticMarkup(<QuestionCard entry={answered} />);
    expect(html).toContain("自定义");
    expect(html).toContain("已回答");
    expect(html).not.toContain(">提交</button>");
  });
  it("shows an ordinary message as the answer and locks the card", () => {
    const answered: QuestionEntry = { ...card, answer: { kind: "message", text: "另一种方案" } };
    const html = renderToStaticMarkup(<QuestionCard entry={answered} />);
    expect(html).toContain("已通过消息回答：另一种方案");
    expect(html).not.toContain(">提交</button>");
  });

});
