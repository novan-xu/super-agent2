import { expect, it, vi } from "vitest";
import { dryRun } from "./mail-filter-dry-run.js";
import { mailFilterConfig, validateFilter } from "./mail-filter.js";

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
    { days: 30, now: Date.parse("2026-11-22T00:00:00Z"), memory: "" });
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every(([name]) => name === "gmail.search_emails")).toBe(true);
  expect(result).toMatchObject({ rows: [{ subject: "One" }, { subject: "Two" }], totals: [{ mailbox: "Gmail", kept: 0, ignored: 2 }], filterCalls: 1 });
});
