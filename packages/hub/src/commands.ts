import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { text } from "@super-agent2/catalog";
import {
  CommandRecord,
  CommandRequest,
  type CommandOutput,
  type CommandState,
  type CommandUpdate,
  finishedStates,
  GitHubAccount,
  OutputChunk,
  type OutputStream,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import { type CredentialSource, isCredentialVariable } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import { type Execution, type ExecutionEnd, fixedTargets, isTargetDirectory, type Target, type TargetDirectory } from "./targets.js";

export type GateDecision = { readonly kind: "allow" } | { readonly kind: "drop"; readonly reason: string };

export interface GateControl {
  hold(reason: string): void;
  readonly stopped: AbortSignal;
}

export type CommandGate = (command: CommandRecord, control: GateControl) => GateDecision | Promise<GateDecision>;

export const allowEverything: CommandGate = () => ({ kind: "allow" });

export type CommandEvent = CommandUpdate | CommandOutput;

export type CommandListener = (event: CommandEvent) => void;

export interface CommandService {
  start(request: CommandRequest): CommandRecord;
  get(id: string): CommandRecord | undefined;
  list(limit?: number): CommandRecord[];
  output(id: string, after?: number): OutputChunk[];
  subscribe(listener: CommandListener): () => void;
  finished(id: string): Promise<CommandRecord | undefined>;
  stop(id: string): CommandRecord | undefined;
  close(): Promise<void>;
}

export interface CommandServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly targets: readonly Target[] | TargetDirectory;
  readonly credentials: CredentialSource;
  readonly gate?: CommandGate;
}

export const interruptedReason = text("command.reason.interrupted");

const interruptedStates: readonly CommandState[] = ["pending", "running"];

const CommandRow = z.object({
  id: z.string(),
  target: z.string(),
  command: z.string(),
  account: GitHubAccount,
  cwd: z.string().nullable(),
  environment: z.string().nullable().optional(),
  state: z.string(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.number().int(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
});

const OutputRow = z.object({
  seq: z.number().int(),
  stream: z.string(),
  data: z.string(),
  at: z.number().int(),
});

function toRecord(row: unknown): CommandRecord {
  const value = CommandRow.parse(row);
  return CommandRecord.parse({
    id: value.id,
    target: value.target,
    command: value.command,
    account: value.account,
    cwd: value.cwd,
    environment: value.environment === null || value.environment === undefined ? {} : JSON.parse(value.environment),
    state: value.state,
    exitCode: value.exit_code,
    signal: value.signal,
    reason: value.reason,
    createdAt: value.created_at,
    startedAt: value.started_at,
    endedAt: value.ended_at,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Active {
  readonly id: string;
  readonly done: Promise<void>;
  readonly gateStop: AbortController;
  execution: Execution | undefined;
  ending: "stopped" | "interrupted" | undefined;
  detached: boolean;
  seq: number;
  readonly settle: () => void;
  readonly decoders: Record<OutputStream, StringDecoder>;
}

export function createCommandService(options: CommandServiceOptions): CommandService {
  const { connection } = options.database;
  const { clock } = options;
  const gate = options.gate ?? allowEverything;
  const targets = isTargetDirectory(options.targets) ? options.targets : fixedTargets(options.targets);
  const listeners = new Set<CommandListener>();
  const active = new Map<string, Active>();
  let closing = false;

  const placeholders = interruptedStates.map(() => "?").join(", ");
  connection
    .prepare(`UPDATE commands SET state = 'interrupted', reason = ?, ended_at = ? WHERE state IN (${placeholders})`)
    .run(interruptedReason, clock.now(), ...interruptedStates);

  const insertCommand = connection.prepare(
    `INSERT INTO commands (id, target, command, account, cwd, environment, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const selectCommand = connection.prepare("SELECT * FROM commands WHERE id = ?");
  const selectCommands = connection.prepare("SELECT * FROM commands ORDER BY rowid DESC LIMIT ?");
  const selectHeld = connection.prepare("SELECT * FROM commands WHERE state = 'held' ORDER BY rowid");
  const insertOutput = connection.prepare(
    "INSERT INTO command_output (command_id, seq, stream, data, at) VALUES (?, ?, ?, ?, ?)",
  );
  const selectOutput = connection.prepare(
    "SELECT seq, stream, data, at FROM command_output WHERE command_id = ? AND seq > ? ORDER BY seq",
  );

  const emit = (event: CommandEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  };

  const get = (id: string): CommandRecord | undefined => {
    const row = selectCommand.get(id);
    return row === undefined ? undefined : toRecord(row);
  };

  const update = (id: string, fields: Readonly<Record<string, string | number | null>>): CommandRecord => {
    const names = Object.keys(fields);
    connection
      .prepare(`UPDATE commands SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ?`)
      .run(...names.map((name) => fields[name] ?? null), id);
    const record = get(id);
    if (record === undefined) {
      throw new Error(`Command ${id} disappeared`);
    }
    emit({ type: "command", command: record });
    return record;
  };

  const finish = (id: string, state: CommandState, fields: Readonly<Record<string, string | number | null>> = {}) =>
    update(id, { state, ended_at: clock.now(), ...fields });

  const isFinished = (id: string) => {
    const record = get(id);
    return record === undefined || finishedStates.includes(record.state);
  };

  const record = (entry: Active, stream: OutputStream, data: string) => {
    if (data.length === 0) {
      return;
    }
    entry.seq += 1;
    const chunk: OutputChunk = { command: entry.id, seq: entry.seq, stream, data, at: clock.now() };
    insertOutput.run(chunk.command, chunk.seq, chunk.stream, chunk.data, chunk.at);
    emit({ type: "output", chunk });
  };

  const execute = async (entry: Active, initial: CommandRecord): Promise<void> => {
    let decision: GateDecision;
    try {
      decision = await gate(initial, {
        hold: (reason) => {
          if (!isFinished(entry.id)) {
            update(entry.id, { state: "held", reason });
          }
        },
        stopped: entry.gateStop.signal,
      });
    } catch (error) {
      if (!entry.detached && !isFinished(entry.id)) {
        finish(entry.id, "failed", { reason: messageOf(error) });
      }
      return;
    }
    if (entry.detached || isFinished(entry.id)) {
      return;
    }
    if (decision.kind === "drop") {
      finish(entry.id, "dropped", { reason: decision.reason });
      return;
    }
    const target = targets.find(initial.target);
    if (target === undefined) {
      finish(entry.id, "failed", { reason: text("command.reason.noTarget", { target: initial.target }) });
      return;
    }
    const credentials = options.credentials(initial.account);
    if (!credentials.ok) {
      finish(entry.id, "failed", { reason: credentials.reason });
      return;
    }
    let end: ExecutionEnd;
    try {
      const execution = target.run(
        { command: initial.command, cwd: initial.cwd ?? undefined, credentials: { ...initial.environment, ...credentials.credentials } },
        (stream, data) => record(entry, stream, entry.decoders[stream].write(data)),
      );
      entry.execution = execution;
      update(entry.id, { state: "running", reason: null, started_at: clock.now() });
      end = await execution.ended;
    } catch (error) {
      finish(entry.id, "failed", { reason: messageOf(error) });
      return;
    }
    for (const stream of ["stdout", "stderr"] as const) {
      record(entry, stream, entry.decoders[stream].end());
    }
    const lost = entry.ending === undefined ? end.lost : undefined;
    finish(entry.id, entry.ending ?? (lost === undefined ? "exited" : "interrupted"), {
      exit_code: end.exitCode,
      signal: end.signal,
      reason: entry.ending === "interrupted" ? interruptedReason : (lost ?? null),
    });
  };

  const halt = (entry: Active, ending: "stopped" | "interrupted") => {
    if (entry.execution === undefined) {
      if (!isFinished(entry.id)) {
        finish(entry.id, ending, ending === "interrupted" ? { reason: interruptedReason } : {});
      }
      entry.gateStop.abort();
      return;
    }
    entry.ending ??= ending;
    entry.execution.stop().catch(() => undefined);
  };

  const launch = (initial: CommandRecord) => {
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: Active = {
      id: initial.id,
      done,
      gateStop: new AbortController(),
      execution: undefined,
      ending: undefined,
      detached: false,
      seq: 0,
      settle,
      decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
    };
    active.set(initial.id, entry);
    execute(entry, initial)
      .catch((error: unknown) => {
        if (!entry.detached && !isFinished(initial.id)) {
          finish(initial.id, "failed", { reason: messageOf(error) });
        }
      })
      .finally(() => {
        if (active.get(initial.id) === entry) {
          active.delete(initial.id);
        }
        settle();
      });
  };

  for (const row of selectHeld.all()) {
    launch(toRecord(row));
  }

  return {
    start: (request) => {
      if (closing) {
        throw new Error("The command service is closed");
      }
      const parsed = CommandRequest.parse(request);
      const reserved = Object.keys(parsed.environment ?? {}).filter((name) => isCredentialVariable(name));
      if (reserved.length > 0) {
        throw new Error(`A command's environment cannot set ${reserved.join(", ")}: credentials are given by the hub alone`);
      }
      const id = randomUUID();
      insertCommand.run(id, parsed.target, parsed.command, parsed.account, parsed.cwd ?? null, parsed.environment === undefined ? null : JSON.stringify(parsed.environment), clock.now());
      const initial = get(id);
      if (initial === undefined) {
        throw new Error(`Command ${id} was not stored`);
      }
      emit({ type: "command", command: initial });
      launch(initial);
      return initial;
    },
    get,
    list: (limit = 50) => selectCommands.all(limit).map(toRecord),
    output: (id, after = 0) =>
      selectOutput.all(id, after).map((row) => {
        const value = OutputRow.parse(row);
        return OutputChunk.parse({ command: id, ...value });
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    finished: async (id) => {
      await active.get(id)?.done;
      return get(id);
    },
    stop: (id) => {
      const entry = active.get(id);
      if (entry !== undefined) {
        halt(entry, "stopped");
      }
      return get(id);
    },
    close: async () => {
      closing = true;
      const ending: Active[] = [];
      for (const entry of [...active.values()]) {
        if (entry.execution === undefined && get(entry.id)?.state === "held") {
          entry.detached = true;
          active.delete(entry.id);
          entry.settle();
          continue;
        }
        halt(entry, "interrupted");
        ending.push(entry);
      }
      await Promise.all(ending.map((entry) => entry.done));
      listeners.clear();
    },
  };
}
