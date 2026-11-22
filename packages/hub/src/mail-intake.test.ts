import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Mailbox } from "./app-gateway.js";
import { AppGatewayError } from "./app-server.js";
import { openDatabase, type HubDatabase } from "./database.js";
import { createMailIntake, mailPollMilliseconds } from "./mail-intake.js";
import { ownerEmail, TestClock } from "./testing/access.js";

const minute = 60_000;
const gmail: Mailbox = { id: "gmail", label: "Gmail", provider: "gmail" };
const outlook: Mailbox = { id: "outlook:one", label: "one@example.com", provider: "outlook", email: "one@example.com", link: "one" };

let folder: string;
let database: HubDatabase;
let clock: TestClock;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "mail-intake-"));
  clock = new TestClock();
  database = openDatabase({ clock, dataDir: folder });
});

afterEach(() => {
  database.close();
  rmSync(folder, { recursive: true, force: true });
});

it("pages independently and deduplicates overlapping reads per mailbox while ignoring sent mail", async () => {
  const received = new Date(clock.now() - 30_000).toISOString();
  const outlookReceived = new Date(clock.now() - 4 * minute).toISOString();
  const receiver = vi.fn();
  const healthy = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<unknown>();
  let waiting = true;
  const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "gmail.search_emails") {
      if (args["next_page_token"] === "page-2") return { emails: [{ id: "page-two", from_: "sender@example.com", email_ts: received }] };
      return { emails: [
        { id: "same-id", from_: "sender@example.com", email_ts: received },
        { id: "sent-label", from_: "sender@example.com", email_ts: received, labels: ["SENT"] },
        { id: "own-gmail", from_: `Owner <${ownerEmail}>`, email_ts: received },
      ], next_page_token: "page-2" };
    }
    if (waiting) return blocked.promise;
    return { value: [
      { id: "same-id", sender: { emailAddress: { address: "sender@example.com" } }, receivedDateTime: outlookReceived },
      { id: "own-outlook", sender: { emailAddress: { address: outlook.email } }, receivedDateTime: outlookReceived },
    ] };
  });
  const intake = createMailIntake({
    database, clock, ownerEmail, gateway: { hasInventory: () => true, mailboxes: () => [outlook, gmail], call },
    writeNotice: (notice) => () => receiver(notice),
    changed: () => {
      if (intake.status().some((item) => item.provider === "gmail" && item.reading === "reading")) healthy.resolve();
    },
  });
  const first = intake.poll();
  await healthy.promise;
  const messages = database.connection.prepare("SELECT mailbox, message FROM mail_messages ORDER BY mailbox, message");
  expect(messages.all()).toEqual([{ mailbox: gmail.id, message: "page-two" }, { mailbox: gmail.id, message: "same-id" }]);
  expect(intake.status()).toContainEqual({ provider: "outlook", label: outlook.label, reading: "waiting" });
  blocked.reject(new AppGatewayError("timeout"));
  await first;
  waiting = false;
  await intake.poll();
  expect(messages.all()).toEqual([
    { mailbox: gmail.id, message: "page-two" }, { mailbox: gmail.id, message: "same-id" }, { mailbox: outlook.id, message: "same-id" },
  ]);
  clock.advance(mailPollMilliseconds);
  await intake.poll();
  expect(messages.all()).toHaveLength(3);
  expect(call.mock.calls.some(([name, args]) => name === "gmail.search_emails" && String(args["query"]).includes("-in:sent"))).toBe(true);
  expect(receiver).not.toHaveBeenCalled();
  intake.close();
});

it("skips an isolated minute once and never skips a stalled mailbox whose adjacent minute also times out", async () => {
  const badMinute = clock.now() - mailPollMilliseconds;
  const notices: string[] = [];
  let outage = false;
  const windows: Array<readonly [number, number]> = [];
  const intake = createMailIntake({
    database, clock, ownerEmail,
    gateway: {
      hasInventory: () => true,
      mailboxes: () => [outlook],
      call: async (_name, args) => {
        const [from, until] = (String(args["filter"]).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu) ?? []).map(Date.parse) as [number, number];
        windows.push([from, until]);
        if (outage || (from <= badMinute && until > badMinute)) throw new AppGatewayError("timeout");
        return { value: [], has_more: false };
      },
    },
    changed: () => undefined,
    writeNotice: (notice) => () => notices.push(notice),
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    await intake.poll();
    clock.advance(mailPollMilliseconds);
  }
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(outlook.label);
  expect(notices[0]).toContain("已跳过");
  const getCursor = () => database.connection.prepare("SELECT cursor, floor FROM mail_cursors").get();
  expect(getCursor()).toEqual({ cursor: badMinute + 2 * minute, floor: badMinute + minute });
  await intake.poll();
  expect(windows.at(-1)?.[0]).toBeGreaterThan(badMinute);
  const lastGood = getCursor();
  outage = true;
  clock.advance(60 * minute);
  for (let attempt = 0; attempt < 7; attempt++) {
    await intake.poll();
    clock.advance(mailPollMilliseconds);
  }
  expect(getCursor()).toEqual(lastGood);
  expect(notices).toHaveLength(2);
  expect(notices[1]).toBe(`邮箱 ${outlook.label} 已一小时没有读取进展。`);
  expect(intake.status()).toContainEqual({ provider: "outlook", label: outlook.label, reading: "stalled" });
  outage = false;
  await intake.poll();
  expect(intake.status()).toContainEqual({ provider: "outlook", label: outlook.label, reading: "reading" });
  intake.close();
});
