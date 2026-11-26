import { z } from "zod";

export const checkFile = ".superagent2/check.json";
export const checkCommand = z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f\u0085\u2028\u2029]+$/u).refine((command) => command.trim().length > 0);
const declaration = z.strictObject({ command: checkCommand });

export function readCheck(text: string): string | undefined {
  if (text.length > 8192) return undefined;
  try {
    const parsed = declaration.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.command : undefined;
  } catch {
    return undefined;
  }
}
