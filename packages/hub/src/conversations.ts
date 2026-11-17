import { randomUUID } from "node:crypto";
import { text } from "@super-agent2/catalog";
import {
  type BrainInput,
  type BrainMessage,
  type BrainProviders,
  type BrainUpdate,
  type CommandRecord,
  Conversation,
  type ConversationDetail,
  ConversationEntry,
  type ConversationUpdate,
  type DeliveryEntry,
  type DeliveryFile,
  type GeneratedText,
  type EntryDelta,
  type EntryUpdate,
  finishedStates,
  type HistoryItem,
  type HubToBrain,
  type MemoryBrief,
  type OwnerEntry,
  Provider,
  protocolVersion,
  Turn,
  type TurnOutcome,
  type TurnUpdate,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { CommandService } from "./commands.js";
import type { HubDatabase } from "./database.js";
import { commandReport } from "./reports.js";

export type ConversationEvent = ConversationUpdate | TurnUpdate | EntryUpdate | EntryDelta | BrainUpdate;

export type ConversationListener = (event: ConversationEvent) => void;

export interface BrainLink {
  receive(message: BrainMessage): void;
  detach(): void;
}

export interface BrainConnection {
  send(message: HubToBrain): void;
  close(): void;
}

export interface ConversationService {
  create(): Conversation;
  get(id: string): Conversation | undefined;
  list(limit?: number): Conversation[];
  detail(id: string): ConversationDetail | undefined;
  entries(id: string, after?: number): ConversationEntry[];
  send(id: string, message: string): OwnerEntry | undefined;
  interrupt(id: string): Conversation | undefined;
  recordCommand(command: string, conversation: string): void;
  tell(conversation: string | null, notice: string, prompt: string): string;
  deliver(conversation: string | null, delivery: Delivery): string;
  linked(): boolean;
  providers(): BrainProviders | undefined;
  sendOrder(order: readonly Provider[]): void;
  watchBrain(listener: () => void): () => void;
  attach(connection: BrainConnection): BrainLink;
  subscribe(listener: ConversationListener): () => void;
  close(): void;
}

export interface Delivery {
  readonly ticket: number;
  readonly title: GeneratedText;
  readonly text: string | null;
  readonly files: readonly DeliveryFile[];
  readonly prompt: string;
}

export interface ConversationServiceOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly commands: CommandService;
  readonly memory?: MemoryBriefing;
  readonly order?: () => readonly Provider[] | undefined;
}

export interface MemoryBriefing {
  brief(conversation: string, seen: number | null): MemoryBrief | null;
  revision(): number;
}

export const providerNames: Readonly<Record<Provider, string>> = { gpt: "GPT", claude: "Claude", deepseek: "DeepSeek" };

export const brainRestartedReason = text("turn.reason.brainRestarted");
export const brainAbsentReason = text("turn.reason.brainAbsent");

const titleLength = 80;

const ConversationRow = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  provider: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

const TurnRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  provider: z.string(),
  model: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
});

const EntryRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.number().int(),
  kind: z.string(),
  turn_id: z.string().nullable(),
  provider: z.string().nullable(),
  body: z.string(),
  prompt: z.string().nullable(),
  taken: z.number().int().nullable(),
  created_at: z.number().int(),
});
type EntryRow = z.infer<typeof EntryRow>;

const Body = z.looseObject({
  text: z.string().nullable().optional(),
  ticket: z.number().optional(),
  title: z.unknown().optional(),
  files: z.unknown().optional(),
  name: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  state: z.string().optional(),
});

const SessionRow = z.object({ session: z.string().nullable(), through: z.number().int(), memory_seen: z.number().int() });

const BrainCommandRow = z.object({ conversation_id: z.string(), held: z.number().int(), reported: z.number().int() });

const SeqRow = z.object({ seq: z.number().int() });

function toConversation(row: unknown): Conversation {
  const value = ConversationRow.parse(row);
  return Conversation.parse({
    id: value.id,
    title: value.title,
    state: value.state,
    provider: value.provider,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  });
}

function toTurn(row: unknown): Turn {
  const value = TurnRow.parse(row);
  return Turn.parse({
    id: value.id,
    conversation: value.conversation_id,
    provider: value.provider,
    model: value.model,
    state: value.state,
    reason: value.reason,
    startedAt: value.started_at,
    endedAt: value.ended_at,
  });
}

function toEntry(row: EntryRow): ConversationEntry {
  const body = Body.parse(JSON.parse(row.body));
  const base = { id: row.id, conversation: row.conversation_id, seq: row.seq, at: row.created_at };
  switch (row.kind) {
    case "owner":
      return ConversationEntry.parse({ ...base, kind: "owner", text: body.text, taken: row.taken === 1 });
    case "notice":
      return ConversationEntry.parse({ ...base, kind: "notice", text: body.text, turn: row.turn_id });
    case "delivery":
      return ConversationEntry.parse({
        ...base,
        kind: "delivery",
        turn: row.turn_id,
        ticket: body.ticket,
        title: body.title,
        text: body.text ?? null,
        files: body.files,
      });
    case "text":
      return ConversationEntry.parse({ ...base, kind: "text", turn: row.turn_id, text: body.text });
    default:
      return ConversationEntry.parse({
        ...base,
        kind: "tool",
        turn: row.turn_id,
        name: body.name,
        input: body.input,
        output: body.output,
        state: body.state,
      });
  }
}

function titleOf(message: string): string {
  const line = message.trim().split(/\r?\n/)[0] ?? "";
  return [...line].length > titleLength ? `${[...line].slice(0, titleLength - 1).join("")}…` : line;
}

function deliveryHistory(entry: DeliveryEntry): string {
  const files = entry.files.length === 0 ? "" : ` Files: ${entry.files.map((file) => file.name).join(", ")}.`;
  return `[hub] The result of writing ticket ${entry.ticket} (${entry.title.en}) was delivered to the owner here.${files}${entry.text === null ? "" : `\n${entry.text}`}`;
}

function heldPrompt(command: CommandRecord, output: string): string {
  return [
    `[hub] The command ${command.id} that was held for the owner's confirmation has an outcome.`,
    commandReport(command, output),
    "Tell the owner what happened and carry on from there.",
  ].join("\n");
}

export function createConversationService(options: ConversationServiceOptions): ConversationService {
  const { connection } = options.database;
  const { clock, commands } = options;
  const listeners = new Set<ConversationListener>();
  let link: { readonly connection: BrainConnection; ready: boolean } | undefined;
  let brainProviders: BrainProviders | undefined;
  const brainListeners = new Set<() => void>();
  const brainChanged = () => {
    for (const listener of brainListeners) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  };

  const insertConversation = connection.prepare(
    "INSERT INTO conversations (id, title, state, provider, created_at, updated_at) VALUES (?, '', 'idle', NULL, ?, ?)",
  );
  const selectConversation = connection.prepare("SELECT * FROM conversations WHERE id = ?");
  const selectConversations = connection.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC LIMIT ?");
  const selectTurn = connection.prepare("SELECT * FROM turns WHERE id = ?");
  const selectTurns = connection.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY started_at, rowid");
  const selectRunningTurns = connection.prepare("SELECT * FROM turns WHERE state = 'running' ORDER BY rowid");
  const insertTurn = connection.prepare(
    "INSERT INTO turns (id, conversation_id, provider, model, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
  );
  const finishTurn = connection.prepare("UPDATE turns SET state = ?, reason = ?, ended_at = ? WHERE id = ?");
  const changeTurnProvider = connection.prepare("UPDATE turns SET provider = ?, model = ? WHERE id = ?");
  const selectEntry = connection.prepare("SELECT * FROM conversation_entries WHERE id = ?");
  const selectEntries = connection.prepare(
    "SELECT * FROM conversation_entries WHERE conversation_id = ? AND (seq > ? OR turn_id IN (SELECT id FROM turns WHERE conversation_id = ? AND state = 'running')) ORDER BY seq",
  );
  const selectAfter = connection.prepare("SELECT * FROM conversation_entries WHERE conversation_id = ? AND seq > ? ORDER BY seq");
  const selectWaiting = connection.prepare("SELECT * FROM conversation_entries WHERE taken = 0 ORDER BY created_at, rowid");
  const selectLastSeq = connection.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_entries WHERE conversation_id = ?");
  const insertEntry = connection.prepare(
    "INSERT INTO conversation_entries (id, conversation_id, seq, kind, turn_id, provider, body, prompt, taken, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateBody = connection.prepare("UPDATE conversation_entries SET body = ? WHERE id = ?");
  const markTaken = connection.prepare(
    "UPDATE conversation_entries SET taken = 1, turn_id = COALESCE(turn_id, ?) WHERE id = ? AND conversation_id = ? AND taken = 0",
  );
  const selectSession = connection.prepare("SELECT session, through, memory_seen FROM program_sessions WHERE conversation_id = ? AND provider = ?");
  const upsertSession = connection.prepare(
    "INSERT INTO program_sessions (conversation_id, provider, session, through, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (conversation_id, provider) DO UPDATE SET session = excluded.session, through = CASE WHEN program_sessions.session IS NULL OR program_sessions.session = excluded.session THEN program_sessions.through ELSE 0 END, memory_seen = CASE WHEN program_sessions.session IS NULL OR program_sessions.session = excluded.session THEN program_sessions.memory_seen ELSE 0 END, updated_at = excluded.updated_at",
  );
  const advanceSession = connection.prepare(
    "INSERT INTO program_sessions (conversation_id, provider, session, through, updated_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT (conversation_id, provider) DO UPDATE SET through = excluded.through, memory_seen = program_sessions.memory_offered, updated_at = excluded.updated_at",
  );
  const offerMemory = connection.prepare(
    "INSERT INTO program_sessions (conversation_id, provider, session, through, memory_offered, updated_at) VALUES (?, ?, NULL, 0, ?, ?) ON CONFLICT (conversation_id, provider) DO UPDATE SET memory_offered = excluded.memory_offered",
  );
  const insertBrainCommand = connection.prepare(
    "INSERT INTO brain_commands (command_id, conversation_id) VALUES (?, ?) ON CONFLICT (command_id) DO NOTHING",
  );
  const selectBrainCommand = connection.prepare("SELECT conversation_id, held, reported FROM brain_commands WHERE command_id = ?");
  const markHeld = connection.prepare("UPDATE brain_commands SET held = 1 WHERE command_id = ?");
  const markReported = connection.prepare("UPDATE brain_commands SET reported = 1 WHERE command_id = ?");

  const emit = (event: ConversationEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  };

  const get = (id: string): Conversation | undefined => {
    const row = selectConversation.get(id);
    return row === undefined ? undefined : toConversation(row);
  };

  const getTurn = (id: string): Turn | undefined => {
    const row = selectTurn.get(id);
    return row === undefined ? undefined : toTurn(row);
  };

  const getEntry = (id: string): ConversationEntry | undefined => {
    const row = selectEntry.get(id);
    return row === undefined ? undefined : toEntry(EntryRow.parse(row));
  };

  const updateConversation = (id: string, fields: Readonly<Record<string, string | number | null>>) => {
    const names = Object.keys(fields);
    const assignments = [...names.map((name) => `${name} = ?`), "updated_at = ?"].join(", ");
    connection.prepare(`UPDATE conversations SET ${assignments} WHERE id = ?`).run(...names.map((name) => fields[name] ?? null), clock.now(), id);
    const conversation = get(id);
    if (conversation !== undefined) {
      emit({ type: "conversation", conversation });
    }
  };

  const emitTurn = (id: string) => {
    const turn = getTurn(id);
    if (turn !== undefined) {
      emit({ type: "turn", turn });
    }
  };

  const emitEntry = (id: string) => {
    const entry = getEntry(id);
    if (entry !== undefined) {
      emit({ type: "entry", entry });
    }
  };

  const lastSeq = (conversation: string) => SeqRow.parse(selectLastSeq.get(conversation)).seq;

  interface NewEntry {
    readonly id?: string;
    readonly conversation: string;
    readonly kind: ConversationEntry["kind"];
    readonly turn: string | null;
    readonly provider?: Provider | null;
    readonly body: Readonly<Record<string, unknown>>;
    readonly prompt?: string;
  }

  const addEntry = (entry: NewEntry): string => {
    const id = entry.id ?? randomUUID();
    insertEntry.run(
      id,
      entry.conversation,
      lastSeq(entry.conversation) + 1,
      entry.kind,
      entry.turn,
      entry.provider ?? null,
      JSON.stringify(entry.body),
      entry.prompt ?? null,
      entry.prompt === undefined ? null : 0,
      clock.now(),
    );
    emitEntry(id);
    return id;
  };

  const bodyOf = (id: string): Record<string, string> | undefined => {
    const row = selectEntry.get(id);
    if (row === undefined) {
      return undefined;
    }
    const parsed = Body.parse(JSON.parse(EntryRow.parse(row).body));
    const body: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        body[name] = value;
      }
    }
    return body;
  };

  const sendToBrain = (message: HubToBrain): boolean => {
    if (link === undefined || !link.ready) {
      return false;
    }
    try {
      link.connection.send(message);
      return true;
    } catch {
      return false;
    }
  };

  const deliver = (row: EntryRow) => {
    if (row.prompt === null) {
      return;
    }
    const input: BrainInput = { id: row.id, source: row.kind === "owner" ? "owner" : "hub", text: row.prompt };
    sendToBrain({ type: "input", conversation: row.conversation_id, input });
  };

  const runningTurnOf = (conversation: string): Turn | undefined =>
    selectTurns
      .all(conversation)
      .map(toTurn)
      .find((turn) => turn.state === "running");

  const endTurn = (id: string, outcome: TurnOutcome, reason: string | null) => {
    const turn = getTurn(id);
    if (turn === undefined || turn.state !== "running") {
      return;
    }
    finishTurn.run(outcome, reason, clock.now(), id);
    advanceSession.run(turn.conversation, turn.provider, lastSeq(turn.conversation), clock.now());
    emitTurn(id);
    updateConversation(turn.conversation, { state: runningTurnOf(turn.conversation) === undefined ? "idle" : "working" });
  };

  const history = (conversation: string, through: number, exclude: ReadonlySet<string>): HistoryItem[] =>
    selectAfter
      .all(conversation, through)
      .map((row) => EntryRow.parse(row))
      .filter((row) => !exclude.has(row.id))
      .map((row): HistoryItem => {
        const entry = toEntry(row);
        const provider = row.provider === null ? null : Provider.parse(row.provider);
        switch (entry.kind) {
          case "owner":
            return { kind: "owner", text: entry.text };
          case "notice":
            return { kind: "notice", text: entry.text };
          case "delivery":
            return { kind: "notice", text: deliveryHistory(entry) };
          case "text":
            return { kind: "text", provider, text: entry.text };
          case "tool":
            return { kind: "tool", provider, name: entry.name, input: entry.input, output: entry.output };
        }
      });

  const providerOfTurn = (turn: string): Provider | null => {
    const found = getTurn(turn);
    return found === undefined ? null : found.provider;
  };

  const appendField = (id: string, field: "text" | "output", delta: string) => {
    const body = bodyOf(id);
    const entry = getEntry(id);
    if (body === undefined || entry === undefined) {
      return;
    }
    body[field] = (body[field] ?? "") + delta;
    updateBody.run(JSON.stringify(body), id);
    emit({ type: "delta", conversation: entry.conversation, entry: id, field, text: delta });
  };

  const known = (conversation: string, turn: string) => {
    const found = getTurn(turn);
    return found !== undefined && found.conversation === conversation;
  };

  const receive = (message: BrainMessage) => {
    switch (message.type) {
      case "providers": {
        brainProviders = message;
        brainChanged();
        return;
      }
      case "hello": {
        if (link !== undefined) {
          link.ready = true;
        }
        const order = options.order?.();
        if (order !== undefined) {
          sendToBrain({ type: "order", order: [...order] });
        }
        const running = new Set(message.running.map((item) => `${item.conversation}\n${item.turn}`));
        for (const turn of selectRunningTurns.all().map(toTurn)) {
          if (!running.has(`${turn.conversation}\n${turn.id}`)) {
            endTurn(turn.id, "interrupted", brainRestartedReason);
          }
        }
        for (const item of message.running) {
          const turn = getTurn(item.turn);
          if (turn !== undefined && turn.state !== "running") {
            sendToBrain({ type: "interrupt", conversation: item.conversation });
          }
        }
        for (const row of selectWaiting.all().map((value) => EntryRow.parse(value))) {
          deliver(row);
        }
        return;
      }
      case "turn.started": {
        if (get(message.conversation) === undefined || getTurn(message.turn) !== undefined) {
          return;
        }
        insertTurn.run(message.turn, message.conversation, message.provider, message.model, clock.now());
        for (const input of message.inputs) {
          if (markTaken.run(message.turn, input, message.conversation).changes > 0) {
            emitEntry(input);
          }
        }
        emitTurn(message.turn);
        updateConversation(message.conversation, { state: "working", provider: message.provider });
        return;
      }
      case "input.taken": {
        if (known(message.conversation, message.turn) && markTaken.run(message.turn, message.input, message.conversation).changes > 0) {
          emitEntry(message.input);
        }
        return;
      }
      case "provider.changed": {
        if (!known(message.conversation, message.turn)) {
          return;
        }
        changeTurnProvider.run(message.to, message.model, message.turn);
        emitTurn(message.turn);
        addEntry({
          conversation: message.conversation,
          kind: "notice",
          turn: message.turn,
          body: {
            text: text("notice.providerChanged", {
              from: providerNames[message.from],
              to: providerNames[message.to],
              reason: message.reason,
            }),
          },
        });
        updateConversation(message.conversation, { provider: message.to });
        return;
      }
      case "text": {
        if (!known(message.conversation, message.turn)) {
          return;
        }
        const id = `${message.turn}:${message.block}`;
        if (getEntry(id) === undefined) {
          addEntry({
            id,
            conversation: message.conversation,
            kind: "text",
            turn: message.turn,
            provider: providerOfTurn(message.turn),
            body: { text: message.delta },
          });
        } else {
          appendField(id, "text", message.delta);
        }
        return;
      }
      case "tool.started": {
        if (!known(message.conversation, message.turn)) {
          return;
        }
        const id = `${message.turn}:${message.call}`;
        if (getEntry(id) === undefined) {
          addEntry({
            id,
            conversation: message.conversation,
            kind: "tool",
            turn: message.turn,
            provider: providerOfTurn(message.turn),
            body: { name: message.name, input: message.input, output: "", state: "running" },
          });
        }
        return;
      }
      case "tool.output": {
        if (known(message.conversation, message.turn)) {
          appendField(`${message.turn}:${message.call}`, "output", message.delta);
        }
        return;
      }
      case "tool.finished": {
        const id = `${message.turn}:${message.call}`;
        const body = bodyOf(id);
        if (!known(message.conversation, message.turn) || body === undefined) {
          return;
        }
        body["state"] = message.ok ? "done" : "failed";
        if (message.output !== null) {
          body["output"] = message.output;
        }
        updateBody.run(JSON.stringify(body), id);
        emitEntry(id);
        return;
      }
      case "turn.finished": {
        if (known(message.conversation, message.turn)) {
          endTurn(message.turn, message.outcome, message.reason);
        }
        return;
      }
      case "session": {
        if (get(message.conversation) !== undefined) {
          upsertSession.run(message.conversation, message.provider, message.session, clock.now());
        }
        return;
      }
      case "prepare": {
        const found = message.fresh ? undefined : selectSession.get(message.conversation, message.provider);
        const session = found === undefined ? undefined : SessionRow.parse(found);
        const given = session?.session ?? null;
        const memory = options.memory;
        let brief: MemoryBrief | null = null;
        if (memory !== undefined && get(message.conversation) !== undefined) {
          const revision = memory.revision();
          brief = memory.brief(message.conversation, given === null || session === undefined ? null : session.memory_seen);
          offerMemory.run(message.conversation, message.provider, revision, clock.now());
        }
        sendToBrain({
          type: "prepared",
          request: message.request,
          session: given,
          history: history(message.conversation, session?.through ?? 0, new Set(message.exclude)),
          memory: brief,
        });
        return;
      }
    }
  };

  const reportHeld = (command: CommandRecord) => {
    const row = selectBrainCommand.get(command.id);
    if (row === undefined) {
      return;
    }
    const value = BrainCommandRow.parse(row);
    if (command.state === "held") {
      markHeld.run(command.id);
      return;
    }
    if (value.held === 0 || value.reported === 1 || !finishedStates.includes(command.state)) {
      return;
    }
    markReported.run(command.id);
    const output = commands
      .output(command.id)
      .map((chunk) => chunk.data)
      .join("");
    const id = addEntry({
      conversation: value.conversation_id,
      kind: "notice",
      turn: null,
      body: { text: text("notice.heldOutcome", { state: text(`command.state.${command.state}`), command: command.command }) },
      prompt: heldPrompt(command, output),
    });
    const stored = selectEntry.get(id);
    if (stored !== undefined) {
      deliver(EntryRow.parse(stored));
    }
    updateConversation(value.conversation_id, {});
  };

  const unsubscribeCommands = commands.subscribe((event) => {
    if (event.type === "command") {
      reportHeld(event.command);
    }
  });

  const create = (): Conversation => {
    const id = randomUUID();
    const now = clock.now();
    insertConversation.run(id, now, now);
    const conversation = get(id);
    if (conversation === undefined) {
      throw new Error(`Conversation ${id} was not stored`);
    }
    emit({ type: "conversation", conversation });
    return conversation;
  };

  const tell = (conversation: string | null, notice: string, prompt: string): string => {
    const target = (conversation === null ? undefined : get(conversation)) ?? selectConversations.all(1).map(toConversation)[0] ?? create();
    const id = addEntry({ conversation: target.id, kind: "notice", turn: null, body: { text: notice }, prompt });
    const stored = selectEntry.get(id);
    if (stored !== undefined) {
      deliver(EntryRow.parse(stored));
    }
    updateConversation(target.id, {});
    return target.id;
  };

  const deliverResult = (conversation: string | null, delivery: Delivery): string => {
    const target = (conversation === null ? undefined : get(conversation)) ?? selectConversations.all(1).map(toConversation)[0] ?? create();
    const id = addEntry({
      conversation: target.id,
      kind: "delivery",
      turn: null,
      body: { ticket: delivery.ticket, title: delivery.title, text: delivery.text, files: delivery.files },
      prompt: delivery.prompt,
    });
    const stored = selectEntry.get(id);
    if (stored !== undefined) {
      deliver(EntryRow.parse(stored));
    }
    updateConversation(target.id, {});
    return target.id;
  };

  return {
    create,
    tell,
    deliver: deliverResult,
    get,
    list: (limit = 50) => selectConversations.all(limit).map(toConversation),
    detail: (id) => {
      const conversation = get(id);
      if (conversation === undefined) {
        return undefined;
      }
      return {
        conversation,
        turns: selectTurns.all(id).map(toTurn),
        entries: selectEntries.all(id, 0, id).map((row) => toEntry(EntryRow.parse(row))),
      };
    },
    entries: (id, after = 0) => selectEntries.all(id, after, id).map((row) => toEntry(EntryRow.parse(row))),
    send: (id, message) => {
      const conversation = get(id);
      if (conversation === undefined) {
        return undefined;
      }
      const entryId = addEntry({ conversation: id, kind: "owner", turn: null, body: { text: message }, prompt: message });
      updateConversation(id, conversation.title === "" ? { title: titleOf(message) } : {});
      const row = selectEntry.get(entryId);
      if (row !== undefined) {
        deliver(EntryRow.parse(row));
      }
      const entry = getEntry(entryId);
      return entry?.kind === "owner" ? entry : undefined;
    },
    interrupt: (id) => {
      const conversation = get(id);
      if (conversation === undefined) {
        return undefined;
      }
      const running = runningTurnOf(id);
      if (running !== undefined && !sendToBrain({ type: "interrupt", conversation: id })) {
        endTurn(running.id, "interrupted", brainAbsentReason);
      }
      return get(id);
    },
    recordCommand: (command, conversation) => {
      if (get(conversation) === undefined) {
        return;
      }
      insertBrainCommand.run(command, conversation);
      const record = commands.get(command);
      if (record?.state === "held") {
        markHeld.run(command);
      }
    },
    linked: () => link !== undefined,
    providers: () => (link === undefined ? undefined : brainProviders),
    sendOrder: (order) => {
      sendToBrain({ type: "order", order: [...order] });
    },
    watchBrain: (listener) => {
      brainListeners.add(listener);
      return () => {
        brainListeners.delete(listener);
      };
    },
    attach: (connection) => {
      const previous = link;
      const current = { connection, ready: false };
      link = current;
      previous?.connection.close();
      if (previous === undefined) {
        emit({ type: "brain", brain: { linked: true } });
      }
      brainChanged();
      connection.send({ type: "hello", protocol: protocolVersion });
      return {
        receive: (message) => {
          if (link === current) {
            receive(message);
          }
        },
        detach: () => {
          if (link === current) {
            link = undefined;
            brainProviders = undefined;
            emit({ type: "brain", brain: { linked: false } });
            brainChanged();
          }
        },
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      unsubscribeCommands();
      link?.connection.close();
      link = undefined;
      listeners.clear();
      brainListeners.clear();
    },
  };
}
