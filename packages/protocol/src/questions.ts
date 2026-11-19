import { z } from "zod";

const identifier = z.string().trim().min(1).max(80);
export const QuestionOption = z.object({ id: identifier, label: z.string().trim().min(1).max(200), detail: z.string().trim().max(500).optional(), recommended: z.boolean().optional() });
export const Question = z.object({ id: identifier, prompt: z.string().trim().min(1).max(500), options: z.array(QuestionOption).min(2).max(12), multiple: z.boolean().default(false), required: z.boolean().default(false) }).refine((question) => new Set(question.options.map((option) => option.id)).size === question.options.length && question.options.filter((option) => option.recommended).length <= 1, "Options must have unique IDs and at most one recommendation");
export const Questions = z.array(Question).min(1).max(12).refine((questions) => new Set(questions.map((question) => question.id)).size === questions.length, "Questions must have unique IDs");
export const QuestionAnswer = z.object({ question: identifier, options: z.array(identifier).max(12), text: z.string().trim().max(4000) });
export const QuestionAnswers = z.array(QuestionAnswer).max(12);
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;
export type Question = z.infer<typeof Question>;
