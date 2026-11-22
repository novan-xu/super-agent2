import { isAbsolute, join } from "node:path";
import { type BrainAttachment, type BrainInput, describeMemoryState, type HistoryItem, isNativeImage, type MemoryBrief, type MemoryChange, type Provider } from "@super-agent2/protocol";
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
    "An image (PNG, JPEG, GIF or WebP) of up to 20 MB is also shown to you with this message: look at it directly and answer from what you see, without a tool. Read any other attached file with your own tools at its path. To pass one on to a worker, give its attachment id (as material of a task ticket, or with message_worker); the file itself reaches the worker.",
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

export function describeHistory(history: readonly HistoryItem[], root: string = defaultAttachmentsFolder, verbatim = false): string {
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
          return `${speaker(item.provider)} used ${item.name} with ${verbatim ? item.input : clip(item.input, 2_000)}\nResult: ${verbatim ? item.output : clip(item.output)}`;
      }
    })
    .join("\n\n");
}

const routingRules: Readonly<Record<NonNullable<BrainInput["routing"]>["rule"], string>> = {
  a: "open question",
  e: "reference",
  b: "short reply",
  c: "similarity",
  d: "no confident match",
};

export function inputText(inputs: readonly BrainInput[], root: string = defaultAttachmentsFolder, withSpeakers = false): string {
  return inputs.map((input) => {
    const speaker = withSpeakers ? (input.source === "owner" ? "Owner: " : "Hub notice: ") : "";
    const text = `${speaker}${withAttachments(input.text, input.attachments, root)}`;
    const { routing } = input;
    if (routing === undefined) {
      return text;
    }
    const rule = routing.placement === "existing" && routing.repositoryCap === true ? "repository topic cap" : routingRules[routing.rule];
    const note = `[hub] Message ${input.entry ?? input.id} was routed here (${rule}, ${routing.placement} topic). Hand over only if it clearly belongs elsewhere. If unsure, answer here.`;
    const candidate = routing.placement === "new" ? routing.candidate : undefined;
    const lines = candidate === undefined ? [note] : [
      note,
      `[hub] Candidate ${candidate.id} ${JSON.stringify(candidate.title)}${candidate.summary === "" ? "" : ` — ${candidate.summary}`}`,
    ];
    return [...lines, text].join("\n");
  }).join("\n\n");
}

function changeLine(change: MemoryChange): string {
  const text = JSON.stringify(change.text);
  const memory = `#${change.memory ?? 0}`;
  if (change.by === "brain") {
    if (change.action === "suggested") {
      return change.memory === null
        ? `- You suggested in another conversation (suggestion ${change.suggestion ?? 0}): ${text}`
        : `- You suggested forgetting ${memory} in another conversation (suggestion ${change.suggestion ?? 0}).`;
    }
    return `- You ${change.action} ${memory} in another conversation: ${text}`;
  }
  switch (change.action) {
    case "added":
      return `- The owner added ${memory}: ${text}`;
    case "edited":
      return `- The owner edited ${memory}; it now reads: ${text}`;
    case "deleted":
      return change.suggestion === null
        ? `- The owner deleted ${memory}: ${text}`
        : `- The owner confirmed suggestion ${change.suggestion} and forgot ${memory}: ${text}`;
    case "replaced":
      return `- ${memory} was replaced when the owner confirmed suggestion ${change.suggestion ?? 0}: ${text}`;
    case "confirmed":
      return `- The owner confirmed suggestion ${change.suggestion ?? 0}; it is now ${memory}: ${text}`;
    case "declined":
      return change.memory === null
        ? `- The owner declined suggestion ${change.suggestion ?? 0}: ${text}`
        : `- The owner declined suggestion ${change.suggestion ?? 0} to forget ${memory}, and kept it.`;
    case "suggested":
      return `- Suggestion ${change.suggestion ?? 0}: ${text}`;
  }
}

export function memoryPrompt(brief: MemoryBrief): string {
  const state = describeMemoryState(brief);
  if (brief.first) {
    return [
      "[hub] Your memory: what the owner keeps for every conversation, in Chinese, exactly as the owner wrote or confirmed it in 记忆. Apply it without being asked. Only the owner changes it: remember and forget suggest a change, which waits in 记忆 until the owner confirms or declines it. This replaces any memory you were given before.",
      ...state,
      "[hub] End of your memory.",
    ].join("\n");
  }
  return [
    "[hub] Your memory changed since you last saw it. What the owner did is the owner's decision.",
    ...brief.changes.map(changeLine),
    "Now, replacing what you were given before:",
    ...state,
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
