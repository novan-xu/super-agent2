import type { QuestionAnswer } from "@super-agent2/protocol";

export function localQuestionAnswer(answers: readonly QuestionAnswer[]) {
  return { kind: "card" as const, answers };
}
