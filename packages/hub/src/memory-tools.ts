import { describeMemoryState, MemoryId, MemoryScope, principleLimit } from "@super-agent2/protocol";
import { z } from "zod";
import type { MemoryService, Refusal } from "./memories.js";

const RememberArguments = z.object({ text: z.string(), replaces: z.array(MemoryId).optional(), ownerAsked: z.boolean().optional(), scope: MemoryScope.optional() });

const PrincipleArguments = z.object({ text: z.string().trim().min(1).max(principleLimit) }).strict();

const RecallArguments = z.object({});

const ForgetArguments = z.object({ id: MemoryId, ownerAsked: z.boolean().optional() });

const ownerAskedDescription =
  "True only for an explicit owner request to revisit a declined, deleted or kept memory.";

export function memoryDefinitions(memories: MemoryService) {
  return [
    {
      name: "remember",
      title: "Suggest a memory",
      description: "Suggest a lasting memory for the owner's confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The memory, in Simplified Chinese" },
          replaces: { type: "array", items: { type: "integer", minimum: 1 }, description: "The memories this one replaces once the owner confirms it" },
          ownerAsked: { type: "boolean", description: ownerAskedDescription },
          ...(memories.sharing() ? { scope: { type: "string", enum: MemoryScope.options, description: "Use general only for an owner preference useful across installations. Keep project details, company work and identifying information local. Defaults to local." } } : {}),
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "recall",
      title: "Read your memory",
      description: "Read memory IDs, pending suggestions and past declines or deletions.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "forget",
      title: "Suggest forgetting a memory",
      description: "Suggest removing a memory for the owner's confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1, description: "The memory to forget" },
          ownerAsked: { type: "boolean", description: ownerAskedDescription },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    ...(memories.canProposePrinciples ? [{
      name: "propose_principle",
      title: "Propose a general engineering principle",
      description: "Draft a cross-project rule for the Super Agent development standard. Use only after discussing the rule with the owner. Summarize the principle without company names, code, data or ticket details. The owner must approve sending it in 记忆.",
      inputSchema: z.toJSONSchema(PrincipleArguments, { io: "input" }),
    }] : []),
  ];
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export const credentialRefusal =
  "Refused: this looks like a credential (a token, a key, a password or a secret value). A memory never holds a credential; the hub keeps them. Suggest where a credential is used, never its value.";

export function refusalText(refusal: Refusal): string {
  const again = "Do not suggest it again unless the owner asks for it; when the owner does, call again with ownerAsked true.";
  switch (refusal.kind) {
    case "empty":
      return "Refused: the text is empty.";
    case "chinese":
      return "Refused: a memory is written in Simplified Chinese, the language the owner reads it in. Names and technical terms may stay as they are.";
    case "credential":
      return credentialRefusal;
    case "unknown":
      return `Refused: there is no memory #${refusal.memory}. Use the ids in your memory below.`;
    case "memory":
      return `Refused: memory #${refusal.memory.id} already says this: ${JSON.stringify(refusal.memory.text)}. There is nothing to suggest.`;
    case "pending":
      return refusal.suggestion.kind === "forget"
        ? `Refused: suggestion ${refusal.suggestion.id} already suggests forgetting #${refusal.suggestion.memory ?? 0}, and waits for the owner.`
        : `Refused: suggestion ${refusal.suggestion.id}, still waiting for the owner, already says this: ${JSON.stringify(refusal.suggestion.text)}.`;
    case "declined":
      return `Refused: the owner declined this on ${day(refusal.at)}: ${JSON.stringify(refusal.text)}. ${again}`;
    case "deleted":
      return `Refused: the owner deleted this memory (#${refusal.memory}) on ${day(refusal.at)}: ${JSON.stringify(refusal.text)}. ${again}`;
    case "kept":
      return `Refused: the owner kept #${refusal.memory.id} on ${day(refusal.at)} when you suggested forgetting it. ${again}`;
  }
}

export function recallText(memories: MemoryService): string {
  return describeMemoryState(memories.state()).join("\n");
}

export interface MemoryToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

export function memoryCall(memories: MemoryService, name: string, raw: unknown, conversation: string | undefined): MemoryToolResult | undefined {
  const invalid = (error: z.ZodError): MemoryToolResult => ({ text: `The arguments are not valid: ${error.message}`, isError: true });
  const withState = (text: string, isError = false): MemoryToolResult => ({ text: `${text}\n\n${recallText(memories)}`, ...(isError ? { isError } : {}) });
  switch (name) {
    case "remember": {
      const parsed = RememberArguments.safeParse(raw);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      const outcome = memories.remember({
        text: parsed.data.text,
        ...(parsed.data.replaces === undefined ? {} : { replaces: parsed.data.replaces }),
        ...(parsed.data.ownerAsked === undefined ? {} : { ownerAsked: parsed.data.ownerAsked }),
        ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
        conversation: conversation ?? null,
      });
      if (!outcome.ok) {
        return withState(refusalText(outcome.refusal), true);
      }
      return withState(
        `Suggested (suggestion ${outcome.suggestion.id}). It waits in 记忆 for the owner to confirm or decline; nothing is remembered until the owner confirms. Tell the owner in a few words what you suggested.`,
      );
    }
    case "propose_principle": {
      if (!memories.canProposePrinciples || conversation === undefined) return { text: "A local peer and an active conversation are required.", isError: true };
      const parsed = PrincipleArguments.safeParse(raw);
      if (!parsed.success) return { text: `Give a short engineering principle of at most ${principleLimit} characters.`, isError: true };
      const outcome = memories.proposePrinciple(parsed.data.text, conversation);
      return outcome.ok
        ? { text: "The draft waits in 记忆 for the owner to approve sending it to the NAS. Tell the owner where to review it." }
        : { text: refusalText(outcome.refusal), isError: true };
    }
    case "recall": {
      const parsed = RecallArguments.safeParse(raw);
      return parsed.success ? { text: recallText(memories) } : invalid(parsed.error);
    }
    case "forget": {
      const parsed = ForgetArguments.safeParse(raw);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      const outcome = memories.forget({ id: parsed.data.id, ...(parsed.data.ownerAsked === undefined ? {} : { ownerAsked: parsed.data.ownerAsked }), conversation: conversation ?? null });
      if (!outcome.ok) {
        return withState(refusalText(outcome.refusal), true);
      }
      return withState(
        `Suggested forgetting #${parsed.data.id} (suggestion ${outcome.suggestion.id}). The memory stays until the owner confirms in 记忆. Tell the owner in a few words what you suggested.`,
      );
    }
    default:
      return undefined;
  }
}
