import type { IncomingMessage } from "node:http";
import { largestMessageBytes } from "@super-agent2/protocol";
import type { z } from "zod";

export function isJson(request: IncomingMessage): boolean {
  const type = request.headers["content-type"] ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export function readBody(request: IncomingMessage, limit: number = largestMessageBytes): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.on("end", () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(undefined));
  });
}

export function parseJson<Schema extends z.ZodType>(text: string | undefined, schema: Schema): z.output<Schema> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
