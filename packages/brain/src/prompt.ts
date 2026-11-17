import type { BrainInput, BrainMemory, HistoryItem, MemoryBrief, MemoryChange, Provider } from "@super-agent2/protocol";

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

export function describeHistory(history: readonly HistoryItem[]): string {
  return history
    .map((item) => {
      switch (item.kind) {
        case "owner":
          return `Owner: ${item.text}`;
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

export function inputText(inputs: readonly BrainInput[]): string {
  return inputs.map((input) => input.text).join("\n\n");
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

export function turnPrompt(history: readonly HistoryItem[], inputs: readonly BrainInput[], memory: MemoryBrief | null = null): string {
  if (history.length === 0) {
    return withMemory(memory, [inputText(inputs)]);
  }
  return withMemory(memory, [
    "[hub] Other assistants handled part of this conversation while you were unavailable. This is what happened since you last took part:",
    describeHistory(history),
    "[hub] End of the earlier conversation. The owner's new message follows.",
    inputText(inputs),
  ]);
}

export function continuationPrompt(history: readonly HistoryItem[], memory: MemoryBrief | null = null): string {
  return withMemory(memory, [
    "[hub] Another assistant was answering the owner and stopped because it became unavailable. This is what happened since you last took part, ending with the owner's latest message and the work done on it so far:",
    describeHistory(history),
    "[hub] Continue from here: finish answering the owner's latest message. Do not repeat a command that already ran unless it needs to run again.",
  ]);
}
