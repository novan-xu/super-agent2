import { GeneratedText, LightTaskMode, Platform, Difficulty, CodeEngineChoice, RepositoryName, TaskMaterial, type ProgramId, type Ticket } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import { confirmationLifetime, ownerConfirmation } from "./owner-confirmation.js";
import { TicketWriteRefused, type TicketTurn } from "./ticket-versions.js";
import { TicketError, type TicketService } from "./tickets.js";

export const LightTaskRequest = z.strictObject({
  title: GeneratedText,
  summary: GeneratedText,
  task: z.string().trim().min(1),
  kind: z.enum(["writing", "operation"]),
  project: RepositoryName.optional(),
  materials: z.array(TaskMaterial),
  mode: LightTaskMode.default("transfer"),
  platform: Platform.default("any"),
  difficulty: Difficulty.default("standard"),
  reason: GeneratedText,
  engine: CodeEngineChoice.optional(),
});
export type LightTaskRequest = z.infer<typeof LightTaskRequest>;

const Proposal = z.object({
  id: z.string(), title: z.string(), created_at: z.number(), ticket: z.number().nullable(), stream_seq: z.number(),
  project: RepositoryName.nullable(),
});

export function createLightTasks(database: HubDatabase, clock: Clock, tickets: TicketService, conversations: () => ConversationService, grant: (ticket: number, attachments: LightTaskRequest["materials"]) => void) {
  const { connection } = database;
  const owner = ownerConfirmation(database);
  const proposalOf = connection.prepare(`SELECT p.id, p.created_at, p.ticket, e.stream_seq,
    json_extract(p.request, '$.title.en') AS title, json_extract(p.request, '$.project') AS project
    FROM light_task_proposals p JOIN conversation_entries e ON e.id = p.id
    WHERE p.topic = ? AND e.conversation_id = p.topic ORDER BY e.stream_seq DESC LIMIT 1`);
  const requestOf = connection.prepare("SELECT request FROM light_task_proposals WHERE id = ?");
  const insert = connection.prepare("INSERT INTO light_task_proposals (id, topic, request, created_at) VALUES (?, ?, ?, ?)");
  const markStarted = connection.prepare("UPDATE light_task_proposals SET ticket = ? WHERE id = ? AND ticket IS NULL");

  const lastProposal = (topic: string) => Proposal.optional().parse(proposalOf.get(topic));
  const open = (request: LightTaskRequest, engine: ProgramId | undefined, turn: TicketTurn, proposal?: string) =>
    tickets.change((writes) => {
      if (engine === "antigravity" && request.kind === "operation") throw new TicketWriteRefused("An operation requires a code engine.");
      if (request.kind === "operation" && request.engine === undefined) throw new TicketWriteRefused("Choose codex or claude for this operation using read_allowance.");
      if (request.mode === "agent_wring" && request.kind !== "operation") throw new TicketWriteRefused("Agent_wring work is an operation.");
      const ticket = writes.open({
        form: "task", light: request.mode, repository: null, project: request.project, issues: [], title: request.title, summary: request.summary,
        kind: request.kind, conversation: turn.conversation, task: { task: request.task, materials: request.materials },
      });
      writes.state(ticket, { kind: request.kind, difficulty: request.difficulty, difficultyReason: request.reason, platform: request.platform, brainEngine: request.engine ?? null });
      if (engine !== undefined) writes.ownerChoice(ticket, { machine: null, engine, model: null, effort: null });
      grant(ticket, request.materials);
      if (proposal !== undefined) {
        markStarted.run(ticket, proposal);
        writes.move(ticket, "waiting");
      }
      const stored = writes.get(ticket);
      if (stored === undefined) throw new TicketError("The light task could not be read after opening.");
      return stored;
    }, turn);

  return {
    context: (topic: string, message: string): string => {
      const proposal = lastProposal(topic);
      if (proposal?.ticket !== null || !owner.messageAfter(topic, message, proposal.stream_seq) || !tickets.lightTopicAllows(topic, proposal.project ?? undefined)) return "";
      const title = JSON.stringify(proposal.title);
      return clock.now() - proposal.created_at < confirmationLifetime
        ? `\n\n[hub] Current light task proposal ${proposal.id}: ${title}. Call start_light_task only if this owner message agrees to the proposal. If the scope changed, propose again.`
        : `\n\n[hub] The light task proposal for ${title} expired. If the owner still wants the work, confirm it with a new proposal.`;
    },
    propose: (request: LightTaskRequest, confirmation: string, turn: TicketTurn): string => {
      tickets.versions.requireActive(turn);
      if (!tickets.lightTopicAllows(turn.conversation, request.project)) {
        throw new TicketWriteRefused("A light task needs an active daily topic or a topic for its project. Use a matching topic if this one has conflicting work.");
      }
      const previous = lastProposal(turn.conversation);
      if (!owner.turnAfter(turn, previous?.stream_seq ?? 0)) {
        if (previous?.ticket === null) return previous.id;
        throw new TicketWriteRefused("Proposing a light task requires a new owner request in this topic.");
      }
      if (request.kind === "operation" && request.engine === undefined) throw new TicketWriteRefused("Choose codex or claude for this operation using read_allowance.");
      if (request.mode === "agent_wring" && request.kind !== "operation") throw new TicketWriteRefused("Agent_wring work is an operation.");
      connection.exec("BEGIN IMMEDIATE");
      let id: string;
      try {
        id = conversations().writeConfirmation(turn.conversation, turn.id, confirmation);
        insert.run(id, turn.conversation, JSON.stringify(request), clock.now());
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
      conversations().announceEntry(id);
      return id;
    },
    start: (id: string, engine: ProgramId | undefined, turn: TicketTurn): Ticket => {
      tickets.versions.requireActive(turn);
      const proposal = lastProposal(turn.conversation);
      if (proposal === undefined || proposal.id !== id) throw new TicketWriteRefused("This is not the current light task proposal in this topic.");
      if (proposal.ticket === null) {
        if (clock.now() - proposal.created_at >= confirmationLifetime) throw new TicketWriteRefused("This light task proposal expired. Confirm the task again.");
        if (!owner.turnAfter(turn, proposal.stream_seq)) throw new TicketWriteRefused("A newer owner message in this topic must be taken into the current turn after the confirmation.");
        const request = LightTaskRequest.parse(JSON.parse(z.string().parse(requestOf.get(id)?.request)));
        const started = open(request, engine, turn, id);
        return tickets.get(started.id) ?? started;
      }
      const ticket = tickets.get(proposal.ticket);
      if (ticket === undefined) throw new TicketError("The light task could not be read after starting.");
      return ticket;
    },
    scheduled: (request: LightTaskRequest, turn: TicketTurn): Ticket => {
      tickets.versions.requireActive(turn);
      const run = tickets.scheduleForTurn(turn);
      if (run === undefined || !run.authorized) throw new TicketWriteRefused("An active scheduled run is required.");
      return open(request, undefined, turn);
    },
  };
}

export type LightTasks = ReturnType<typeof createLightTasks>;
