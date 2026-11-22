import { expect, it, vi } from "vitest";
import { dryRun, parseWindow } from "./mail-filter-dry-run.js";
import { mailFilterConfig, mailFilterOutputSchema, validateFilter } from "./mail-filter.js";

it("requires exactly one known decision with a short single-line reason", () => {
  const messages = [{ item: 1, mailbox: "Gmail", sender: "a", subject: "b", snippet: "c" }];
  for (const items of [[], [{ item: 2, action: "keep", reason: "x" }], [{ item: 1, action: "keep", reason: "x" }, { item: 1, action: "ignore", reason: "x" }], [{ item: 1, action: "ignore", reason: "x\ny" }]]) {
    expect(() => validateFilter({ items }, messages)).toThrow();
  }
  expect(mailFilterConfig.instructions).toContain("Ignore uncertain mail");
});

it("reads every historical page and only returns results", async () => {
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => args["next_page_token"] === undefined
    ? { emails: [{ id: "1", from_: "a@example.com", subject: "One", snippet: "s", email_ts: "2026-11-20T00:00:00Z" }], next_page_token: "next" }
    : { emails: [{ id: "2", from_: "b@example.com", subject: "Two", snippet: "s", email_ts: "2026-11-20T00:00:00Z" }] });
  const result = await dryRun({ call, mailboxes: () => [{ id: "gmail", provider: "gmail", label: "Gmail" }] },
    async (messages) => messages.map(({ item }) => ({ item, action: "ignore", reason: "Routine" })),
    { from: Date.parse("2026-10-23T00:00:00Z"), until: Date.parse("2026-11-22T00:00:00Z"), memory: "" });
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every(([name]) => name === "gmail.search_emails")).toBe(true);
  expect(result).toMatchObject({ rows: [{ subject: "One" }, { subject: "Two" }], totals: [{ mailbox: "Gmail", kept: 0, ignored: 2 }], filterCalls: 1 });
});

it("requires a valid kind for every kept item and states the requested exceptions", () => {
  const messages = [{ item: 1, mailbox: "Gmail", sender: "a@example.com", subject: "x", snippet: "" }];
  for (const kind of [undefined, "", "New Device", "bad\nkind"]) {
    expect(() => validateFilter({ items: [{ item: 1, action: "keep", reason: "x", ...(kind === undefined ? {} : { kind }) }] }, messages)).toThrow();
  }
  expect(validateFilter({ items: [{ item: 1, action: "keep", reason: "x", kind: "new-device" }] }, messages)).toHaveLength(1);
  for (const phrase of ["GitHub CI", "loyalty", "one-time verification", "security alerts", "password resets", "bills with a due date", "memory keep rules override"]) expect(mailFilterConfig.instructions).toContain(phrase);
});

it("reports merged representatives and counts in dry runs", async () => {
  const call = vi.fn(async () => ({ emails: [
    { id: "1", from_: "a@example.com", subject: "One", snippet: "s", email_ts: "2026-11-20T00:00:00Z" },
    { id: "2", from_: "A@example.com", subject: "Two", snippet: "s", email_ts: "2026-11-21T00:00:00Z" },
  ] }));
  const result = await dryRun({ call, mailboxes: () => [{ id: "gmail", provider: "gmail", label: "Gmail" }] },
    async (messages) => messages.map(({ item }) => ({ item, action: "keep", reason: "Alert", kind: "alert" })),
    { from: Date.parse("2026-10-23T00:00:00Z"), until: Date.parse("2026-11-22T00:00:00Z"), memory: "" });
  expect(result.rows).toMatchObject([{ kind: "alert", mergedInto: "2", merged_into: "2", groupCount: 0 }, { kind: "alert", mergedInto: null, merged_into: null, groupCount: 2 }]);
  expect(result.totals).toMatchObject([{ kept: 2, merged: 1 }]);
});

it("uses a service-compatible schema while retaining strict decision validation", () => {
  expect(JSON.stringify(mailFilterOutputSchema)).not.toContain('"oneOf"');
  const messages = [{ item: 1, mailbox: "Gmail", sender: "a", subject: "b", snippet: "c" }];
  expect(() => validateFilter({ items: [{ item: 1, action: "ignore", reason: "x", kind: "alert" }] }, messages)).toThrow();
});

it("parses either relative days or a fixed inclusive-exclusive window", () => {
  const since = "2026-11-01T00:00:00Z"; const until = "2026-11-02T00:00:00Z";
  expect(parseWindow(new Map([["--since", since], ["--until", until]]), 0)).toEqual({ from: Date.parse(since), until: Date.parse(until) });
  expect(parseWindow(new Map([["--days", "1"]]), Date.parse(until))).toEqual({ from: Date.parse(since), until: Date.parse(until) });
  for (const values of [[ ["--since", since] ], [["--since", until], ["--until", since]], [["--days", "1"], ["--since", since], ["--until", until]], [["--days", "0"]], [["--since", "bad"], ["--until", until]]]) {
    expect(() => parseWindow(new Map(values as [string, string][]), 0)).toThrow();
  }
});

it("includes the start and excludes the end of a fixed window", async () => {
  const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ emails: [
    { id: "before", from_: "a@example.com", email_ts: "2026-10-31T23:59:59Z" },
    { id: "start", from_: "a@example.com", email_ts: "2026-11-01T00:00:00Z" },
    { id: "end", from_: "a@example.com", email_ts: "2026-11-02T00:00:00Z" },
  ] }));
  const result = await dryRun({ call, mailboxes: () => [{ id: "gmail", provider: "gmail", label: "Gmail" }] },
    async (messages) => messages.map(({ item }) => ({ item, action: "ignore", reason: "Routine" })),
    { from: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-02T00:00:00Z"), memory: "" });
  expect(result.rows.map((row) => row.messageId)).toEqual(["start"]);
  expect(call.mock.calls[0]?.[1]).toMatchObject({ query: expect.stringContaining(`after:${Date.parse("2026-11-01T00:00:00Z") / 1000 - 1}`) });
});
