import type { Attachment, DeliveredFile, GeneratedText, StoredWorkEvent, ToolState, WorkFailure, WorkSender } from "@super-agent2/protocol";

export type LogItem =
  | { readonly kind: "text"; readonly key: string; readonly at: number; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly at: number;
      readonly name: string;
      readonly input: string;
      readonly output: string;
      readonly state: ToolState;
    }
  | { readonly kind: "message"; readonly key: string; readonly at: number; readonly from: WorkSender; readonly text: string; readonly attachments: readonly Attachment[] }
  | { readonly kind: "finished"; readonly key: string; readonly at: number; readonly pullRequest: number; readonly url: string; readonly report: GeneratedText }
  | {
      readonly kind: "delivered";
      readonly key: string;
      readonly at: number;
      readonly text: string | null;
      readonly files: readonly Pick<DeliveredFile, "name" | "size">[];
      readonly report: GeneratedText;
    }
  | { readonly kind: "failed"; readonly key: string; readonly at: number; readonly failure: WorkFailure; readonly reason: string }
  | { readonly kind: "stopped"; readonly key: string; readonly at: number; readonly saved: boolean };

export interface AttemptLog {
  readonly attempt: number;
  readonly first: number;
  readonly items: readonly LogItem[];
  readonly ended: boolean;
}

export interface WorkLog {
  readonly ticket: number;
  readonly events: readonly StoredWorkEvent[];
  readonly attempts: readonly AttemptLog[];
}

export function emptyLog(ticket: number): WorkLog {
  return { ticket, events: [], attempts: [] };
}

export function lastEventId(log: WorkLog): number {
  return log.events.at(-1)?.id ?? 0;
}

function hasEvent(events: readonly StoredWorkEvent[], id: number): boolean {
  let low = 0;
  let high = events.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const found = events[middle]?.id ?? 0;
    if (found === id) {
      return true;
    }
    if (found < id) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return false;
}

function findFromEnd(items: readonly LogItem[], key: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.key === key) {
      return index;
    }
  }
  return -1;
}

function replaced(items: readonly LogItem[], index: number, item: LogItem): LogItem[] {
  const next = [...items];
  next[index] = item;
  return next;
}

function foldItems(items: readonly LogItem[], stored: StoredWorkEvent): readonly LogItem[] {
  const { event, attempt, at } = stored;
  switch (event.kind) {
    case "text": {
      const key = `${attempt}:text:${event.block}`;
      const index = findFromEnd(items, key);
      const found = items[index];
      if (found?.kind === "text") {
        return replaced(items, index, { ...found, text: found.text + event.delta });
      }
      return [...items, { kind: "text", key, at, text: event.delta }];
    }
    case "tool.started": {
      const key = `${attempt}:tool:${event.call}`;
      const index = findFromEnd(items, key);
      const found = items[index];
      if (found?.kind === "tool") {
        return replaced(items, index, { ...found, name: event.name, input: event.input });
      }
      return [...items, { kind: "tool", key, at, name: event.name, input: event.input, output: "", state: "running" }];
    }
    case "tool.output": {
      const key = `${attempt}:tool:${event.call}`;
      const index = findFromEnd(items, key);
      const found = items[index];
      if (found?.kind === "tool") {
        return replaced(items, index, { ...found, output: found.output + event.delta });
      }
      return [...items, { kind: "tool", key, at, name: "", input: "", output: event.delta, state: "running" }];
    }
    case "tool.finished": {
      const key = `${attempt}:tool:${event.call}`;
      const index = findFromEnd(items, key);
      const found = items[index];
      const state: ToolState = event.ok ? "done" : "failed";
      if (found?.kind === "tool") {
        return replaced(items, index, { ...found, output: event.output ?? found.output, state });
      }
      return [...items, { kind: "tool", key, at, name: "", input: "", output: event.output ?? "", state }];
    }
    case "message":
      return [...items, { kind: "message", key: `${attempt}:message:${event.id}`, at, from: event.from, text: event.text, attachments: event.attachments ?? [] }];
    case "finished":
      return [...items, { kind: "finished", key: `${attempt}:end:${stored.seq}`, at, pullRequest: event.pullRequest, url: event.url, report: event.report }];
    case "delivered":
      return [
        ...items,
        { kind: "delivered", key: `${attempt}:end:${stored.seq}`, at, text: event.text, files: event.files.map((file) => ({ name: file.name, size: file.size })), report: event.report },
      ];
    case "failed":
      return [...items, { kind: "failed", key: `${attempt}:end:${stored.seq}`, at, failure: event.failure, reason: event.reason }];
    case "stopped":
      return [...items, { kind: "stopped", key: `${attempt}:end:${stored.seq}`, at, saved: event.saved }];
    default:
      return items;
  }
}

const endings = new Set(["finished", "delivered", "failed", "stopped"]);

function fold(attempts: readonly AttemptLog[], stored: StoredWorkEvent): readonly AttemptLog[] {
  const position = attempts.findIndex((entry) => entry.attempt === stored.attempt);
  const current: AttemptLog = attempts[position] ?? { attempt: stored.attempt, first: stored.at, items: [], ended: false };
  const items = foldItems(current.items, stored);
  const ended = current.ended || endings.has(stored.event.kind);
  if (position >= 0 && items === current.items && ended === current.ended) {
    return attempts;
  }
  const next: AttemptLog = { ...current, items, ended };
  if (position >= 0) {
    const copy = [...attempts];
    copy[position] = next;
    return copy;
  }
  return [...attempts, next].sort((a, b) => a.attempt - b.attempt);
}

function rebuild(ticket: number, events: readonly StoredWorkEvent[]): WorkLog {
  let attempts: readonly AttemptLog[] = [];
  for (const event of events) {
    attempts = fold(attempts, event);
  }
  return { ticket, events, attempts };
}

export function receiveWork(log: WorkLog, incoming: readonly StoredWorkEvent[]): WorkLog {
  const fresh: StoredWorkEvent[] = [];
  const seen = new Set<number>();
  for (const event of incoming) {
    if (event.ticket !== log.ticket || seen.has(event.id) || hasEvent(log.events, event.id)) {
      continue;
    }
    seen.add(event.id);
    fresh.push(event);
  }
  if (fresh.length === 0) {
    return log;
  }
  fresh.sort((a, b) => a.id - b.id);
  const last = lastEventId(log);
  if ((fresh[0]?.id ?? 0) > last) {
    let attempts = log.attempts;
    for (const event of fresh) {
      attempts = fold(attempts, event);
    }
    return { ticket: log.ticket, events: [...log.events, ...fresh], attempts };
  }
  return rebuild(log.ticket, [...log.events, ...fresh].sort((a, b) => a.id - b.id));
}
