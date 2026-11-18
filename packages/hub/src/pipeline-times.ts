import { text } from "@super-agent2/catalog";
import { z } from "zod";
import type { HubDatabase } from "./database.js";

export const usualWindow = 15;
export const usualMinimum = 3;
export const overrunFactor = 3;
export const defaultFirstAllowanceMinutes = 120;

const minute = 60_000;

export interface Usual {
  readonly samples: number;
  readonly milliseconds: number | null;
}

export interface PipelineTimes {
  record(repository: string, number: number, created: number, finished: number): void;
  usual(repository: string): Usual;
}

const DurationRow = z.object({ length: z.number().int() });

export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return 0;
  }
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  return Math.round(((sorted[middle - 1] ?? upper) + upper) / 2);
}

export function noticesDue(waited: number, threshold: number): number {
  const first = Math.max(1, threshold);
  let due = 0;
  let limit = first;
  while (waited >= limit && due < 60) {
    due += 1;
    limit *= 2;
  }
  return due;
}

export function thresholdOf(usual: Usual, firstAllowance: number): number {
  return usual.milliseconds === null ? firstAllowance : Math.round(usual.milliseconds * overrunFactor);
}

export function createPipelineTimes(database: HubDatabase): PipelineTimes {
  const { connection } = database;
  const insert = connection.prepare("INSERT OR IGNORE INTO pipeline_durations (repository, number, created_at, finished_at) VALUES (?, ?, ?, ?)");
  const recent = connection.prepare("SELECT finished_at - created_at AS length FROM pipeline_durations WHERE repository = ? ORDER BY finished_at DESC, number DESC LIMIT ?");
  return {
    record: (repository, number, created, finished) => {
      if (finished > created) {
        insert.run(repository.toLowerCase(), number, created, finished);
      }
    },
    usual: (repository) => {
      const lengths = recent.all(repository.toLowerCase(), usualWindow).map((row) => DurationRow.parse(row).length);
      return { samples: lengths.length, milliseconds: lengths.length < usualMinimum ? null : medianOf(lengths) };
    },
  };
}

export function durationWords(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / minute));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (hours === 0) {
    return plural(minutes, "minute");
  }
  return rest === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(rest, "minute")}`;
}

export function durationChinese(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / minute));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return text("duration.minutes", { minutes });
  }
  return rest === 0 ? text("duration.hours", { hours }) : text("duration.hoursMinutes", { hours, minutes: rest });
}
