import { text } from "@super-agent2/catalog";
import type { QuestionAnswer, QuestionEntry } from "@super-agent2/protocol";
import { useState } from "react";
import { hubApi } from "../hub/api.js";
import { localQuestionAnswer } from "../live/question-answer.js";

export function QuestionCard({ entry }: { readonly entry: QuestionEntry }) {
  const [draft, setDraft] = useState<Readonly<Record<string, QuestionAnswer>>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [submitted, setSubmitted] = useState<readonly QuestionAnswer[] | null>(null);
  const resolved = entry.answer ?? (submitted === null ? null : localQuestionAnswer(submitted));
  const answers = entry.questions.map((question) => draft[question.id] ?? { question: question.id, options: [], text: "" });
  const ready = entry.questions.every((question, index) => !question.required || !!answers[index]?.text.trim() || (answers[index]?.options.length ?? 0) > 0);
  const update = (answer: QuestionAnswer) => setDraft((current) => ({ ...current, [answer.question]: answer }));
  const submit = async () => {
    if (!ready || busy || resolved !== null) return;
    setBusy(true);
    const result = await hubApi.answerQuestions(entry.conversation, entry.id, answers);
    setBusy(false);
    setFailed(!result.ok);
    if (result.ok) setSubmitted(answers.map((answer) => ({ ...answer, options: answer.text.trim() ? [] : answer.options, text: answer.text.trim() })));
  };
  return <div className="question-card">
    {entry.questions.map((question, index) => {
      const saved = resolved?.kind === "card" ? resolved.answers.find((answer) => answer.question === question.id) : undefined;
      const answer = saved ?? answers[index]!;
      return <fieldset key={question.id} disabled={busy || resolved !== null}>
        <legend>{`${index + 1}. ${question.prompt}`}{question.required ? ` · ${text("question.required")}` : ""}</legend>
        <div className="question-options">{question.options.map((option) => <label key={option.id} className="question-option">
          <input type={question.multiple ? "checkbox" : "radio"} name={`${entry.id}-${question.id}`} disabled={answer.text.trim() !== ""} checked={answer.options.includes(option.id)} onChange={(event) => update({ ...answer, options: question.multiple ? event.target.checked ? [...answer.options, option.id] : answer.options.filter((id) => id !== option.id) : [option.id] })} />
          <span>{option.label}{option.recommended ? ` · ${text("question.recommended")}` : ""}{option.detail ? <small>{option.detail}</small> : null}</span>
        </label>)}</div>
        <input className="field" value={answer.text} aria-label={`${question.prompt} ${text("question.answer")}`} placeholder={text("question.answer")} onChange={(event) => update({ ...answer, text: event.target.value, options: event.target.value.trim() ? [] : answer.options })} />
      </fieldset>;
    })}
    {resolved === null ? <button className="btn btn-primary" type="button" disabled={!ready || busy} onClick={() => void submit()}>{text("question.submit")}</button> : <p>{text(resolved.kind === "message" ? "question.byMessage" : "question.answered")}{resolved.kind === "message" ? `：${resolved.text}` : ""}</p>}
    {failed ? <p role="alert">{text("question.failed")}</p> : null}
  </div>;
}
