import { z } from "zod";

export const GeneratedText = z.object({
  en: z.string().trim().min(1),
  zh: z
    .string()
    .trim()
    .min(1)
    .refine((value) => /\p{Script=Han}/u.test(value), { message: "The Chinese copy must contain Chinese" }),
});

export type GeneratedText = z.infer<typeof GeneratedText>;

export function chineseOf(text: GeneratedText): string {
  return text.zh;
}
