import { type BrainInput, describeMemoryState, type HistoryItem, type MemoryBrief, type MemoryChange, type Provider } from "@super-agent2/protocol";

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
