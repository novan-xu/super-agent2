import { text } from "@super-agent2/catalog";
import { type MachineStatus, programIsConfigured } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import type { StartDefaults } from "./defaults.js";
import type { Runners } from "./runners.js";
import type { PushService } from "./push-service.js";
import type { Ticker } from "./verification.js";

const grace = 10 * 60 * 1000;
const Incident = z.object({ key: z.string(), kind: z.string(), since: z.number(), active: z.number(), description: z.string() });
type Candidate = { kind: "machine" | "program" | "provider"; description: string; delay: number };
const limitWords = /quota|rate.?limit|usage.?limit|\blimit\b|额度|配额|subscription.*(?:exhaust|used.up)|resource.?exhausted|too many requests|\b429\b|balance|credits|spend.?cap/i;
const oneLine = (value: string) => [...value.replace(/\s+/gu, " ").trim()].slice(0, 300).join("");
const overloadWords = /overload|capacity|service unavailable|server.error|\b50[0234]\b/i;

export function createHealthNotices(options: {
  database: HubDatabase;
  clock: Clock;
  runners: Runners;
  defaults: StartDefaults;
  conversations: ConversationService;
  push?: PushService | undefined;
  ticker?: Ticker | undefined;
  report: (line: string) => void;
}) {
  const db = options.database.connection;
  const all = db.prepare("SELECT * FROM health_incidents ORDER BY key");
  const save = db.prepare("INSERT INTO health_incidents (key, kind, since, active, description) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET active = excluded.active, description = excluded.description");
  const remove = db.prepare("DELETE FROM health_incidents WHERE key = ?");
  let scanning = false;
  const scan = () => {
    if (scanning) return;
    scanning = true;
    try {
      const now = options.clock.now();
      const statuses = options.runners.statuses();
      const byName = new Map(statuses.map((machine) => [machine.name, machine]));
      const candidates = new Map<string, Candidate>();
      for (const machine of statuses) {
        if (!machine.online) {
          candidates.set(`machine:${machine.name}`, { kind: "machine", description: text("notice.healthOffline", { name: machine.name }), delay: grace });
          continue;
        }
        if (machine.report?.updatingPrograms === true) continue;
        for (const program of machine.report?.programs ?? []) {
          if (!programIsConfigured(program)) continue;
          const probeProblems = (program.problem ?? "").split("; ").filter((part) => part !== "" && !part.startsWith("auto-update:"));
          const problems = probeProblems.filter((part) => !limitWords.test(part));
          if (probeProblems.length > 0 && problems.length === 0) continue;
          const problem = problems.join("; ");
          const reason = problem || (program.version === null ? "no version reported" : program.models.length === 0 ? "no models reported" : "");
          if (reason !== "") candidates.set(`program:${machine.name}:${program.id}`, { kind: "program", description: oneLine(`${machine.name} / ${program.id}: ${reason}`), delay: 0 });
        }
      }
      for (const mark of options.defaults.healthMarks()) {
        if (mark.category === "limit" || (mark.category === null && limitWords.test(mark.reason))) continue;
        candidates.set(`provider:${mark.program}`, { kind: "provider", description: oneLine(`${mark.program}: ${mark.reason || "unavailable"}`), delay: mark.category === "overload" || overloadWords.test(mark.reason) ? grace : 0 });
      }
      const existing = new Map(all.all().map((row) => { const value = Incident.parse(row); return [value.key, value] as const; }));
      const notices: { result: ReturnType<ConversationService["writeHealthNotice"]>; message: string; key: string; start: boolean }[] = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [key, candidate] of candidates) {
          const old = existing.get(key);
          const since = old?.since ?? now;
          const active = old?.active === 1 || now - since >= candidate.delay;
          save.run(key, candidate.kind, since, active ? 1 : 0, candidate.description);
          if (active && old?.active !== 1) {
            const message = text("notice.healthProblem", { description: candidate.description });
            notices.push({ result: options.conversations.writeHealthNotice(message), message, key, start: true });
          }
        }
        for (const [key, old] of existing) {
          if (candidates.has(key)) continue;
          if (old.kind === "program") {
            const machineName = key.split(":")[1];
            const machine: MachineStatus | undefined = machineName === undefined ? undefined : byName.get(machineName);
            if (machine !== undefined && (!machine.online || machine.report?.updatingPrograms === true)) continue;
          }
          remove.run(key);
          if (old.active === 1) {
            const message = text("notice.healthRecovered", { description: old.description });
            notices.push({ result: options.conversations.writeHealthNotice(message), message, key, start: false });
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      for (const notice of notices) {
        options.conversations.publishHealthNotice(notice.result);
        if (notice.start && notice.result.topics[0] !== undefined) options.push?.health(notice.message, notice.result.topics[0], notice.key);
      }
    } catch (error) {
      options.report(`Checking machine and provider health failed: ${String(error)}`);
    } finally {
      scanning = false;
    }
  };
  const unsubscribeRunners = options.runners.subscribe(scan);
  const unsubscribeDefaults = options.defaults.subscribe(scan);
  const ticker = options.ticker ?? ((tick: () => void) => {
    const timer = setInterval(tick, 30_000);
    timer.unref();
    return () => clearInterval(timer);
  });
  const stop = ticker(scan);
  scan();
  return { close: () => { stop(); unsubscribeRunners(); unsubscribeDefaults(); } };
}
