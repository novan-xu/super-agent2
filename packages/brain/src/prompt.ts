import type { BrainInput, HistoryItem, Provider } from "@super-agent2/protocol";

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

export function turnPrompt(history: readonly HistoryItem[], inputs: readonly BrainInput[]): string {
  if (history.length === 0) {
    return inputText(inputs);
  }
  return [
    "[hub] Other assistants handled part of this conversation while you were unavailable. This is what happened since you last took part:",
    describeHistory(history),
    "[hub] End of the earlier conversation. The owner's new message follows.",
    inputText(inputs),
  ].join("\n\n");
}

export function continuationPrompt(history: readonly HistoryItem[]): string {
  return [
    "[hub] Another assistant was answering the owner and stopped because it became unavailable. This is what happened since you last took part, ending with the owner's latest message and the work done on it so far:",
    describeHistory(history),
    "[hub] Continue from here: finish answering the owner's latest message. Do not repeat a command that already ran unless it needs to run again.",
  ].join("\n\n");
}
