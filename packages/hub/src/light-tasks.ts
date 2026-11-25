import { GeneratedText, LightTaskMode, Platform, Difficulty, RepositoryName, TaskMaterial, MachineName, ProgramId, type Ticket } from "@super-agent2/protocol";
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
  machine: MachineName.describe("Machine explicitly requested by the owner. Preserve the requested machine if it is busy or offline.").optional(),
  ownerEngine: ProgramId.describe("Provider explicitly requested by the owner. Wait if the provider is unavailable.").optional(),
  reason: GeneratedText,
});
export type LightTaskRequest = z.infer<typeof LightTaskRequest>;

export function createLightTasks(database: HubDatabase, tickets: TicketService, grant: (ticket: number, attachments: LightTaskRequest["materials"]) => void) {
  const owner = ownerConfirmation(database);
  const started = new Map<string, number>();
  const open = (request: LightTaskRequest, turn: TicketTurn, dispatch = false) =>
    tickets.change((writes) => {
      const ticket = writes.open({
        form: "task", light: request.mode, repository: null, project: request.project, issues: [], title: request.title, summary: request.summary,
        kind: request.kind, conversation: turn.conversation, task: { task: request.task, materials: request.materials },
      });
      writes.state(ticket, { kind: request.kind, difficulty: request.difficulty, difficultyReason: request.reason, platform: request.platform });
      writes.pins(ticket, request);
      grant(ticket, request.materials);
      if (dispatch) writes.move(ticket, "waiting");
      const stored = writes.get(ticket);
      if (stored === undefined) throw new TicketError("The light task could not be read after opening.");
      return stored;
    }, turn);

  return {
    start: (request: LightTaskRequest, turn: TicketTurn): Ticket => {
      tickets.versions.requireActive(turn);
      if (!owner.turnAfter(turn, 0)) throw new TicketWriteRefused("Starting a light task requires an owner message taken into the current turn of this topic.");
      const key = JSON.stringify([turn.conversation, turn.id, request]);
      const existing = started.get(key);
      if (existing !== undefined) {
        const ticket = tickets.get(existing);
        if (ticket !== undefined) return ticket;
      }
      if (!tickets.lightTopicAllows(turn.conversation, request.project)) {
        throw new TicketWriteRefused("A light task needs an active daily topic or a repository topic matching its project.");
      }
      const ticket = open(request, turn, true);
      started.set(key, ticket.id);
      if (started.size > 1000) started.delete(started.keys().next().value!);
      return tickets.get(ticket.id) ?? ticket;
    },
    scheduled: (request: LightTaskRequest, turn: TicketTurn): Ticket => {
      tickets.versions.requireActive(turn);
      const run = tickets.scheduleForTurn(turn);
      if (run === undefined || !run.authorized) throw new TicketWriteRefused("An active scheduled run is required.");
      return open(request, turn);
    },
  };
}

export type LightTasks = ReturnType<typeof createLightTasks>;
