import type { BrainInput, Prepared, Provider, TopicBoardEntry } from "@super-agent2/protocol";
import type { PromptImage } from "@super-agent2/programs";
import { describeHistory, inputText, memoryPrompt, promptImages, withAttachments } from "./prompt.js";

export const defaultSoftShare = 0.15;
export const fallbackInputCapacity: Readonly<Record<Provider, number>> = { gpt: 128_000, claude: 200_000, deepseek: 128_000 };

const asciiCharactersPerToken: Readonly<Record<Provider, number>> = { gpt: 4, claude: 3, deepseek: 3 };

export function estimateTokens(text: string, provider: Provider): number {
  return Math.ceil(text.length / asciiCharactersPerToken[provider] + (Buffer.byteLength(text) - text.length) / 2);
}

interface PromptOptions {
  readonly conversation: string;
  readonly inputs: readonly BrainInput[];
  readonly prepared: Prepared;
  readonly provider: Provider;
  readonly capacity: number;
  readonly softShare: number;
  readonly attachments: string;
  readonly continuing?: boolean;
}

type Section = "quote" | "summary" | "history" | "memory" | "ticket" | "otherTicket" | "board" | "status";

interface Part {
  readonly section: Section;
  readonly text: string;
  readonly tokens: number;
  visible: boolean;
}

function boardTitle(entry: TopicBoardEntry): string {
  const title = entry.title || "(Untitled)";
  const project = entry.repository === null ? "" : ` [${entry.repository}]`;
  const state = entry.mergedInto !== null ? ` (merged into ${entry.mergedInto})` : (entry.state === "archived" ? " (archived)" : "");
  return `- ${entry.id} ${title}${project}${state}`;
}

export function topicPrompt(options: PromptOptions): { text: string; images: PromptImage[] } {
  const { conversation, inputs, prepared, provider, capacity, softShare, attachments } = options;
  const cost = (text: string) => estimateTokens(text, provider);
  const make = (section: Section, text: string): Part => ({ section, text, tokens: cost(text) + 1, visible: true });
  const quoteParts = inputs.flatMap(({ quote }) => quote === undefined ? [] : [{
    ...make("quote", `[hub] Quoted message ${quote.id}\n${describeHistory([quote.item], attachments, true)}`),
    quote,
  }]);
  const summary = prepared.seed?.summary ? make("summary", prepared.seed.summary) : undefined;
  const history = (prepared.seed?.turns ?? [prepared.history])
    .filter((items) => items.length > 0)
    .map((items) => make("history", describeHistory(items, attachments, true)));
  const memory = prepared.memory === null ? undefined : make("memory", memoryPrompt(prepared.memory));
  const tickets = (prepared.seed?.tickets ?? []).map(({ own, line }) => make(own ? "ticket" : "otherTicket", line));
  const board = (prepared.board ?? []).map((entry) => ({
    title: make("board", boardTitle(entry)),
    status: entry.status === "" ? undefined : make("status", ` — ${entry.status}`),
  }));

  const headings = {
    history: `[hub] Topic history (${conversation})`,
    summary: "[hub] Topic summary",
    tickets: "[hub] Open tickets",
    board: prepared.seed === undefined ? "[hub] Topic board changes" : "[hub] Topic board",
  };
  const input = options.continuing
    ? inputs.map((item) => `${item.source === "owner" ? "Owner" : "Hub notice"}: ${withAttachments(item.text, item.attachments, attachments)}`).join("\n\n")
    : inputText(inputs, attachments);
  const continuation = options.continuing
    ? "[hub] Another assistant was answering the owner and stopped because it became unavailable. Continue answering the latest input using the work already done. Do not repeat a command that already ran unless it needs to run again."
    : "";
  const parts = [...quoteParts, ...history, ...tickets, ...board.flatMap(({ title, status }) => status === undefined ? [title] : [title, status])];
  if (summary !== undefined) {
    parts.push(summary);
  }
  if (memory !== undefined) {
    parts.push(memory);
  }
  let remaining = parts.reduce((total, part) => total + part.tokens, 0);
  const omitted = new Map<Section, number>();
  omitted.set("history", prepared.seed?.olderTurns ?? 0);
  const omit = (part: Part) => {
    if (part.visible) {
      part.visible = false;
      remaining -= part.tokens;
      omitted.set(part.section, (omitted.get(part.section) ?? 0) + 1);
    }
  };

  const notes = () => {
    const lines: string[] = [];
    const add = (section: Section, label: string, tool: string) => {
      const count = omitted.get(section) ?? 0;
      if (count > 0) {
        lines.push(`[hub] ${count} ${label} omitted. Use ${tool}.`);
      }
    };
    for (const { visible, quote } of quoteParts) {
      if (!visible) {
        lines.push(`[hub] 1 quoted message omitted. Use read_topic_history with message="${quote.id}" to read it in parts.`);
      }
    }
    add("summary", "topic summary", `read_topic_history with topic="${conversation}" and summary=true`);
    add("history", "older history turn(s)", `read_topic_history with topic="${conversation}" and before to page back`);
    if (memory?.visible === false && prepared.memory !== null) {
      lines.push(`[hub] ${prepared.memory.memories.length} confirmed memory item(s) and ${prepared.memory.pending.length + prepared.memory.setAside.length} other memory record(s) omitted. Use read_seed_material with section="memory".`);
    }
    add("otherTicket", "other-topic ticket line(s)", 'read_seed_material with section="tickets"');
    add("ticket", "this topic's ticket line(s)", 'read_seed_material with section="tickets"');
    add("status", "topic board status line(s)", "read_topic_board");
    add("board", "topic board entry/entries", "read_topic_board");
    return lines;
  };

  const fixed = cost([continuation, input].filter(Boolean).join("\n\n"));
  const withHeading = (heading: string, content: readonly string[]) => content.length === 0 ? "" : [heading, ...content].join("\n");
  const render = () => [
    ...quoteParts.filter((part) => part.visible).map((part) => part.text),
    summary?.visible === true ? withHeading(headings.summary, [summary.text]) : "",
    withHeading(headings.history, history.filter((part) => part.visible).map((part) => part.text)),
    memory?.visible === true ? memory.text : "",
    withHeading(headings.tickets, tickets.filter((part) => part.visible).map((part) => part.text)),
    withHeading(headings.board, board.filter(({ title }) => title.visible)
      .map(({ title, status }) => title.text + (status?.visible === true ? status.text : ""))),
    ...notes(),
    continuation,
    input,
  ].filter(Boolean).join("\n\n");

  if (fixed > capacity) {
    throw new Error(`The current input exceeds the estimated ${capacity}-token input capacity.`);
  }
  for (const quote of quoteParts) {
    if (fixed + quote.tokens > capacity) {
      omit(quote);
    }
  }
  const soft = capacity * softShare;
  const quoteTokens = quoteParts.reduce((sum, part) => sum + (part.visible ? part.tokens : 0), 0);
  const trimHistory = fixed + quoteTokens + (history.at(-1)?.tokens ?? 0) <= soft;
  const overSoft = () => fixed + remaining + cost(Object.values(headings).join("\n") + notes().join("\n")) > soft;
  const softOrder = [
    ...board.flatMap(({ status }) => status === undefined ? [] : [status]),
    ...(trimHistory ? history.slice(0, -1) : []),
    ...tickets.filter(({ section }) => section === "otherTicket"),
    ...(memory === undefined ? [] : [memory]),
  ];
  for (const part of softOrder) {
    if (!overSoft()) {
      break;
    }
    omit(part);
  }
  let text = render();
  if (cost(text) > capacity) {
    const hardOrder = [...tickets, ...board.map(({ title }) => title), ...history, ...(summary === undefined ? [] : [summary]), ...quoteParts];
    const overhead = cost(Object.values(headings).join("\n"));
    for (const part of hardOrder) {
      omit(part);
      if (fixed + remaining + overhead + cost(notes().join("\n")) <= capacity) {
        break;
      }
    }
    text = render();
    if (cost(text) > capacity) {
      throw new Error(`The input and the references to omitted material exceed the estimated ${capacity}-token input capacity.`);
    }
  }
  const quotedImages = quoteParts.flatMap(({ visible, quote }) => visible && quote.item.kind === "owner" ? [quote.item] : []);
  return { text, images: promptImages([...inputs, ...quotedImages], attachments) };
}
