import { z } from "zod";
import type { MemoryService } from "./memories.js";
import type { TopicContext } from "./topic-context.js";

const id = z.string().min(1);
const chunk = {
  offset: z.number().int().nonnegative().default(0).describe("Start at this character offset"),
  length: z.number().int().min(1).max(12_000).default(4_000).describe("Maximum characters to return"),
};
const page = {
  before: z.number().int().positive().default(Number.MAX_SAFE_INTEGER).describe("Return results before this stream position"),
  limit: z.number().int().min(1).max(50).default(15),
};
const Board = z.object(chunk);
const History = z.object({
  topic: id.optional().describe("Topic ID, defaulting to the current topic"),
  message: id.optional().describe("Read this specific message in full, one part at a time"),
  summary: z.boolean().optional().describe("Read the topic summary, one part at a time"),
  ...page,
  ...chunk,
});
const Search = z.object({ query: z.string().trim().min(1), topic: id.optional(), ...page });
const Material = z.object({
  section: z.enum(["memory", "tickets"]),
  topic: id.optional().describe("List this topic's tickets first, defaulting to the current topic"),
  ...chunk,
});

export function topicDefinitions() {
  return [
    {
      name: "read_topic_board",
      description: "Read topic IDs, titles, project names, status lines, archive states and merge destinations. Continue using nextOffset.",
      inputSchema: z.toJSONSchema(Board, { io: "input" }),
    },
    {
      name: "read_topic_history",
      description: "Read a topic's recent message references. Continue using before, or pass a message ID to read it in parts. Set summary to read the topic summary in parts. Continue reading parts using nextOffset.",
      inputSchema: z.toJSONSchema(History, { io: "input" }),
    },
    {
      name: "search_topic_history",
      description: "Search recorded messages and tool results by literal text across all topics, including archived topics. Continue using before.",
      inputSchema: z.toJSONSchema(Search, { io: "input" }),
    },
    {
      name: "read_seed_material",
      description: "Read the complete shared memory or open ticket lines when omitted from the seed. Continue using nextOffset.",
      inputSchema: z.toJSONSchema(Material, { io: "input" }),
    },
  ];
}

function part(text: string, { offset, length }: { offset: number; length: number }) {
  const characters = Array.from(text);
  const end = offset + length;
  return { text: characters.slice(offset, end).join(""), nextOffset: end < characters.length ? end : null };
}

export function topicCall(topics: TopicContext, memories: MemoryService | undefined, name: string, raw: unknown, conversation: string | undefined) {
  const output = (value: unknown) => ({ text: JSON.stringify(value) });
  const error = (text: string) => ({ text, isError: true });
  switch (name) {
    case "read_topic_board": {
      const parsed = Board.safeParse(raw);
      if (!parsed.success) {
        return error(parsed.error.message);
      }
      const board = topics.board().map(({ revision: _, ...entry }) => entry);
      return output(part(JSON.stringify(board, null, 2), parsed.data));
    }
    case "read_topic_history": {
      const parsed = History.safeParse(raw);
      if (!parsed.success) {
        return error(parsed.error.message);
      }
      const args = parsed.data;
      if (args.message !== undefined) {
        const message = topics.message(args.message);
        return message === undefined ? error("No such message.") : output(part(JSON.stringify(message, null, 2), args));
      }
      const topic = args.topic ?? conversation;
      if (topic === undefined) {
        return error("Supply a topic ID from read_topic_board.");
      }
      return output(args.summary === true ? part(topics.summary(topic), args) : topics.recent(topic, args.before, args.limit));
    }
    case "search_topic_history": {
      const parsed = Search.safeParse(raw);
      if (!parsed.success) {
        return error(parsed.error.message);
      }
      const { query, topic, before, limit } = parsed.data;
      return output(topics.search(query, topic ?? null, before, limit));
    }
    case "read_seed_material": {
      const parsed = Material.safeParse(raw);
      if (!parsed.success) {
        return error(parsed.error.message);
      }
      const args = parsed.data;
      const material = args.section === "memory" ? memories?.state() ?? null : topics.tickets(args.topic ?? conversation ?? null).map(({ line }) => line);
      return output(part(JSON.stringify(material, null, 2), args));
    }
    default:
      return undefined;
  }
}
