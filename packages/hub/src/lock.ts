import { createHash } from "node:crypto";
import { text } from "@super-agent2/catalog";
import { type CommandRecord, Hold, type HoldAnswer } from "@super-agent2/protocol";
import { z } from "zod";
import type { AccessVerifier } from "./access.js";
import type { Clock } from "./clock.js";
import type { CommandGate, GateDecision } from "./commands.js";
import type { HubDatabase } from "./database.js";
import { findIrreversible, type LockSettings } from "./irreversible.js";

export const refusedReason = text("command.reason.refused");

export const withdrawnReason = text("command.reason.withdrawn");

export const changedReason = text("command.reason.changed");

export interface OwnerAnswer {
  readonly assertion: string | undefined;
  readonly fingerprint: string;
}

export type AnswerError = "forbidden" | "not_found" | "conflict";

export type AnswerOutcome = { readonly ok: true; readonly hold: Hold } | { readonly ok: false; readonly error: AnswerError };

export interface ConfirmationLock {
  readonly gate: CommandGate;
  waiting(): Hold[];
  get(id: string): Hold | undefined;
  release(id: string, answer: OwnerAnswer): Promise<AnswerOutcome>;
  refuse(id: string, answer: OwnerAnswer): Promise<AnswerOutcome>;
}

export interface ConfirmationLockOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly verify: AccessVerifier;
  readonly ownerEmail: string;
  readonly settings: LockSettings;
}

export function fingerprintOf(command: CommandRecord): string {
  return createHash("sha256").update(JSON.stringify([command.id, command.target, command.command, command.account, command.cwd])).digest("hex");
}

export function holdReason(description: string, evidence: string): string {
  return text("hold.reason", { description, evidence });
}

const HoldRow = z.object({
  command_id: z.string(),
  form: z.string(),
  description: z.string(),
  evidence: z.string(),
  fingerprint: z.string(),
  held_at: z.number().int(),
  answer: z.string().nullable(),
  answered_at: z.number().int().nullable(),
  answered_by: z.string().nullable(),
});

function toHold(row: unknown): Hold {
  const value = HoldRow.parse(row);
  return Hold.parse({
    command: value.command_id,
    form: value.form,
    description: value.description,
    evidence: value.evidence,
    fingerprint: value.fingerprint,
    heldAt: value.held_at,
    answer: value.answer,
    answeredAt: value.answered_at,
    answeredBy: value.answered_by,
  });
}

interface Waiter {
  readonly command: CommandRecord;
  readonly settle: (decision: GateDecision) => void;
}

export function createConfirmationLock(options: ConfirmationLockOptions): ConfirmationLock {
  const { connection } = options.database;
  const { clock } = options;
  const owner = options.ownerEmail.toLowerCase();
  const waiters = new Map<string, Waiter>();

  const insertHold = connection.prepare(
    "INSERT INTO holds (command_id, form, description, evidence, fingerprint, held_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectHold = connection.prepare("SELECT * FROM holds WHERE command_id = ?");
  const recordAnswer = connection.prepare("UPDATE holds SET answer = ?, answered_at = ?, answered_by = ? WHERE command_id = ?");

  const get = (id: string): Hold | undefined => {
    const row = selectHold.get(id);
    return row === undefined ? undefined : toHold(row);
  };

  const answer = (id: string, value: HoldAnswer | null, by: string | null) => {
    recordAnswer.run(value, value === null ? null : clock.now(), by, id);
  };

  const wait = (command: CommandRecord, stopped: AbortSignal): Promise<GateDecision> =>
    new Promise((resolve) => {
      const onStop = () => {
        if (waiters.get(command.id)?.command === command) {
          answer(command.id, "withdrawn", null);
          settle({ kind: "drop", reason: withdrawnReason });
        }
      };
      const settle = (decision: GateDecision) => {
        waiters.delete(command.id);
        stopped.removeEventListener("abort", onStop);
        resolve(decision);
      };
      waiters.set(command.id, { command, settle });
      if (stopped.aborted) {
        onStop();
      } else {
        stopped.addEventListener("abort", onStop, { once: true });
      }
    });

  const gate: CommandGate = (command, control) => {
    const existing = get(command.id);
    if (existing === undefined) {
      const match = findIrreversible(command, options.settings);
      if (match === undefined) {
        return { kind: "allow" };
      }
      insertHold.run(command.id, match.form, match.description, match.evidence, fingerprintOf(command), clock.now());
      control.hold(holdReason(match.description, match.evidence));
      return wait(command, control.stopped);
    }
    if (existing.fingerprint !== fingerprintOf(command)) {
      answer(command.id, "withdrawn", null);
      return { kind: "drop", reason: changedReason };
    }
    if (existing.answer !== null) {
      answer(command.id, null, null);
    }
    return wait(command, control.stopped);
  };

  const isOwner = async (assertion: string | undefined): Promise<string | undefined> => {
    try {
      const result = await options.verify(assertion);
      if (result.ok && result.identity.kind === "person" && result.identity.email === owner) {
        return result.identity.email;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const decide = async (id: string, given: OwnerAnswer, verdict: "released" | "refused"): Promise<AnswerOutcome> => {
    const email = await isOwner(given.assertion);
    if (email === undefined) {
      return { ok: false, error: "forbidden" };
    }
    const hold = get(id);
    if (hold === undefined) {
      return { ok: false, error: "not_found" };
    }
    const waiter = waiters.get(id);
    if (waiter === undefined || hold.answer !== null) {
      return { ok: false, error: "conflict" };
    }
    if (given.fingerprint !== hold.fingerprint || fingerprintOf(waiter.command) !== hold.fingerprint) {
      return { ok: false, error: "conflict" };
    }
    answer(id, verdict, email);
    waiter.settle(verdict === "released" ? { kind: "allow" } : { kind: "drop", reason: refusedReason });
    return { ok: true, hold: get(id) ?? hold };
  };

  return {
    gate,
    waiting: () =>
      [...waiters.keys()]
        .flatMap((id) => {
          const hold = get(id);
          return hold === undefined ? [] : [hold];
        })
        .sort((a, b) => a.heldAt - b.heldAt),
    get,
    release: (id, given) => decide(id, given, "released"),
    refuse: (id, given) => decide(id, given, "refused"),
  };
}
