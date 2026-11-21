import { z } from "zod";
import { ConversationId, MessageId } from "./conversations.js";
import { RepositoryName } from "./repositories.js";
import { TicketId, TicketState } from "./tickets.js";

export const ScheduleId = z.uuid();
export const ScheduleRecurrence = z.union([
  z.strictObject({ cron: z.string().trim().max(100).regex(/^[0-9*,/-]+(?: +[0-9*,/-]+){4}$/) }),
  z.strictObject({ at: z.number().int().positive().max(8_640_000_000_000_000) }),
]);
export type ScheduleRecurrence = z.infer<typeof ScheduleRecurrence>;

export const ScheduleFields = z.strictObject({
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(12_000),
  repository: RepositoryName.optional(),
  machine: z.string().trim().min(1).max(100).optional(),
  recurrence: ScheduleRecurrence,
});
export type ScheduleFields = z.infer<typeof ScheduleFields>;

export const ScheduleState = z.enum(["active", "paused", "completed"]);
export const ScheduleRunState = z.enum(["queued", "running", "completed", "skipped", "failed", "interrupted", "cancelled"]);

export const ScheduleRun = z.object({
  id: ScheduleId,
  dueAt: z.number().int(),
  at: z.number().int(),
  state: ScheduleRunState,
  topic: ConversationId,
  entry: MessageId,
  tickets: z.array(z.object({ id: TicketId, title: z.string(), light: z.boolean(), state: TicketState })),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const Schedule = ScheduleFields.extend({
  id: ScheduleId,
  topic: ConversationId,
  topicRepository: RepositoryName.nullable(),
  state: ScheduleState,
  nextAt: z.number().int().nullable(),
  confirmedAt: z.number().int(),
  revision: z.number().int().positive(),
  lastRun: ScheduleRun.nullable(),
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleList = z.object({ timeZone: z.string(), schedules: z.array(Schedule) });
export type ScheduleList = z.infer<typeof ScheduleList>;

export const ScheduleHistory = z.object({ runs: z.array(ScheduleRun) });
export type ScheduleHistory = z.infer<typeof ScheduleHistory>;

export const ScheduleAction = z.enum(["pause", "resume", "delete"]);
export type ScheduleAction = z.infer<typeof ScheduleAction>;

export const ScheduleSave = z.strictObject({ fields: ScheduleFields, revision: z.number().int().positive().optional() });
