import {
  canMoveTicket,
  type Difficulty,
  GeneratedText,
  openTicketStates,
  type Platform,
  RepositoryName,
  Ticket,
  type TicketDetail,
  TicketIssue,
  type TicketKind,
  TicketMove,
  type TicketState,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";

export interface TicketToOpen {
  readonly repository: string | null;
  readonly issues: readonly TicketIssue[];
  readonly title: GeneratedText;
  readonly summary: GeneratedText;
  readonly kind: TicketKind;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
  readonly waitsFor?: readonly number[] | undefined;
  readonly conversation?: string | undefined;
}

export type MoveError = "not_found" | "refused";

export type MoveResult = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly error: MoveError; readonly ticket?: Ticket };

export interface ListOptions {
  readonly open?: boolean;
  readonly limit?: number;
}

export type TicketListener = (ticket: Ticket) => void;

export interface TicketWork {
  stop(ticket: Ticket): void;
}

export const noTicketWork: TicketWork = { stop: () => undefined };

export interface TicketService {
  open(request: TicketToOpen): Ticket;
  get(id: number): Ticket | undefined;
  list(options?: ListOptions): Ticket[];
  moves(id: number): TicketMove[];
  detail(id: number): TicketDetail | undefined;
  forIssue(repository: string, number: number): Ticket[];
  move(id: number, to: TicketState, reason?: GeneratedText): MoveResult;
  stop(id: number, reason: GeneratedText): MoveResult;
  subscribe(listener: TicketListener): () => void;
}

export interface TicketServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly work?: TicketWork;
}

export class TicketError extends Error {}

const TicketRow = z.object({
  id: z.number().int(),
  repository: z.string().nullable(),
  kind: z.string(),
  title_en: z.string(),
  title_zh: z.string(),
  summary_en: z.string(),
  summary_zh: z.string(),
  difficulty: z.string().nullable(),
  platform: z.string().nullable(),
  state: z.string(),
  machine: z.string().nullable(),
  engine: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  branch: z.string().nullable(),
  pull_request: z.number().int().nullable(),
  round: z.number().int(),
  stop_reason_en: z.string().nullable(),
  stop_reason_zh: z.string().nullable(),
  conversation_id: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

const IssueRow = z.object({
  repository: z.string(),
  number: z.number().int(),
  url: z.string(),
  title_en: z.string(),
  title_zh: z.string(),
  summary_en: z.string(),
  summary_zh: z.string(),
});

const WaitRow = z.object({ waits_for: z.number().int() });

const MoveRow = z.object({
  ticket_id: z.number().int(),
  seq: z.number().int(),
  from_state: z.string().nullable(),
  to_state: z.string(),
  reason_en: z.string().nullable(),
  reason_zh: z.string().nullable(),
  at: z.number().int(),
});

const IdRow = z.object({ ticket_id: z.number().int() });

const SeqRow = z.object({ seq: z.number().int().nullable() });

function pair(en: string | null, zh: string | null): GeneratedText | null {
  return en === null || zh === null ? null : { en, zh };
}

const defaultLimit = 200;

export function createTicketService(options: TicketServiceOptions): TicketService {
  const { connection } = options.database;
  const { clock } = options;
  const work = options.work ?? noTicketWork;
  const listeners = new Set<TicketListener>();

  const selectTicket = connection.prepare("SELECT * FROM tickets WHERE id = ?");
  const selectIssues = connection.prepare("SELECT * FROM ticket_issues WHERE ticket_id = ? ORDER BY position");
  const selectWaits = connection.prepare("SELECT waits_for FROM ticket_waits WHERE ticket_id = ? ORDER BY waits_for");
  const selectMoves = connection.prepare("SELECT * FROM ticket_moves WHERE ticket_id = ? ORDER BY seq");
  const selectLastSeq = connection.prepare("SELECT MAX(seq) AS seq FROM ticket_moves WHERE ticket_id = ?");
  const selectAll = connection.prepare("SELECT * FROM tickets ORDER BY created_at DESC, id DESC LIMIT ?");
  const selectOpen = connection.prepare(
    `SELECT * FROM tickets WHERE state IN (${openTicketStates.map(() => "?").join(", ")}) ORDER BY created_at DESC, id DESC LIMIT ?`,
  );
  const selectByIssue = connection.prepare("SELECT DISTINCT ticket_id FROM ticket_issues WHERE repository = ? AND number = ? ORDER BY ticket_id");
  const insertTicket = connection.prepare(
    `INSERT INTO tickets (repository, kind, title_en, title_zh, summary_en, summary_zh, difficulty, platform, state, conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  );
  const insertIssue = connection.prepare(
    "INSERT INTO ticket_issues (ticket_id, position, repository, number, url, title_en, title_zh, summary_en, summary_zh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertWait = connection.prepare("INSERT INTO ticket_waits (ticket_id, waits_for) VALUES (?, ?)");
  const insertMove = connection.prepare(
    "INSERT INTO ticket_moves (ticket_id, seq, from_state, to_state, reason_en, reason_zh, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const updateState = connection.prepare("UPDATE tickets SET state = ?, updated_at = ? WHERE id = ? AND state = ?");
  const updateStopReason = connection.prepare("UPDATE tickets SET stop_reason_en = ?, stop_reason_zh = ? WHERE id = ?");

  const toTicket = (row: unknown): Ticket => {
    const value = TicketRow.parse(row);
    const issues = selectIssues.all(value.id).map((entry) => {
      const issue = IssueRow.parse(entry);
      return {
        repository: issue.repository,
        number: issue.number,
        url: issue.url,
        title: { en: issue.title_en, zh: issue.title_zh },
        summary: { en: issue.summary_en, zh: issue.summary_zh },
      };
    });
    return Ticket.parse({
      id: value.id,
      repository: value.repository,
      issues,
      title: { en: value.title_en, zh: value.title_zh },
      summary: { en: value.summary_en, zh: value.summary_zh },
      kind: value.kind,
      difficulty: value.difficulty,
      platform: value.platform,
      state: value.state,
      machine: value.machine,
      engine: value.engine,
      model: value.model,
      effort: value.effort,
      branch: value.branch,
      pullRequest: value.pull_request,
      round: value.round,
      waitsFor: selectWaits.all(value.id).map((entry) => WaitRow.parse(entry).waits_for),
      stopReason: pair(value.stop_reason_en, value.stop_reason_zh),
      conversation: value.conversation_id,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    });
  };

  const get = (id: number): Ticket | undefined => {
    const row = selectTicket.get(id);
    return row === undefined ? undefined : toTicket(row);
  };

  const movesOf = (id: number): TicketMove[] =>
    selectMoves.all(id).map((row) => {
      const value = MoveRow.parse(row);
      return TicketMove.parse({
        ticket: value.ticket_id,
        seq: value.seq,
        from: value.from_state,
        to: value.to_state,
        reason: pair(value.reason_en, value.reason_zh),
        at: value.at,
      });
    });

  const recordMove = (id: number, from: TicketState | null, to: TicketState, reason: GeneratedText | undefined, at: number) => {
    const last = SeqRow.parse(selectLastSeq.get(id)).seq ?? 0;
    insertMove.run(id, last + 1, from, to, reason?.en ?? null, reason?.zh ?? null, at);
  };

  const transaction = <T>(body: () => T): T => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  };

  const announce = (ticket: Ticket) => {
    for (const listener of listeners) {
      try {
        listener(ticket);
      } catch {
        continue;
      }
    }
  };

  const check = (request: TicketToOpen) => {
    if (request.kind === "writing") {
      if (request.repository !== null || request.issues.length > 0) {
        throw new TicketError("A writing ticket has no repository and no issues");
      }
    } else {
      if (request.repository === null || !RepositoryName.safeParse(request.repository).success) {
        throw new TicketError("A ticket for code work needs its repository as owner/name");
      }
      if (request.issues.length === 0) {
        throw new TicketError("A ticket for code work needs at least one issue");
      }
    }
    const numbers = new Set<number>();
    for (const issue of request.issues) {
      TicketIssue.parse(issue);
      if (issue.repository !== request.repository) {
        throw new TicketError(`Issue #${issue.number} is in ${issue.repository}, not in the ticket's repository ${request.repository ?? ""}`);
      }
      if (numbers.has(issue.number)) {
        throw new TicketError(`Issue #${issue.number} is listed twice`);
      }
      numbers.add(issue.number);
    }
    GeneratedText.parse(request.title);
    GeneratedText.parse(request.summary);
    for (const before of request.waitsFor ?? []) {
      if (get(before) === undefined) {
        throw new TicketError(`There is no ticket ${before} to wait for`);
      }
    }
  };

  const move = (id: number, to: TicketState, reason?: GeneratedText, after?: () => void): MoveResult => {
    const current = get(id);
    if (current === undefined) {
      return { ok: false, error: "not_found" };
    }
    if (!canMoveTicket(current.kind, current.state, to)) {
      return { ok: false, error: "refused", ticket: current };
    }
    const now = clock.now();
    transaction(() => {
      updateState.run(to, now, id, current.state);
      recordMove(id, current.state, to, reason, now);
      after?.();
    });
    const ticket = get(id);
    if (ticket === undefined) {
      return { ok: false, error: "not_found" };
    }
    announce(ticket);
    return { ok: true, ticket };
  };

  return {
    open: (request) => {
      check(request);
      const now = clock.now();
      const id = transaction(() => {
        const result = insertTicket.run(
          request.repository,
          request.kind,
          request.title.en.trim(),
          request.title.zh.trim(),
          request.summary.en.trim(),
          request.summary.zh.trim(),
          request.difficulty ?? null,
          request.platform ?? null,
          request.conversation ?? null,
          now,
          now,
        );
        const ticketId = Number(result.lastInsertRowid);
        request.issues.forEach((issue, position) => {
          insertIssue.run(
            ticketId,
            position,
            issue.repository,
            issue.number,
            issue.url,
            issue.title.en.trim(),
            issue.title.zh.trim(),
            issue.summary.en.trim(),
            issue.summary.zh.trim(),
          );
        });
        for (const before of new Set(request.waitsFor ?? [])) {
          insertWait.run(ticketId, before);
        }
        recordMove(ticketId, null, "pending", undefined, now);
        return ticketId;
      });
      const ticket = get(id);
      if (ticket === undefined) {
        throw new Error(`Ticket ${id} was not stored`);
      }
      announce(ticket);
      return ticket;
    },
    get,
    list: (listing = {}) => {
      const limit = listing.limit ?? defaultLimit;
      const rows = listing.open === true ? selectOpen.all(...openTicketStates, limit) : selectAll.all(limit);
      return rows.map(toTicket);
    },
    moves: movesOf,
    detail: (id) => {
      const ticket = get(id);
      return ticket === undefined ? undefined : { ticket, moves: movesOf(id) };
    },
    forIssue: (repository, number) =>
      selectByIssue.all(repository, number).flatMap((row) => {
        const ticket = get(IdRow.parse(row).ticket_id);
        return ticket === undefined ? [] : [ticket];
      }),
    move: (id, to, reason) => move(id, to, reason),
    stop: (id, reason) => {
      const given = GeneratedText.parse(reason);
      const result = move(id, "stopped", given, () => updateStopReason.run(given.en, given.zh, id));
      if (result.ok) {
        work.stop(result.ticket);
      }
      return result;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
