import { z } from "zod";

export const tickTickSyncPath = "/api/settings/ticktick-sync";
export const TickTickSyncChange = z.strictObject({ enabled: z.boolean() });
export const TickTickSyncEvent = z.enum(["synced", "retry", "repeating", "skipped"]);
export type TickTickSyncEvent = z.infer<typeof TickTickSyncEvent>;
export const TickTickSyncStatus = z.object({
  enabled: z.boolean(),
  state: z.enum(["off", "ready", "syncing", "retry", "unavailable", "reconnect"]),
  lastSync: z.number().int().nonnegative().nullable(),
  log: z.array(z.object({ at: z.number().int().nonnegative(), event: TickTickSyncEvent, count: z.number().int().nonnegative() })),
});
export type TickTickSyncStatus = z.infer<typeof TickTickSyncStatus>;
