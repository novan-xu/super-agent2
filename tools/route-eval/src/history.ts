import { DatabaseSync } from "node:sqlite";

export interface OwnerMessage {
  readonly id: string;
  readonly at: number;
  readonly text: string;
  readonly scope: string;
  readonly group: string | null;
  readonly explicit: boolean;
  readonly routed: boolean;
  readonly origin: string;
}

export interface Reply {
  readonly id: string;
  readonly at: number;
  readonly text: string;
  readonly about: string;
  readonly asks: boolean;
  readonly card: boolean;
}

export interface History {
  readonly name: string;
  readonly messages: readonly OwnerMessage[];
  readonly replies: readonly Reply[];
}

type Row = Record<string, unknown>;

function open(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function number(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value);
}

export function endsWithQuestion(value: string): boolean {
  const lines = value.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const last = lines.at(-1) ?? "";
  return /[?？]\s*[)）】"”'*_`]*$/.test(last) || /[?？]/.test(last.slice(-40));
}

export function isCardAction(value: string): boolean {
  const trimmed = value.trim();
  return /^(开始|仍然开始|编排)[：:]/.test(trimmed) || trimmed === "开始所选" || trimmed === "全部开始";
}

function byTime<T extends { readonly at: number; readonly id: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.at - right.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function readSuperAgent2(path: string): History {
  const database = open(path);
  const merges = new Map<string, string>();
  for (const row of database.prepare("SELECT id, merged_into FROM conversations WHERE merged_into IS NOT NULL").all() as Row[]) {
    merges.set(text(row, "id"), text(row, "merged_into"));
  }
  const root = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    while (merges.has(current) && !seen.has(current)) {
      seen.add(current);
      current = merges.get(current)!;
    }
    return current;
  };
  const scopes = new Map<string, string>();
  for (const row of database.prepare("SELECT id, repository, needs_repository FROM conversations").all() as Row[]) {
    const repository = row["repository"];
    scopes.set(text(row, "id"), typeof repository === "string" || number(row, "needs_repository") === 1 ? "code" : "daily");
  }
  const entries = database
    .prepare(`
      SELECT id, conversation_id, seq, kind, body, created_at FROM conversation_entries
      WHERE kind IN ('owner', 'text', 'question') ORDER BY created_at, conversation_id, seq
    `)
    .all() as Row[];
  const messages: OwnerMessage[] = [];
  const replies: Reply[] = [];
  const lastOwner = new Map<string, string>();
  for (const row of entries) {
    const conversation = text(row, "conversation_id");
    const body = JSON.parse(text(row, "body")) as Record<string, unknown>;
    const id = text(row, "id");
    const at = number(row, "created_at");
    const kind = text(row, "kind");
    if (kind === "owner") {
      const value = typeof body["text"] === "string" ? body["text"] : "";
      const attachments = Array.isArray(body["attachments"]) ? (body["attachments"] as Array<Record<string, unknown>>) : [];
      const shown = value.trim() === "" ? attachments.map((item) => String(item["name"] ?? "")).join(" ") : value;
      const group = root(conversation);
      const explicit = group !== conversation;
      lastOwner.set(conversation, id);
      messages.push({ id, at, text: shown, scope: scopes.get(group) ?? "daily", group, explicit, routed: true, origin: "stream" });
    } else {
      const about = lastOwner.get(conversation);
      if (about === undefined) {
        continue;
      }
      if (kind === "question") {
        replies.push({ id, at, text: JSON.stringify(body["questions"] ?? []), about, asks: true, card: true });
      } else {
        const value = typeof body["text"] === "string" ? body["text"] : "";
        replies.push({ id, at, text: value, about, asks: endsWithQuestion(value), card: false });
      }
    }
  }
  database.close();
  return { name: "super-agent2", messages: byTime(messages), replies: byTime(replies) };
}

export function readSuperAgent(path: string): History {
  const database = open(path);
  const messages: OwnerMessage[] = [];
  const replies: Reply[] = [];
  const ticketOf = new Map<string, string>();
  for (const row of database.prepare("SELECT trigger_id, ticket_id FROM stream_items WHERE kind = 'ticket' AND trigger_id IS NOT NULL AND ticket_id IS NOT NULL ORDER BY seq").all() as Row[]) {
    const trigger = text(row, "trigger_id");
    if (!ticketOf.has(trigger)) {
      ticketOf.set(trigger, text(row, "ticket_id"));
    }
  }
  const seenStream = new Set<string>();
  for (const row of database.prepare("SELECT trigger_id, text, at, origin, entry FROM stream_items WHERE kind = 'owner' ORDER BY seq").all() as Row[]) {
    const id = text(row, "trigger_id");
    const ticket = ticketOf.get(id);
    seenStream.add(`${text(row, "text").trim()}`);
    messages.push({
      id,
      at: Date.parse(text(row, "at")),
      text: text(row, "text"),
      scope: "all",
      group: ticket === undefined ? null : `ticket:${ticket}`,
      explicit: false,
      routed: !isCardAction(text(row, "text")),
      origin: `stream:${text(row, "entry")}`,
    });
  }
  for (const row of database.prepare("SELECT id, conversation, ticket_id, kind, text, client, at FROM chat_messages WHERE direction = 'in' ORDER BY seq").all() as Row[]) {
    if (seenStream.has(text(row, "text").trim())) {
      continue;
    }
    const ticket = row["ticket_id"];
    const triggerTicket = ticketOf.get(text(row, "id"));
    const group = typeof ticket === "string" ? `ticket:${ticket}` : triggerTicket === undefined ? `chat:${text(row, "conversation")}` : `ticket:${triggerTicket}`;
    messages.push({
      id: text(row, "id"),
      at: Date.parse(text(row, "at")),
      text: text(row, "text"),
      scope: "all",
      group,
      explicit: typeof ticket === "string",
      routed: typeof ticket !== "string",
      origin: `chat:${text(row, "client") || "unknown"}:${text(row, "kind")}`,
    });
  }
  const known = new Set(messages.map((message) => message.id));
  for (const row of database.prepare("SELECT id, kind, text, trigger_id, at FROM stream_items WHERE kind IN ('reply', 'confirm', 'ticket', 'handoff') AND trigger_id IS NOT NULL ORDER BY seq").all() as Row[]) {
    const about = text(row, "trigger_id");
    if (!known.has(about)) {
      continue;
    }
    const kind = text(row, "kind");
    const value = text(row, "text");
    replies.push({ id: text(row, "id"), at: Date.parse(text(row, "at")), text: value, about, asks: kind === "confirm" || endsWithQuestion(value), card: kind === "confirm" });
  }
  const lastIn = new Map<string, string>();
  for (const row of database.prepare("SELECT id, conversation, direction, kind, text, at FROM chat_messages ORDER BY seq").all() as Row[]) {
    const conversation = text(row, "conversation");
    if (text(row, "direction") === "in") {
      if (known.has(text(row, "id"))) {
        lastIn.set(conversation, text(row, "id"));
      }
      continue;
    }
    const about = lastIn.get(conversation);
    if (about === undefined) {
      continue;
    }
    const value = text(row, "text");
    replies.push({ id: text(row, "id"), at: Date.parse(text(row, "at")), text: value, about, asks: endsWithQuestion(value), card: false });
  }
  database.close();
  return { name: "super-agent", messages: byTime(messages), replies: byTime(replies) };
}
