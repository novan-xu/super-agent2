import { GeneratedText, LightTaskMode, Platform, Difficulty, CodeEngineChoice, RepositoryName, TaskMaterial, type ProgramId, type Ticket } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";
import { ownerConfirmation } from "./owner-confirmation.js";
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

export function createLightTasks(database: HubDatabase, tickets: TicketService, grant: (ticket: number, attachments: LightTaskRequest["materials"]) => void) {
  const owner = ownerConfirmation(database);
  const started = new Map<string, number>();
  const open = (request: LightTaskRequest, engine: ProgramId | undefined, turn: TicketTurn, dispatch = false) =>
    tickets.change((writes) => {
      if (engine === "antigravity" && request.kind === "operation") throw new TicketWriteRefused("An operation requires a code engine.");
      if (request.kind === "operation" && request.engine === undefined) throw new TicketWriteRefused("Choose codex or claude for this operation using read_allowance.");
      const ticket = writes.open({
        form: "task", light: request.mode, repository: null, project: request.project, issues: [], title: request.title, summary: request.summary,
        kind: request.kind, conversation: turn.conversation, task: { task: request.task, materials: request.materials },
      });
      writes.state(ticket, { kind: request.kind, difficulty: request.difficulty, difficultyReason: request.reason, platform: request.platform, brainEngine: request.engine ?? null });
      if (engine !== undefined) writes.ownerChoice(ticket, { machine: null, engine, model: null, effort: null });
      grant(ticket, request.materials);
      if (dispatch) writes.move(ticket, "waiting");
      const stored = writes.get(ticket);
      if (stored === undefined) throw new TicketError("The light task could not be read after opening.");
      return stored;
    }, turn);

  return {
    start: (request: LightTaskRequest, engine: ProgramId | undefined, turn: TicketTurn): Ticket => {
      tickets.versions.requireActive(turn);
      if (!owner.turnAfter(turn, 0)) throw new TicketWriteRefused("Starting a light task requires an owner message taken into the current turn of this topic.");
      const key = JSON.stringify([turn.conversation, turn.id, request, engine]);
      const existing = started.get(key);
      if (existing !== undefined) {
        const ticket = tickets.get(existing);
        if (ticket !== undefined) return ticket;
      }
      if (!tickets.lightTopicAllows(turn.conversation, request.project)) {
        throw new TicketWriteRefused("A light task needs an active daily topic or a topic for its project. Use a matching topic if this one has conflicting work.");
      }
      const ticket = open(request, engine, turn, true);
      started.set(key, ticket.id);
      if (started.size > 1000) started.delete(started.keys().next().value!);
      return tickets.get(ticket.id) ?? ticket;
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
