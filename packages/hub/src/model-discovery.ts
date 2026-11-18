import { text } from "@super-agent2/catalog";
import { programIds, type MachineStatus, type ProgramId } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";
import type { StartDefaults } from "./defaults.js";

export function createModelDiscovery(database: HubDatabase, defaults: StartDefaults, tell: (notice: string, prompt: string) => void) {
  const db = database.connection;
  const read = db.prepare("SELECT value FROM hub_settings WHERE key = ?");
  const save = db.prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  const scan = (statuses: readonly MachineStatus[]) => {
    for (const engine of programIds) {
      const offers = statuses.flatMap((machine) => (machine.report?.programs ?? []).filter((program) => program.id === engine && program.installed).flatMap((program) => program.models.map((model) => ({ machine: machine.name, ...model }))));
      if (offers.length === 0) continue;
      const key = `known_models_${engine}`;
      const row = z.object({ value: z.string() }).safeParse(read.get(key));
      const known = row.success ? z.array(z.string()).parse(JSON.parse(row.data.value)) : [];
      const fresh = [...new Set(offers.map((offer) => offer.id).filter((id) => !known.includes(id)))];
      if (fresh.length === 0) continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (row.success) {
          const details = fresh.map((id) => {
            const found = offers.filter((offer) => offer.id === id);
            return `${id}: ${found.map((offer) => `${offer.machine} (efforts: ${offer.efforts.join(", ") || "none"})`).join("; ")}`;
          });
          tell(text("notice.newModels", { engine, models: fresh.join(", ") }), [
            `[hub] New models were reported for ${engine}:`, ...details,
            `Current start-defaults row: ${JSON.stringify(defaults.table()[engine as ProgramId])}`,
            "Ask the owner in Chinese whether to change this row. Suggest which difficulty, if any, should use a new model and effort, or say you would keep the row, with your reasoning. Only change it after the owner agrees, using set_engine_row. The owner can also edit it in Settings → Models.",
          ].join("\n"));
        }
        save.run(key, JSON.stringify([...known, ...fresh]), Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
  return { scan };
}
