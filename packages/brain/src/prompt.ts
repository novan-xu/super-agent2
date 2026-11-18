import { isAbsolute, join } from "node:path";
import { type BrainAttachment, type BrainInput, type BrainMemory, type HistoryItem, isNativeImage, type MemoryBrief, type MemoryChange, type Provider } from "@super-agent2/protocol";
import type { PromptImage } from "@super-agent2/programs";

export const historyItemLimit = 4_000;

const names: Readonly<Record<Provider, string>> = { gpt: "GPT", claude: "Claude", deepseek: "DeepSeek" };

function clip(text: string, limit: number = historyItemLimit): string {
  if (text.length <= limit) {
    return text;
  }
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n[... ${text.length - limit} characters omitted ...]\n${text.slice(text.length - half)}`;
}

function speaker(provider: Provider | null): string {
  return provider === null ? "Assistant" : `Assistant (${names[provider]})`;
}

export const defaultAttachmentsFolder = "/var/lib/superagent2/link/attachments";

export function attachmentPath(root: string, attachment: Pick<BrainAttachment, "path">): string {
  const parts = attachment.path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") || isAbsolute(attachment.path)) {
    throw new Error(`The attachment path ${attachment.path} is not a plain relative path`);
  }
  return join(root, ...parts);
}

function attachmentLines(attachments: readonly BrainAttachment[], root: string): string[] {
  if (attachments.length === 0) {
    return [];
  }
  return [
    `[hub] The owner attached ${attachments.length === 1 ? "a file" : `${attachments.length} files`} to this message:`,
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mediaType}, ${attachment.size} bytes), attachment id ${attachment.id}, at ${attachmentPath(root, attachment)}`,
    ),
    "Images are also shown to you with the message when your program can take them. Read any attached file with your own tools at its path. To pass one on to a worker, give its attachment id (as material of a writing ticket, or with message_worker); the file itself reaches the worker.",
  ];
}

export function withAttachments(text: string, attachments: readonly BrainAttachment[], root: string): string {
  const lines = attachmentLines(attachments, root);
  return lines.length === 0 ? text : [text, ...lines].filter((part) => part !== "").join("\n");
}

export function promptImages(inputs: readonly Pick<BrainInput, "attachments">[], root: string): PromptImage[] {
  return inputs.flatMap((input) =>
    input.attachments
      .filter((attachment) => isNativeImage(attachment.mediaType))
      .map((attachment) => ({ path: attachmentPath(root, attachment), mediaType: attachment.mediaType, size: attachment.size })),
  );
}

export function describeHistory(history: readonly HistoryItem[], root: string = defaultAttachmentsFolder): string {
  return history
    .map((item) => {
      switch (item.kind) {
        case "owner":
          return `Owner: ${withAttachments(item.text, item.attachments, root)}`;
        case "notice":
          return `Hub notice: ${item.text}`;
        case "text":
          return `${speaker(item.provider)}: ${item.text}`;
        case "tool":
          return `${speaker(item.provider)} used ${item.name} with ${clip(item.input, 2_000)}\nResult: ${clip(item.output)}`;
      }
    })
    .join("\n\n");
}

export function inputText(inputs: readonly BrainInput[], root: string = defaultAttachmentsFolder): string {
  return inputs.map((input) => withAttachments(input.text, input.attachments, root)).join("\n\n");
}

function memoryLine(memory: BrainMemory): string {
  return memory.ownerWords ? `- #${memory.id} (the owner's own words, in Chinese) ${memory.text}` : `- #${memory.id} ${memory.text}`;
}

const actionWords: Readonly<Record<MemoryChange["action"], string>> = {
  remembered: "added",
  rewritten: "rewrote",
  edited: "edited",
  deleted: "deleted",
};

function changeLine(change: MemoryChange): string {
  if (change.by === "owner") {
    return change.action === "deleted"
      ? `- The owner deleted #${change.id}: ${change.text} Do not remember it again unless the owner asks.`
      : `- The owner edited #${change.id}; it now reads, in Chinese: ${change.text} Follow it. Then call remember with id ${change.id} to write its English to match, keeping the owner's Chinese exactly as it is.`;
  }
  return `- You ${actionWords[change.action]} #${change.id} in another conversation: ${change.text}`;
}

export function memoryPrompt(brief: MemoryBrief): string {
  const list = brief.memories.length === 0 ? ["(empty)"] : brief.memories.map(memoryLine);
  if (brief.first) {
    return [
      `[hub] Your memory: what you have learned about the owner across conversations (${brief.memories.length} of ${brief.limit}). Apply it without being asked. The owner reads and corrects it in 记忆; recall, remember and forget change it.`,
      ...list,
      "[hub] End of your memory.",
    ].join("\n");
  }
  return [
    "[hub] Your memory changed since you last saw it. What the owner changed is the owner's decision.",
    ...brief.changes.map(changeLine),
    `Your memory is now (${brief.memories.length} of ${brief.limit}), replacing what you were given before:`,
    ...list,
    "[hub] End of your memory.",
  ].join("\n");
}

function withMemory(memory: MemoryBrief | null, parts: readonly string[]): string {
  return (memory === null ? parts : [memoryPrompt(memory), ...parts]).join("\n\n");
}

export function turnPrompt(
  history: readonly HistoryItem[],
  inputs: readonly BrainInput[],
  memory: MemoryBrief | null = null,
  root: string = defaultAttachmentsFolder,
): string {
  if (history.length === 0) {
    return withMemory(memory, [inputText(inputs, root)]);
  }
  return withMemory(memory, [
    "[hub] Other assistants handled part of this conversation while you were unavailable. This is what happened since you last took part:",
    describeHistory(history, root),
    "[hub] End of the earlier conversation. The owner's new message follows.",
    inputText(inputs, root),
  ]);
}

export function continuationPrompt(history: readonly HistoryItem[], memory: MemoryBrief | null = null, root: string = defaultAttachmentsFolder): string {
  return withMemory(memory, [
    "[hub] Another assistant was answering the owner and stopped because it became unavailable. This is what happened since you last took part, ending with the owner's latest message and the work done on it so far:",
    describeHistory(history, root),
    "[hub] Continue from here: finish answering the owner's latest message. Do not repeat a command that already ran unless it needs to run again.",
  ]);
}
