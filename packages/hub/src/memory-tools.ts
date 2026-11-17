import { GeneratedText, type Memory, MemoryId, memoryChineseLength, memoryEnglishLength, memoryLimit, textForBrain } from "@super-agent2/protocol";
import { z } from "zod";
import type { MemoryService } from "./memories.js";

const RememberArguments = z.object({ id: MemoryId.optional(), text: GeneratedText });

const RecallArguments = z.object({});

const ForgetArguments = z.object({ id: MemoryId });

export function memoryDefinitions() {
  return [
    {
      name: "remember",
      title: "Remember something across conversations",
      description: [
        "Keep one lasting fact about the owner for every later conversation, whichever model answers: a preference the owner stated or corrected, a standing fact about the owner's projects or machines that no repository records, how the owner likes things reported.",
        "Not the state of current work, not what this conversation already holds, not what a repository or its issues say, and never a credential: a text that looks like a token, key or password is refused.",
        `One short sentence: at most ${memoryEnglishLength} characters in English, and the same in Simplified Chinese (at most ${memoryChineseLength} characters), which the owner reads and can edit or delete.`,
        `Give id to rewrite an existing memory instead of adding one. At most ${memoryLimit} memories are kept; when full, adding is refused until you forget one or merge two.`,
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1, description: "The memory to rewrite; leave out to add a new one" },
          text: {
            type: "object",
            properties: {
              en: { type: "string", description: "The memory in English, one short sentence" },
              zh: { type: "string", description: "The same memory in Simplified Chinese, for the owner" },
            },
            required: ["en", "zh"],
            additionalProperties: false,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "recall",
      title: "Read your memory",
      description: "List every memory with its id, who last wrote it (you or the owner) and when. Your memory is also given to you at the start of each conversation and whenever it changes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "forget",
      title: "Forget a memory",
      description: "Delete a memory that no longer holds or that another memory now covers. It cannot be undone.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer", minimum: 1, description: "The memory to forget" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];
}

function line(memory: Memory): string {
  const who = memory.by === "owner" ? (memory.stale ? "the owner, in Chinese; its English is out of date" : "the owner") : "you";
  return `#${memory.id} ${textForBrain(memory)} (last written by ${who}, ${new Date(memory.changedAt).toISOString()})`;
}

export function recallText(memories: readonly Memory[]): string {
  if (memories.length === 0) {
    return `Your memory is empty (0 of ${memoryLimit}).`;
  }
  const ordered = [...memories].sort((a, b) => a.id - b.id);
  return [`Your memory (${memories.length} of ${memoryLimit}):`, ...ordered.map(line)].join("\n");
}

export interface MemoryToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

export function memoryCall(memories: MemoryService, name: string, raw: unknown, conversation: string | undefined): MemoryToolResult | undefined {
  const invalid = (error: z.ZodError): MemoryToolResult => ({ text: `The arguments are not valid: ${error.message}`, isError: true });
  switch (name) {
    case "remember": {
      const parsed = RememberArguments.safeParse(raw);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      const outcome = memories.remember({ ...(parsed.data.id === undefined ? {} : { id: parsed.data.id }), text: parsed.data.text, conversation: conversation ?? null });
      if (!outcome.ok) {
        return { text: outcome.reason, isError: true };
      }
      return {
        text: `${outcome.added ? "Remembered" : "Rewrote"} #${outcome.memory.id} (${outcome.count} of ${memoryLimit}). The owner sees it in 记忆 and can edit or delete it. Tell the owner in a few words what you remembered.`,
      };
    }
    case "recall": {
      const parsed = RecallArguments.safeParse(raw);
      return parsed.success ? { text: recallText(memories.list()) } : invalid(parsed.error);
    }
    case "forget": {
      const parsed = ForgetArguments.safeParse(raw);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      const outcome = memories.forget(parsed.data.id, conversation ?? null);
      return outcome.ok ? { text: `Forgot #${outcome.memory.id} (${outcome.count} of ${memoryLimit} kept).` } : { text: outcome.reason, isError: true };
    }
    default:
      return undefined;
  }
}
