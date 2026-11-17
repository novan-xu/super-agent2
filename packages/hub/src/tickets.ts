import {
  canMoveTicket,
  ChosenBy,
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
  TicketRun,
  type TicketState,
  type OwnerChoice,
  type ProgramId,
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

export interface TicketDescription {
  readonly title: GeneratedText;
  readonly summary: GeneratedText;
  readonly kind: TicketKind;
  readonly difficulty: Difficulty | null;
  readonly platform: Platform | null;
}

export interface DefaultsStatement {
  readonly kind: TicketKind;
  readonly difficulty: Difficulty | null;
  readonly difficultyReason: GeneratedText;
  readonly platform: Platform;
  readonly brainEngine: ProgramId | null;
}

export interface ChosenRun {
  readonly machine: string;
  readonly engine: ProgramId;
  readonly model: string;
  readonly effort: string;
  readonly by: ChosenBy;
}

export interface WaitToSet {
  readonly ticket: number;
  readonly deployment: boolean;
}

export type MoveError = "not_found" | "refused";

export type MoveResult = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly error: MoveError; readonly ticket?: Ticket };

export interface ListOptions {
  readonly open?: boolean;
  readonly limit?: number;
}

export type TicketListener = (ticket: Ticket) => void;

export interface TicketWork {
  begin(ticket: Ticket): void | Promise<void>;
  stop(ticket: Ticket): void;
  reassign?(ticket: Ticket): void | Promise<void>;
}

export const noTicketWork: TicketWork = { begin: () => undefined, stop: () => undefined };

export interface TicketWrites {
  get(id: number): Ticket | undefined;
  open(request: TicketToOpen): number;
  setIssues(id: number, issues: readonly TicketIssue[]): void;
  describe(id: number, description: TicketDescription): void;
  setWaits(id: number, waits: readonly WaitToSet[]): void;
  redirectWaits(from: number, to: number): void;
  waive(id: number, before: number): boolean;
  deployed(id: number): void;
  move(id: number, to: TicketState, reason?: GeneratedText): Ticket;
  touched(id: number): void;
  state(id: number, statement: DefaultsStatement): void;
  forgetDefaults(id: number): void;
  ownerChoice(id: number, choice: OwnerChoice): void;
  choose(id: number, chosen: ChosenRun): void;
  ran(id: number, run: TicketRun): void;
}

export interface TicketService {
  open(request: TicketToOpen): Ticket;
  get(id: number): Ticket | undefined;
  list(options?: ListOptions): Ticket[];
  moves(id: number): TicketMove[];
  detail(id: number): TicketDetail | undefined;
  forIssue(repository: string, number: number): Ticket[];
  waitingFor(id: number): Ticket[];
  move(id: number, to: TicketState, reason?: GeneratedText): MoveResult;
  stop(id: number, reason: GeneratedText): MoveResult;
  change<T>(body: (writes: TicketWrites) => T): T;
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
  difficulty_reason_en: z.string().nullable(),
  difficulty_reason_zh: z.string().nullable(),
  platform: z.string().nullable(),
  brain_engine: z.string().nullable(),
  owner_machine: z.string().nullable(),
  owner_engine: z.string().nullable(),
  owner_model: z.string().nullable(),
  owner_effort: z.string().nullable(),
  chosen_by: z.string().nullable(),
  chosen_at: z.number().int().nullable(),
  ran: z.string().nullable(),
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
  deployed_at: z.number().int().nullable(),
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

const WaitRow = z.object({ waits_for: z.number().int(), deployment: z.number().int(), waived_at: z.number().int().nullable() });

const BeginRow = z.object({ failure: z.string().nullable() });

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

function parsedJson(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const defaultLimit = 200;

export function createTicketService(options: TicketServiceOptions): TicketService {
  const { connection } = options.database;
  const { clock } = options;
  const work = options.work ?? noTicketWork;
  const listeners = new Set<TicketListener>();
  let inside = false;

  const selectTicket = connection.prepare("SELECT * FROM tickets WHERE id = ?");
  const selectIssues = connection.prepare("SELECT * FROM ticket_issues WHERE ticket_id = ? ORDER BY position");
  const selectWaits = connection.prepare("SELECT waits_for, deployment, waived_at FROM ticket_waits WHERE ticket_id = ? ORDER BY waits_for");
  const selectBegin = connection.prepare("SELECT failure FROM ticket_begins WHERE ticket_id = ? AND failed_at IS NOT NULL AND done_at IS NULL");
  const selectMoves = connection.prepare("SELECT * FROM ticket_moves WHERE ticket_id = ? ORDER BY seq");
  const selectLastSeq = connection.prepare("SELECT MAX(seq) AS seq FROM ticket_moves WHERE ticket_id = ?");
  const selectAll = connection.prepare("SELECT * FROM tickets ORDER BY created_at DESC, id DESC LIMIT ?");
  const selectOpen = connection.prepare(
    `SELECT * FROM tickets WHERE state IN (${openTicketStates.map(() => "?").join(", ")}) ORDER BY created_at DESC, id DESC LIMIT ?`,
  );
  const selectByIssue = connection.prepare("SELECT DISTINCT ticket_id FROM ticket_issues WHERE repository = ? AND number = ? ORDER BY ticket_id");
  const selectWaitingFor = connection.prepare("SELECT ticket_id FROM ticket_waits WHERE waits_for = ? ORDER BY ticket_id");
  const insertTicket = connection.prepare(
    `INSERT INTO tickets (repository, kind, title_en, title_zh, summary_en, summary_zh, difficulty, platform, state, conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  );
  const insertIssue = connection.prepare(
    "INSERT INTO ticket_issues (ticket_id, position, repository, number, url, title_en, title_zh, summary_en, summary_zh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const deleteIssues = connection.prepare("DELETE FROM ticket_issues WHERE ticket_id = ?");
  const insertWait = connection.prepare("INSERT INTO ticket_waits (ticket_id, waits_for, deployment) VALUES (?, ?, ?)");
  const deleteWaits = connection.prepare("DELETE FROM ticket_waits WHERE ticket_id = ?");
  const selectRedirected = connection.prepare(
    "SELECT w.ticket_id, w.deployment FROM ticket_waits w JOIN tickets t ON t.id = w.ticket_id WHERE w.waits_for = ? AND t.state = 'pending'",
  );
  const deleteWait = connection.prepare("DELETE FROM ticket_waits WHERE ticket_id = ? AND waits_for = ?");
  const upsertWait = connection.prepare(
    "INSERT INTO ticket_waits (ticket_id, waits_for, deployment) VALUES (?, ?, ?) ON CONFLICT (ticket_id, waits_for) DO UPDATE SET deployment = MAX(deployment, excluded.deployment)",
  );
  const waiveWait = connection.prepare("UPDATE ticket_waits SET waived_at = ? WHERE ticket_id = ? AND waits_for = ? AND waived_at IS NULL");
  const updateDescription = connection.prepare(
    "UPDATE tickets SET title_en = ?, title_zh = ?, summary_en = ?, summary_zh = ?, kind = ?, difficulty = ?, platform = ? WHERE id = ?",
  );
  const updateDeployed = connection.prepare("UPDATE tickets SET deployed_at = ? WHERE id = ? AND deployed_at IS NULL");
  const updateTouched = connection.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?");
  const insertMove = connection.prepare(
    "INSERT INTO ticket_moves (ticket_id, seq, from_state, to_state, reason_en, reason_zh, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const updateState = connection.prepare("UPDATE tickets SET state = ?, updated_at = ? WHERE id = ? AND state = ?");
  const updateStopReason = connection.prepare("UPDATE tickets SET stop_reason_en = ?, stop_reason_zh = ? WHERE id = ?");
  const updateStatement = connection.prepare(
    "UPDATE tickets SET kind = ?, difficulty = ?, difficulty_reason_en = ?, difficulty_reason_zh = ?, platform = ?, brain_engine = ? WHERE id = ?",
  );
  const clearDefaults = connection.prepare(
    "UPDATE tickets SET difficulty_reason_en = NULL, difficulty_reason_zh = NULL, brain_engine = NULL, owner_machine = NULL, owner_engine = NULL, owner_model = NULL, owner_effort = NULL WHERE id = ?",
  );
  const updateOwnerChoice = connection.prepare("UPDATE tickets SET owner_machine = ?, owner_engine = ?, owner_model = ?, owner_effort = ? WHERE id = ?");
  const updateChosen = connection.prepare("UPDATE tickets SET machine = ?, engine = ?, model = ?, effort = ?, chosen_by = ?, chosen_at = ? WHERE id = ?");
  const updateRan = connection.prepare("UPDATE tickets SET ran = ? WHERE id = ?");

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
    const waits = selectWaits.all(value.id).map((entry) => {
      const wait = WaitRow.parse(entry);
      return { ticket: wait.waits_for, deployment: wait.deployment === 1, waived: wait.waived_at !== null };
    });
    const begin = selectBegin.get(value.id);
    return Ticket.parse({
      id: value.id,
      repository: value.repository,
      issues,
      title: { en: value.title_en, zh: value.title_zh },
      summary: { en: value.summary_en, zh: value.summary_zh },
      kind: value.kind,
      difficulty: value.difficulty,
      difficultyReason: pair(value.difficulty_reason_en, value.difficulty_reason_zh),
      platform: value.platform,
      brainEngine: value.brain_engine,
      ownerChoice: { machine: value.owner_machine, engine: value.owner_engine, model: value.owner_model, effort: value.owner_effort },
      state: value.state,
      machine: value.machine,
      engine: value.engine,
      model: value.model,
      effort: value.effort,
      chosenBy: ChosenBy.nullable().catch(null).parse(parsedJson(value.chosen_by)),
      chosenAt: value.chosen_at,
      ran: TicketRun.nullable().catch(null).parse(parsedJson(value.ran)),
      branch: value.branch,
      pullRequest: value.pull_request,
      round: value.round,
      waitsFor: waits.map((wait) => wait.ticket),
      waits,
      deployedAt: value.deployed_at,
      beginFailure: begin === undefined ? null : BeginRow.parse(begin).failure,
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
    checkIssues(request.repository, request.issues);
    GeneratedText.parse(request.title);
    GeneratedText.parse(request.summary);
    for (const before of request.waitsFor ?? []) {
      if (get(before) === undefined) {
        throw new TicketError(`There is no ticket ${before} to wait for`);
      }
    }
  };

  const checkIssues = (repository: string | null, issues: readonly TicketIssue[]) => {
    const numbers = new Set<number>();
    for (const issue of issues) {
      TicketIssue.parse(issue);
      if (issue.repository !== repository) {
        throw new TicketError(`Issue #${issue.number} is in ${issue.repository}, not in the ticket's repository ${repository ?? ""}`);
      }
      if (numbers.has(issue.number)) {
        throw new TicketError(`Issue #${issue.number} is listed twice`);
      }
      numbers.add(issue.number);
    }
  };

  const insertIssues = (id: number, issues: readonly TicketIssue[]) => {
    issues.forEach((issue, position) => {
      insertIssue.run(id, position, issue.repository, issue.number, issue.url, issue.title.en.trim(), issue.title.zh.trim(), issue.summary.en.trim(), issue.summary.zh.trim());
    });
  };

  const change = <T>(body: (writes: TicketWrites) => T): T => {
    if (inside) {
      throw new Error("Ticket changes do not nest");
    }
    const touched = new Set<number>();
    const touch = (id: number) => {
      updateTouched.run(clock.now(), id);
      touched.add(id);
    };
    const existing = (id: number): Ticket => {
      const ticket = get(id);
      if (ticket === undefined) {
        throw new TicketError(`There is no ticket ${id}`);
      }
      return ticket;
    };
    const writes: TicketWrites = {
      get,
      open: (request) => {
        check(request);
        const now = clock.now();
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
        const id = Number(result.lastInsertRowid);
        insertIssues(id, request.issues);
        for (const before of new Set(request.waitsFor ?? [])) {
          insertWait.run(id, before, 0);
        }
        recordMove(id, null, "pending", undefined, now);
        touched.add(id);
        return id;
      },
      setIssues: (id, issues) => {
        const ticket = existing(id);
        checkIssues(ticket.repository, issues);
        deleteIssues.run(id);
        insertIssues(id, issues);
        touch(id);
      },
      describe: (id, description) => {
        existing(id);
        const title = GeneratedText.parse(description.title);
        const summary = GeneratedText.parse(description.summary);
        updateDescription.run(title.en, title.zh, summary.en, summary.zh, description.kind, description.difficulty, description.platform, id);
        touch(id);
      },
      setWaits: (id, waits) => {
        existing(id);
        deleteWaits.run(id);
        const seen = new Set<number>();
        for (const wait of waits) {
          if (wait.ticket === id) {
            throw new TicketError(`Ticket ${id} cannot wait for itself`);
          }
          existing(wait.ticket);
          if (!seen.has(wait.ticket)) {
            seen.add(wait.ticket);
            insertWait.run(id, wait.ticket, wait.deployment ? 1 : 0);
          }
        }
        touch(id);
      },
      redirectWaits: (from, to) => {
        for (const row of selectRedirected.all(from)) {
          const value = z.object({ ticket_id: z.number().int(), deployment: z.number().int() }).parse(row);
          deleteWait.run(value.ticket_id, from);
          if (value.ticket_id !== to) {
            upsertWait.run(value.ticket_id, to, value.deployment);
          }
          touch(value.ticket_id);
        }
      },
      waive: (id, before) => {
        const changed = waiveWait.run(clock.now(), id, before).changes > 0;
        if (changed) {
          touch(id);
        }
        return changed;
      },
      deployed: (id) => {
        updateDeployed.run(clock.now(), id);
        touch(id);
      },
      move: (id, to, reason) => {
        const current = existing(id);
        if (!canMoveTicket(current.kind, current.state, to)) {
          throw new TicketError(`Ticket ${id} is ${current.state} and cannot become ${to}`);
        }
        const now = clock.now();
        updateState.run(to, now, id, current.state);
        recordMove(id, current.state, to, reason, now);
        if (to === "stopped" && reason !== undefined) {
          updateStopReason.run(reason.en, reason.zh, id);
        }
        touched.add(id);
        return existing(id);
      },
      touched: (id) => touch(id),
      state: (id, statement) => {
        const current = existing(id);
        const reason = GeneratedText.parse(statement.difficultyReason);
        if ((statement.kind === "writing") !== (current.kind === "writing")) {
          throw new TicketError(`Ticket ${id} is ${current.kind === "writing" ? "writing" : "code work"} and cannot become ${statement.kind}`);
        }
        updateStatement.run(statement.kind, statement.difficulty, reason.en, reason.zh, statement.platform, statement.brainEngine, id);
        touch(id);
      },
      forgetDefaults: (id) => {
        existing(id);
        clearDefaults.run(id);
        touch(id);
      },
      ownerChoice: (id, choice) => {
        existing(id);
        updateOwnerChoice.run(choice.machine, choice.engine, choice.model, choice.effort, id);
        touch(id);
      },
      choose: (id, chosen) => {
        existing(id);
        updateChosen.run(chosen.machine, chosen.engine, chosen.model, chosen.effort, JSON.stringify(ChosenBy.parse(chosen.by)), clock.now(), id);
        touch(id);
      },
      ran: (id, run) => {
        existing(id);
        updateRan.run(JSON.stringify(TicketRun.parse(run)), id);
        touch(id);
      },
    };
    inside = true;
    let result: T;
    try {
      connection.exec("BEGIN IMMEDIATE");
      try {
        result = body(writes);
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    } finally {
      inside = false;
    }
    for (const id of [...touched].sort((a, b) => a - b)) {
      const ticket = get(id);
      if (ticket !== undefined) {
        announce(ticket);
      }
    }
    return result;
  };

  const move = (id: number, to: TicketState, reason?: GeneratedText): MoveResult => {
    const current = get(id);
    if (current === undefined) {
      return { ok: false, error: "not_found" };
    }
    if (!canMoveTicket(current.kind, current.state, to)) {
      return { ok: false, error: "refused", ticket: current };
    }
    const ticket = change((writes) => writes.move(id, to, reason));
    return { ok: true, ticket: get(id) ?? ticket };
  };

  return {
    open: (request) => {
      check(request);
      const id = change((writes) => writes.open(request));
      const ticket = get(id);
      if (ticket === undefined) {
        throw new Error(`Ticket ${id} was not stored`);
      }
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
    waitingFor: (id) =>
      selectWaitingFor.all(id).flatMap((row) => {
        const ticket = get(IdRow.parse(row).ticket_id);
        return ticket === undefined ? [] : [ticket];
      }),
    move,
    stop: (id, reason) => {
      const given = GeneratedText.parse(reason);
      const result = move(id, "stopped", given);
      if (result.ok) {
        work.stop(result.ticket);
      }
      return result;
    },
    change,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
