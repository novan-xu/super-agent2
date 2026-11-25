import { createHash } from "node:crypto";
import { isOpenTicket, ticketReference, WorkEngine, type GitHubAccount, type Ticket } from "@super-agent2/protocol";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import { createGitHubApi } from "./github-api.js";
import type { TicketTurn } from "./ticket-versions.js";
import type { TicketService } from "./tickets.js";

const Link = z.object({
  ticket_id: z.number().int(),
  original: z.number().int(),
  previous: z.number().int(),
  folder: z.number().int(),
  issue: z.number().int(),
  comment: z.string(),
  url: z.url(),
});

const Source = z.object({
  ticket_id: z.number().int(),
  attempt: z.number().int(),
  machine: z.string(),
  engine: WorkEngine,
  model: z.string(),
  effort: z.string(),
  session: z.string().nullable(),
});

const Mode = z.object({ outcome: z.enum(["resumed", "takeover"]) });

export function createFollowUpRecords({ connection }: HubDatabase) {
  const select = connection.prepare("SELECT * FROM ticket_follow_ups WHERE ticket_id = ?");
  const history = connection.prepare("SELECT * FROM ticket_follow_ups WHERE original = ? ORDER BY ticket_id DESC");
  const active = connection.prepare(`
    WITH RECURSIVE linked(id) AS (
      SELECT ticket_id FROM ticket_follow_ups WHERE original = ?
      UNION
      SELECT r.ticket_id FROM ticket_repairs r JOIN linked l ON r.repairs = l.id
    )
    SELECT t.id FROM tickets t JOIN linked l ON l.id = t.id
    WHERE t.state IN ('pending', 'waiting', 'working', 'verifying', 'stuck') LIMIT 1
  `);
  const insert = connection.prepare("INSERT INTO ticket_follow_ups (ticket_id, original, previous, folder, issue, comment, url) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const worked = connection.prepare(`
    SELECT ticket_id, attempt, machine, engine, model, effort, COALESCE(session, resume_session) AS session
    FROM ticket_attempts WHERE ticket_id = ? AND started_at IS NOT NULL ORDER BY attempt DESC LIMIT 1
  `);
  const result = connection.prepare(`
    SELECT json_extract(event, '$.outcome') AS outcome FROM ticket_work_events
    WHERE ticket_id = ? AND attempt = (SELECT MAX(attempt) FROM ticket_attempts WHERE ticket_id = ticket_work_events.ticket_id)
      AND json_extract(event, '$.kind') = 'follow-up' ORDER BY id DESC LIMIT 1
  `);
  return {
    get: (id: number) => Link.optional().parse(select.get(id)),
    history: (original: number) => history.all(original).map((row) => Link.parse(row)),
    active: (original: number): number | undefined => z.number().int().optional().parse(active.get(original)?.["id"]),
    insert: (link: z.infer<typeof Link>) => insert.run(link.ticket_id, link.original, link.previous, link.folder, link.issue, link.comment, link.url),
    source: (previous: number) => Source.optional().parse(worked.get(previous)),
    outcome: (id: number) => Mode.optional().parse(result.get(id))?.outcome,
  };
}

interface FollowUpOptions {
  readonly records: ReturnType<typeof createFollowUpRecords>;
  readonly tickets: TicketService;
  readonly credentials: CredentialSource;
  readonly accountOf: (repository: string) => GitHubAccount;
  readonly fetch: typeof fetch;
  readonly base: string | undefined;
}

type FollowUpOutcome =
  | { readonly ok: true; readonly ticket: Ticket; readonly url: string }
  | { readonly ok: false; readonly reason: string };

export function createFollowUps({ records, tickets, credentials, accountOf, fetch, base }: FollowUpOptions) {
  const busy = new Set<string>();
  const tipOf = (ticket: Ticket): Ticket => {
    while (ticket.repairedBy !== null) {
      const next = tickets.get(ticket.repairedBy);
      if (next === undefined) break;
      ticket = next;
    }
    return ticket;
  };

  return async (id: number, number: number, comment: string, turn: TicketTurn): Promise<FollowUpOutcome> => {
    const given = tickets.get(id);
    if (given === undefined) return { ok: false, reason: "There is no such ticket." };
    if (given.form !== "code" || given.state !== "merged" || given.repository === null) {
      return { ok: false, reason: `Ticket ${ticketReference(given)} is a ${given.form} ticket in state ${given.state}. Follow-ups require a merged code ticket.` };
    }
    const issue = given.issues.find((entry) => entry.number === number);
    if (issue === undefined) return { ok: false, reason: `Issue #${number} was not in ticket ${ticketReference(given)}.` };
    const inherited = [given, ...tickets.lineage(id).reverse()].map((ticket) => records.get(ticket.id)).find((link) => link !== undefined);
    const original = tickets.get(inherited?.original ?? given.id) ?? given;
    const history = records.history(original.id);
    const descendants = history.flatMap((link) => {
      const ticket = tickets.get(link.ticket_id);
      return ticket === undefined ? [] : [{ ticket: tipOf(ticket), link }];
    });
    const active = descendants.find(({ ticket }) => isOpenTicket(ticket.state));
    if (active !== undefined) {
      if (active.link.issue === number && active.link.comment === comment) return { ok: true, ticket: active.ticket, url: active.link.url };
      return { ok: false, reason: `The original work already has an open follow-up, ticket ${ticketReference(active.ticket)}.` };
    }
    const repository = given.repository;
    const competing = () => tickets.forIssue(repository, number).find((ticket) => isOpenTicket(ticket.state));
    const live = competing();
    if (live !== undefined) return { ok: false, reason: `Issue #${number} is already in open ticket ${ticketReference(live)}.` };
    const keys = [`ticket ${original.id}`, `${repository.toLowerCase()}#${number}`];
    if (keys.some((key) => busy.has(key))) return { ok: false, reason: "A follow-up is already being recorded for this work. Check its result before retrying." };
    const previous = descendants.find(({ ticket }) => ticket.state === "merged")?.ticket ?? given;
    const folder = inherited?.folder ?? tickets.lineage(original.id)[0]?.id ?? original.id;
    const credential = credentials(accountOf(repository));
    if (!credential.ok) return { ok: false, reason: credential.reason };
    const token = credential.credentials["GH_TOKEN"];
    if (token === undefined) return { ok: false, reason: `There is no GitHub token for ${repository}.` };
    const github = createGitHubApi({ token, fetch, ...(base === undefined ? {} : { base }) });
    const key = createHash("sha256").update(JSON.stringify([original.id, previous.id, number, comment])).digest("hex");
    const body = `**Follow-up from Super Agent for ticket ${ticketReference(original)}**\n\n${comment}\n\n<!-- super-agent2-follow-up:${key} -->`;
    let url: string | null = null;
    keys.forEach((value) => busy.add(value));
    try {
      const current = await github.issue(repository, number);
      if (current === null) return { ok: false, reason: `GitHub could not find issue #${number} in ${repository}.` };
      url = await github.findIssueComment(repository, number, body);
      if (url === null) {
        tickets.versions.requireActive(turn);
        url = await github.postIssueComment(repository, number, body);
      }
      if (current.state === "closed") {
        tickets.versions.requireActive(turn);
        await github.reopenIssue(repository, number);
      }
      const commentUrl = url;
      const ticket = tickets.change((writes) => {
        if (records.active(original.id) !== undefined) throw new Error("The original work already has an open follow-up.");
        if (competing() !== undefined) throw new Error(`Issue #${number} is already in an open ticket.`);
        const difficulty = previous.difficulty ?? original.difficulty ?? "standard";
        const platform = previous.platform ?? original.platform ?? "any";
        const next = writes.open({
          repository, issues: [issue], title: issue.title, summary: issue.summary, kind: given.kind,
          difficulty, platform, conversation: turn.conversation,
        });
        writes.state(next, {
          kind: given.kind, difficulty, platform, difficultyReason: previous.difficultyReason ?? original.difficultyReason ?? given.summary,
        });
        writes.inheritPins(next, previous);
        records.insert({ ticket_id: next, original: original.id, previous: previous.id, folder, issue: number, comment, url: commentUrl });
        return writes.get(next);
      }, turn);
      if (ticket === undefined) throw new Error("The follow-up ticket was not stored.");
      return { ok: true, ticket, url };
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: url === null ? problem : `The adjustment is recorded at ${url}. The follow-up ticket was not opened: ${problem}` };
    } finally {
      keys.forEach((value) => busy.delete(value));
    }
  };
}
