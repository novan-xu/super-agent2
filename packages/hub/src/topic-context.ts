import { type HistoryItem, openTicketStates, ticketReference, TopicBoardEntry, type TopicSeed, type TurnOutcome } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";

const BoardRow = TopicBoardEntry.extend({ revision: z.number().int() });
const SeedTicket = z.object({ code: z.string(), codeDate: z.string(), own: z.number(), state: z.string(), repository: z.string().nullable(), title: z.string() });
const HistoryRow = z.object({ id: z.string(), conversation_id: z.string(), turn_id: z.string().nullable(), stream_seq: z.number(), kind: z.string() });
const TurnId = z.object({ id: z.string() });
const TurnSummary = z.object({
  id: z.string(),
  state: z.string(),
  topic_summary: z.string().nullable(),
});

function headline(value: string): string {
  const line = value.split(/\r?\n/u).find((part) => part.trim() !== "")?.trim() ?? "";
  const characters = [...line];
  return characters.length > 180 ? `${characters.slice(0, 179).join("")}…` : line;
}

function itemText(item: HistoryItem): string {
  if (item.kind === "tool") {
    return `${item.name}: ${item.output || item.input}`;
  }
  return item.text || (item.kind === "owner" ? item.attachments.map((attachment) => attachment.name).join(", ") : "");
}

export function createTopicContext({ connection }: HubDatabase, itemOf: (row: unknown) => HistoryItem, resolve: (topic: string) => string) {
  const selectBoard = connection.prepare(
    `SELECT id, title, repository, topic_state AS state, board_status AS status, merged_into AS mergedInto, board_revision AS revision
      FROM conversations WHERE board_revision > ? ORDER BY board_revision`,
  );
  const selectTickets = connection.prepare(
    `SELECT code, code_date AS codeDate, conversation_id IS ? AS own, state, coalesce(repository, project) AS repository, title_en AS title FROM tickets
      WHERE state IN (${openTicketStates.map(() => "?").join(", ")}) ORDER BY own DESC, created_at DESC, id DESC`,
  );
  const selectTurns = connection.prepare(
    `SELECT id FROM turns WHERE conversation_id = ? AND (state <> 'running' OR ?)
      ORDER BY started_at DESC, rowid DESC LIMIT 50`,
  );
  const countTurns = connection.prepare("SELECT count(*) AS count FROM turns WHERE conversation_id = ? AND (state <> 'running' OR ?)");
  const selectSummaryTurns = connection.prepare(
    `SELECT id, state, topic_summary FROM turns WHERE conversation_id = ? AND state <> 'running'
      ORDER BY started_at DESC, rowid DESC LIMIT 12 OFFSET ?`,
  );
  const selectUnsummarized = connection.prepare("SELECT id, state, topic_summary FROM turns WHERE conversation_id = ? AND state <> 'running' AND topic_summary IS NULL");
  const selectFirst = connection.prepare(
    "SELECT id, state, topic_summary FROM turns WHERE conversation_id = ? AND state <> 'running' ORDER BY started_at, rowid LIMIT 1",
  );
  const selectTurnInput = connection.prepare(
    "SELECT * FROM conversation_entries WHERE turn_id = ? AND (kind = 'owner' OR prompt IS NOT NULL) ORDER BY seq LIMIT 1",
  );
  const selectTurnAnswer = connection.prepare(
    "SELECT * FROM conversation_entries WHERE turn_id = ? AND kind = 'text' AND json_extract(body, '$.text') <> '' ORDER BY seq DESC LIMIT 1",
  );
  const saveTurnSummary = connection.prepare("UPDATE turns SET topic_summary = ? WHERE id = ?");
  const saveStatus = connection.prepare("UPDATE conversations SET board_status = ? WHERE id = ?");
  const selectSeedEntries = connection.prepare(
    `SELECT * FROM conversation_entries WHERE conversation_id = ? AND taken IS NOT 0
      AND (turn_id IS NULL OR turn_id IN (SELECT value FROM json_each(?))) ORDER BY seq`,
  );
  const selectEntry = connection.prepare("SELECT * FROM conversation_entries WHERE id = ?");
  const selectRecent = connection.prepare(
    "SELECT * FROM conversation_entries WHERE conversation_id = ? AND stream_seq < ? ORDER BY stream_seq DESC LIMIT ?",
  );
  const searchable = ["text", "name", "input", "output", "title.en", "title.zh", "report.en", "report.zh", "attachments"].map((field) => `coalesce(json_extract(body, '$.${field}'), '')`).join(" || char(10) || ");
  const selectMatches = connection.prepare(
    `SELECT * FROM conversation_entries WHERE stream_seq < ? AND (? IS NULL OR conversation_id = ?)
      AND instr(lower(${searchable}), lower(?)) > 0 ORDER BY stream_seq DESC LIMIT ?`,
  );

  const turnSummary = (turn: string, outcome: string) => {
    const input = selectTurnInput.get(turn);
    const answer = selectTurnAnswer.get(turn);
    const request = input === undefined ? "" : headline(itemText(itemOf(input)));
    const reply = answer === undefined ? "" : headline(itemText(itemOf(answer)));
    const status = outcome === "completed" && reply !== "" ? reply : `Turn ${outcome}${reply === "" ? "" : `: ${reply}`}`;
    return { status, summary: request === "" ? status : `Request: ${request} — ${status}` };
  };

  const summary = (topic: string, skipRecent = 0): string => {
    const rows = selectSummaryTurns.all(topic, skipRecent).map((row) => TurnSummary.parse(row));
    const first = selectFirst.get(topic);
    const read = ({ id, state, topic_summary }: z.infer<typeof TurnSummary>) => topic_summary ?? turnSummary(id, state).summary;
    const lines = rows.reverse().map(read);
    if (rows.length > 0 && first !== undefined) {
      const initial = TurnSummary.parse(first);
      if (rows[0]?.id !== initial.id) {
        lines.unshift(read(initial), "Earlier details are available through read_topic_history.");
      }
    }
    return lines.map((line) => `- ${line}`).join("\n");
  };

  const tickets = (topic: string | null): TopicSeed["tickets"] => selectTickets.all(topic, ...openTicketStates).map((row) => {
    const ticket = SeedTicket.parse(row);
    const { own, state, repository, title } = ticket;
    return { own: own === 1, line: `ticket ${ticketReference(ticket)} [${state}]${repository === null ? "" : ` ${repository}`} — ${title.replace(/\s+/gu, " ")}` };
  });

  const seed = (topic: string, exclude: ReadonlySet<string>, continuing: boolean): TopicSeed => {
    const ids = selectTurns.all(topic, Number(continuing)).map((row) => TurnId.parse(row).id).reverse();
    const count = z.object({ count: z.number() }).parse(countTurns.get(topic, Number(continuing))).count;
    const olderTurns = count - ids.length;
    const groups = new Map(ids.map((id) => [id, [] as HistoryItem[]]));
    let last: HistoryItem[] = groups.values().next().value ?? [];
    const loose = last;
    let inWindow = olderTurns === 0;
    for (const row of selectSeedEntries.iterate(topic, JSON.stringify(ids))) {
      const entry = HistoryRow.parse(row);
      if (exclude.has(entry.id)) {
        continue;
      }
      const group = entry.turn_id === null ? undefined : groups.get(entry.turn_id);
      if (group !== undefined) {
        inWindow = true;
        last = group;
      }
      if (inWindow) {
        last.push(itemOf(row));
      }
    }
    return {
      summary: olderTurns === 0 ? "" : summary(topic, ids.length - Number(continuing)),
      olderTurns,
      turns: ids.length === 0 ? (loose.length === 0 ? [] : [loose]) : [...groups.values()],
      tickets: tickets(topic),
    };
  };

  const references = (rows: unknown[], limit: number) => {
    const messages = rows.slice(0, limit).map((row) => {
      const entry = HistoryRow.parse(row);
      return { id: entry.id, topic: entry.conversation_id, position: entry.stream_seq, kind: entry.kind, preview: headline(itemText(itemOf(row))) };
    });
    return { messages, before: rows.length <= limit ? null : (messages.at(-1)?.position ?? null) };
  };

  return {
    board: (since = 0) => selectBoard.all(since).map((row) => BoardRow.parse(row)),
    finish: (topic: string, turn: string, outcome: TurnOutcome) => {
      const details = turnSummary(turn, outcome);
      saveTurnSummary.run(details.summary, turn);
      saveStatus.run(details.status, topic);
    },
    seed,
    saveSummary: (topic: string) => {
      for (const row of selectUnsummarized.all(topic)) {
        const { id, state } = TurnSummary.parse(row);
        saveTurnSummary.run(turnSummary(id, state).summary, id);
      }
    },
    summary: (topic: string) => summary(resolve(topic)),
    tickets: (topic: string | null) => tickets(topic === null ? null : resolve(topic)),
    message: (id: string) => {
      const row = selectEntry.get(id);
      return row === undefined ? undefined : { id, item: itemOf(row) };
    },
    recent: (topic: string, before: number, limit: number) => references(selectRecent.all(resolve(topic), before, limit + 1), limit),
    search: (query: string, topic: string | null, before: number, limit: number) => {
      const id = topic === null ? null : resolve(topic);
      return references(selectMatches.all(before, id, id, query, limit + 1), limit);
    },
  };
}

export type TopicContext = ReturnType<typeof createTopicContext>;
