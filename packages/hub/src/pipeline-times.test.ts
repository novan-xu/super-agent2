import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HubDatabase, openDatabase } from "./database.js";
import { createPipelineTimes, durationChinese, durationWords, medianOf, noticesDue, thresholdOf, usualWindow } from "./pipeline-times.js";
import { waitedLine } from "./reports.js";
import { TestClock } from "./testing/access.js";

const minute = 60_000;

let dataDir: string;
let database: HubDatabase;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-pipeline-times-"));
  database = openDatabase({ dataDir, clock: new TestClock() });
});

afterEach(() => {
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the median", () => {
  it("is the middle of an odd count and the mean of the two middle values of an even one", () => {
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([4, 10, 2, 8])).toBe(6);
    expect(medianOf([7])).toBe(7);
  });

  it("is not moved by one odd run", () => {
    expect(medianOf([10, 11, 9, 10, 600, 10])).toBe(10);
  });
});

describe("when the brain is due a notice", () => {
  it("is not due before the threshold, due at it, and due again at each doubling", () => {
    expect(noticesDue(0, 30 * minute)).toBe(0);
    expect(noticesDue(30 * minute - 1, 30 * minute)).toBe(0);
    expect(noticesDue(30 * minute, 30 * minute)).toBe(1);
    expect(noticesDue(60 * minute - 1, 30 * minute)).toBe(1);
    expect(noticesDue(60 * minute, 30 * minute)).toBe(2);
    expect(noticesDue(120 * minute, 30 * minute)).toBe(3);
    expect(noticesDue(660 * minute, 30 * minute)).toBe(5);
  });

  it("uses three times the usual, or the allowance when there is no usual", () => {
    expect(thresholdOf({ samples: 5, milliseconds: 14 * minute }, 120 * minute)).toBe(42 * minute);
    expect(thresholdOf({ samples: 2, milliseconds: null }, 120 * minute)).toBe(120 * minute);
  });
});

describe("the usual for a repository", () => {
  it("has none until three green runs are recorded", () => {
    const times = createPipelineTimes(database);
    expect(times.usual("owner/repo")).toEqual({ samples: 0, milliseconds: null });
    times.record("owner/repo", 1, 0, 10 * minute);
    times.record("owner/repo", 2, 0, 20 * minute);
    expect(times.usual("owner/repo")).toEqual({ samples: 2, milliseconds: null });
    times.record("owner/repo", 3, 0, 12 * minute);
    expect(times.usual("owner/repo")).toEqual({ samples: 3, milliseconds: 12 * minute });
  });

  it("keeps every run but computes from the most recent window, and ignores a run recorded twice or without a length", () => {
    const times = createPipelineTimes(database);
    for (let number = 1; number <= 40; number += 1) {
      times.record("Owner/Repo", number, number * 100 * minute, number * 100 * minute + (number <= 20 ? 60 * minute : 5 * minute));
    }
    times.record("owner/repo", 40, 0, 999 * minute);
    times.record("owner/repo", 41, 5000, 5000);
    times.record("owner/repo", 42, 5000, 4000);
    const kept = database.connection.prepare("SELECT COUNT(*) AS n FROM pipeline_durations").get();
    expect(kept).toEqual({ n: 40 });
    expect(times.usual("owner/repo")).toEqual({ samples: usualWindow, milliseconds: 5 * minute });
  });

  it("is kept apart for each repository", () => {
    const times = createPipelineTimes(database);
    for (let number = 1; number <= 3; number += 1) {
      times.record("owner/one", number, 0, 5 * minute);
      times.record("owner/two", number, 0, 50 * minute);
    }
    expect(times.usual("owner/one").milliseconds).toBe(5 * minute);
    expect(times.usual("owner/two").milliseconds).toBe(50 * minute);
  });
});

describe("saying a time", () => {
  it("says minutes and hours in English and in Chinese", () => {
    expect(durationWords(minute)).toBe("1 minute");
    expect(durationWords(42 * minute)).toBe("42 minutes");
    expect(durationWords(120 * minute)).toBe("2 hours");
    expect(durationWords(135 * minute)).toBe("2 hours 15 minutes");
    expect(durationChinese(42 * minute)).toBe("42 分钟");
    expect(durationChinese(120 * minute)).toBe("2 小时");
    expect(durationChinese(135 * minute)).toBe("2 小时 15 分钟");
  });

  it("puts the wait and the usual on one line for read_ticket", () => {
    expect(waitedLine({ waited: 52 * minute, usual: 14 * minute, samples: 9, threshold: 42 * minute })).toBe(
      "Waiting on the pipeline for 52 minutes; usual for this repository: 14 minutes, the median of its last 9 green pipelines. You are told at 42 minutes (3 times the usual) and again at each doubling. The time decides nothing: the ticket stays verifying.",
    );
    expect(waitedLine({ waited: 5 * minute, usual: null, samples: 1, threshold: 120 * minute })).toContain("there is no usual time for this repository yet (1 green pipeline recorded), so the first-time allowance applies");
  });
});
