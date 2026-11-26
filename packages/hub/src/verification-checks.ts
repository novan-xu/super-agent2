import { randomUUID } from "node:crypto";
import { CheckResult, type RunCheck } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import type { Runners } from "./runners.js";

const Assignment = z.object({
  id: z.string(), ticket_id: z.number(), entry: z.number(), head: z.string(), machine: z.string(), assigned_at: z.number(), result: z.string().nullable(),
});
type Assignment = z.infer<typeof Assignment>;
type Request = Omit<RunCheck, "type" | "id"> & { readonly entry: number; readonly preferred: string | null };
type Status = { readonly kind: "waiting"; readonly reason: string; readonly assignment?: Assignment }
  | { readonly kind: "finished"; readonly machine: string; readonly result: Extract<CheckResult, { state: "finished" }> };

export function createVerificationChecks(database: HubDatabase, clock: Clock, runners: Runners | undefined, changed: (ticket: number) => void) {
  const db = database.connection;
  const byRequest = db.prepare("SELECT * FROM repository_checks WHERE ticket_id = ? AND entry = ? AND head = ?");
  const byId = db.prepare("SELECT * FROM repository_checks WHERE id = ? AND machine = ? AND result IS NULL");
  const active = db.prepare("SELECT * FROM repository_checks WHERE repository = ? AND result IS NULL");
  const store = db.prepare("INSERT INTO repository_checks (id, ticket_id, entry, repository, head, machine, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const finish = db.prepare("UPDATE repository_checks SET result = ? WHERE id = ?");
  const discard = db.prepare("DELETE FROM repository_checks WHERE id = ?");
  const current = db.prepare(`
    SELECT 1 FROM tickets t JOIN ticket_verifications v ON t.id = v.ticket_id
    WHERE t.id = ? AND t.state = 'verifying' AND v.entry = ? AND v.head = ? AND v.rule = 'check'
      AND v.skip_at IS NULL AND v.waiting IS NOT 'closed'
  `);
  const retired = db.prepare(`
    SELECT c.* FROM repository_checks c JOIN tickets t ON t.id = c.ticket_id
    LEFT JOIN ticket_verifications v ON v.ticket_id = c.ticket_id
    WHERE c.result IS NULL AND (t.state <> 'verifying' OR v.entry IS NOT c.entry OR v.head IS NOT c.head
      OR v.rule IS NOT 'check' OR v.skip_at IS NOT NULL OR v.waiting = 'closed')
  `);
  const declined = new Map<number, { entry: number; head: string; machines: Map<string, string> }>();

  const unbind = runners?.bindChecks((machine, { id, result }) => {
    const raw = byId.get(id, machine);
    if (raw === undefined || result.state === "busy") return;
    const row = Assignment.parse(raw);
    if (current.get(row.ticket_id, row.entry, row.head) === undefined) {
      discard.run(id);
      return;
    }
    if (result.state === "unavailable") {
      let tried = declined.get(row.ticket_id);
      if (tried?.entry !== row.entry || tried.head !== row.head) {
        tried = { entry: row.entry, head: row.head, machines: new Map() };
        declined.set(row.ticket_id, tried);
      }
      tried.machines.set(machine, result.reason);
      discard.run(id);
    } else {
      finish.run(JSON.stringify(result), id);
      declined.delete(row.ticket_id);
    }
    changed(row.ticket_id);
  });

  return {
    evaluate: ({ entry, preferred, ...request }: Request): Status => {
      const raw = byRequest.get(request.ticket, entry, request.head);
      if (raw !== undefined) {
        const assignment = Assignment.parse(raw);
        if (assignment.result !== null) {
          const result = CheckResult.parse(JSON.parse(assignment.result));
          if (result.state !== "finished") throw new Error("A repository check was saved without a final result");
          return { kind: "finished", machine: assignment.machine, result };
        }
        const online = runners?.sendCheck(assignment.machine, { type: "check.run", ...request, id: assignment.id });
        return { kind: "waiting", reason: online ? `Waiting for the check on ${assignment.machine}` : `Waiting for ${assignment.machine} to reconnect with its check`, assignment };
      }
      const held = active.get(request.repository);
      if (held !== undefined) {
        const other = Assignment.parse(held);
        return { kind: "waiting", reason: `Waiting for the repository's current check on ${other.machine}` };
      }
      const tried = declined.get(request.ticket);
      const rejected = tried?.entry === entry && tried.head === request.head ? tried.machines : undefined;
      const available = runners?.statuses().filter(({ name, online, report }) => online && report?.repositoryChecks === true
        && report.slots.free > 0 && report.load?.high !== true && !rejected?.has(name)) ?? [];
      const selected = available.find(({ name }) => name === preferred) ?? available[0];
      if (selected === undefined) {
        declined.delete(request.ticket);
        const notes = rejected === undefined ? "" : ` (${[...rejected].map(([machine, reason]) => `${machine}: ${reason}`).join("; ")})`;
        return { kind: "waiting", reason: `Waiting for an available runner with ${request.repository}${notes}` };
      }
      const id = randomUUID();
      const assignment = { id, ticket_id: request.ticket, entry, head: request.head, machine: selected.name, assigned_at: clock.now(), result: null };
      store.run(id, request.ticket, entry, request.repository, request.head, selected.name, assignment.assigned_at);
      runners?.sendCheck(selected.name, { type: "check.run", ...request, id });
      return { kind: "waiting", reason: `Waiting for the check on ${selected.name}`, assignment };
    },
    cancelRetired: () => {
      for (const raw of retired.all()) {
        const row = Assignment.parse(raw);
        runners?.sendCheck(row.machine, { type: "check.cancel", id: row.id });
      }
    },
    close: () => { unbind?.(); declined.clear(); },
  };
}
