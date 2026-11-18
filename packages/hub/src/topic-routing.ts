import { type HubToBrain, openTicketStates, type RouteChoice, type RouteRequest, routeFits, topicInScope, type TopicScope } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";

const Topic = z.object({ id: z.string(), title: z.string(), repository: z.string().nullable(), board_status: z.string() });
const Recent = z.object({ kind: z.enum(["owner", "text"]), text: z.string() });
const Ticket = z.object({ id: z.number().int().positive(), repository: z.string(), title: z.string() });
const Issue = z.object({ number: z.number().int().positive() });
const routingWait = 5_000;

export function topicRouter({ connection }: HubDatabase, send: (message: HubToBrain) => boolean) {
  const listTopics = connection.prepare(`
    SELECT id, title, repository, needs_repository, board_status FROM conversations
    WHERE topic_state = 'active' AND merged_into IS NULL ORDER BY updated_at DESC, rowid DESC
  `);
  const recent = connection.prepare(`
    SELECT kind, substr(json_extract(body, '$.text'), 1, 320) AS text
    FROM conversation_entries WHERE conversation_id = ? AND kind IN ('owner', 'text') ORDER BY seq DESC LIMIT 3
  `);
  const openTickets = connection.prepare(`
    SELECT id, repository, substr(title_zh, 1, 120) AS title FROM tickets
    WHERE repository IS NOT NULL AND joined_into IS NULL AND state IN (${openTicketStates.map(() => "?").join(", ")})
    ORDER BY updated_at DESC, id DESC
  `);
  const ticketIssues = connection.prepare("SELECT number FROM ticket_issues WHERE ticket_id = ? ORDER BY position");
  const pending = new Map<string, (choice: RouteChoice | null) => void>();

  return {
    route: (request: string, scope: TopicScope, message: string, files: string[]): Promise<RouteChoice | null> => {
      const topics = listTopics.all().flatMap((row) => {
        const { board_status: status, ...topic } = Topic.parse(row);
        if (!topicInScope({ ...topic, needsRepository: row["needs_repository"] === 1 ? true : undefined }, scope)) {
          return [];
        }
        const messages = (status === "" ? recent.all(topic.id).reverse() : []).map((entry): RouteRequest["topics"][number]["recent"][number] => {
          const item = Recent.parse(entry);
          return { speaker: item.kind === "owner" ? "owner" : "assistant", text: item.text };
        });
        return [{ ...topic, ...(status === "" ? {} : { status }), recent: messages }];
      });
      const repositories = new Map<string, string>();
      const tickets: RouteRequest["tickets"] = [];
      if (scope.kind === "code") {
        for (const row of openTickets.all(...openTicketStates)) {
          const ticket = Ticket.parse(row);
          const issues = ticketIssues.all(ticket.id).map((issue) => Issue.parse(issue).number);
          tickets.push({ ...ticket, issues });
        }
        for (const { repository } of [...topics, ...tickets]) {
          if (repository !== null) {
            repositories.set(repository.toLowerCase(), repository);
          }
        }
      }
      const text = message.length <= 8_000 ? message : `${message.slice(0, 6_000)}\n[... clipped for routing ...]\n${message.slice(-2_000)}`;
      const input: RouteRequest = { type: "route", request, scope, topics, repositories: [...repositories.values()], tickets, text, files };
      return new Promise((resolve) => {
        const finish = (choice: RouteChoice | null) => {
          clearTimeout(timer);
          pending.delete(request);
          if (choice !== null && routeFits(input, choice)) {
            if (choice.kind === "new" && choice.repository != null) {
              const repository = scope.kind === "repository" ? scope.repository : repositories.get(choice.repository.toLowerCase());
              resolve({ ...choice, repository });
            } else {
              resolve(choice);
            }
          } else {
            resolve(null);
          }
        };
        const timer = setTimeout(() => finish(null), routingWait);
        pending.set(request, finish);
        if (!send(input)) {
          finish(null);
        }
      });
    },
    answer: (request: string, choice: RouteChoice | null) => pending.get(request)?.(choice),
    disconnect: () => {
      for (const finish of pending.values()) {
        finish(null);
      }
    },
  };
}
