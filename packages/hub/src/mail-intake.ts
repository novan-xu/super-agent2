import { text } from "@super-agent2/catalog";
import type { AppGatewayStatus } from "@super-agent2/protocol";
import { z } from "zod";
import type { AppGateway, Mailbox } from "./app-gateway.js";
import { AppGatewayError } from "./app-server.js";
import { mailEnvelope } from "./app-tools.js";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { mailTransaction } from "./mail-state.js";
import { intervalTicker, type Ticker } from "./verification.js";

const minute = 60_000;
export const mailPollMilliseconds = 5 * minute;
const maximumSlice = 15 * minute;
const overlap = 2 * minute;
const stallDelay = 60 * minute;
const skipAfter = 3;
const pageSize = 50;
const gmailTool = "gmail.search_emails";
const outlookTool = "microsoft_outlook_email.list_messages";

const GmailPage = z.object({ emails: z.array(z.unknown()), next_page_token: z.string().nullish() });
const OutlookPage = z.object({ value: z.array(z.unknown()), has_more: z.boolean().optional(), next_from_index: z.number().int().nonnegative().nullish() });
const Cursor = z.object({
  mailbox: z.string(), label: z.string(), provider: z.enum(["gmail", "outlook"]),
  cursor: z.number(), floor: z.number(), width: z.number(), progress_at: z.number(),
  failed: z.number(), timeouts: z.number(), stalled: z.number(),
});
type Cursor = z.infer<typeof Cursor>;
const EnvelopeFlags = z.object({
  labels: z.array(z.string()).nullish(), labelIds: z.array(z.string()).nullish(), label_ids: z.array(z.string()).nullish(),
  isDraft: z.boolean().nullish(), is_draft: z.boolean().nullish(),
  sender: z.union([z.string(), z.object({ emailAddress: z.object({ address: z.string() }).nullish() })]).nullish(),
});
const ignoredLabels = new Set(["SENT", "DRAFT", "SPAM", "TRASH", "CHAT"]);

type MailGateway = Pick<AppGateway, "call" | "hasInventory" | "mailboxes">;

interface MailIntakeOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly gateway: MailGateway;
  readonly ownerEmail: string;
  readonly writeNotice: (notice: string) => () => void;
  readonly changed: () => void;
  readonly ticker?: Ticker | undefined;
  readonly report?: ((line: string) => void) | undefined;
}

function email(value: string): string {
  return (/<([^<>]+)>/u.exec(value)?.[1] ?? value).trim().toLowerCase();
}

export function incoming(raw: unknown, own: ReadonlySet<string>, from: number, until: number) {
  const flags = EnvelopeFlags.safeParse(raw).data;
  if (flags?.isDraft || flags?.is_draft || [flags?.labels, flags?.labelIds, flags?.label_ids].some((labels) => labels?.some((label) => ignoredLabels.has(label)))) {
    return undefined;
  }
  const message = mailEnvelope(raw);
  const sender = typeof flags?.sender === "string" ? flags.sender : flags?.sender?.emailAddress?.address;
  if (own.has(email(message.sender)) || (sender !== undefined && own.has(email(sender)))) return undefined;
  const timestamp = message.receivedAt === null ? NaN : Date.parse(message.receivedAt);
  if (Number.isFinite(timestamp) && (timestamp < from || timestamp >= until)) return undefined;
  return { ...message, timestamp: Number.isFinite(timestamp) ? timestamp : from };
}

export async function* pages(gateway: Pick<MailGateway, "call">, mailbox: Mailbox, from: number, until: number): AsyncGenerator<unknown[]> {
  if (mailbox.provider === "gmail") {
    const seen = new Set<string>();
    let next: string | undefined;
    do {
      const page = GmailPage.safeParse(await gateway.call(gmailTool, {
        query: `after:${Math.floor(from / 1000)} before:${Math.ceil(until / 1000)} -in:sent -in:drafts -in:spam -in:trash -in:chats`,
        max_results: pageSize,
        ...(next === undefined ? {} : { next_page_token: next }),
      }));
      if (!page.success) throw new AppGatewayError("invalid response");
      yield page.data.emails;
      next = page.data.next_page_token || undefined;
      if (next !== undefined) {
        if (seen.has(next)) throw new AppGatewayError("invalid response");
        seen.add(next);
      }
    } while (next !== undefined);
    return;
  }
  let skip = 0;
  for (;;) {
    const page = OutlookPage.safeParse(await gateway.call(outlookTool, {
      link_id: mailbox.link,
      filter: `receivedDateTime ge ${new Date(from).toISOString()} and receivedDateTime lt ${new Date(until).toISOString()} and isDraft eq false`,
      order_by: "receivedDateTime asc", top: pageSize, skip,
    }));
    if (!page.success) throw new AppGatewayError("invalid response");
    yield page.data.value;
    const next = page.data.next_from_index;
    if (page.data.has_more === false || (next == null && page.data.has_more !== true)) return;
    if (next == null || next <= skip) throw new AppGatewayError("invalid response");
    skip = next;
  }
}

export function createMailIntake(options: MailIntakeOptions) {
  const { connection: db, ticketTimeZone } = options.database;
  const format = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", timeZone: ticketTimeZone });
  const cursors = db.prepare("SELECT * FROM mail_cursors WHERE active = 1 ORDER BY provider, label, mailbox");
  const upsert = db.prepare(`INSERT INTO mail_cursors (mailbox, label, provider, cursor, floor, width, progress_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mailbox) DO UPDATE SET label = excluded.label, active = 1`);
  const deactivate = db.prepare("UPDATE mail_cursors SET active = 0 WHERE active = 1");
  const fail = db.prepare("UPDATE mail_cursors SET failed = 1, width = ?, timeouts = ? WHERE mailbox = ?");
  const stall = db.prepare("UPDATE mail_cursors SET stalled = 1 WHERE mailbox = ? AND stalled = 0 RETURNING mailbox");
  const advance = db.prepare(`UPDATE mail_cursors SET cursor = ?, floor = ?, width = ?, progress_at = ?,
    failed = 0, timeouts = 0, stalled = 0 WHERE mailbox = ?`);
  const insert = db.prepare(`INSERT INTO mail_messages (mailbox, message, received_at, sender, subject, snippet)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(mailbox, message) DO NOTHING`);
  const running = new Map<string, Promise<void>>();
  let stopped = false;
  let cancel: (() => void) | undefined;
  let inventoryKnown = false;

  const stallIfDue = (row: Cursor, now: number) => {
    if (now - row.progress_at < stallDelay) return;
    const publish = mailTransaction(db, () =>
      stall.get(row.mailbox) === undefined ? undefined : options.writeNotice(text("mail.stalled", { mailbox: row.label })));
    publish?.();
  };

  const scan = async (mailbox: Mailbox, from: number, until: number, own: ReadonlySet<string>) => {
    for await (const page of pages(options.gateway, mailbox, from, until)) {
      if (stopped) return;
      mailTransaction(db, () => {
        for (const raw of page) {
          const mail = incoming(raw, own, from, until);
          if (mail !== undefined) insert.run(mailbox.id, mail.id, mail.timestamp, mail.sender, mail.subject, mail.snippet);
        }
      });
    }
  };

  const pollMailbox = async (mailbox: Mailbox, row: Cursor, horizon: number, own: ReadonlySet<string>) => {
    if (row.cursor >= horizon) return;
    const from = row.failed ? row.cursor : Math.max(row.floor, row.cursor - overlap);
    const until = Math.min(horizon, row.cursor + row.width);
    try {
      await scan(mailbox, from, until, own);
      if (!stopped) advance.run(until, row.floor, Math.min(maximumSlice, row.width * 2), options.clock.now(), row.mailbox);
      return;
    } catch (error) {
      if (stopped) return;
      const kind = error instanceof AppGatewayError ? error.kind : "invalid response";
      options.report?.(`Mail intake: ${kind}`);
      const width = kind === "timeout" ? Math.max(minute, Math.floor((until - from) / (2 * minute)) * minute) : row.width;
      const timeouts = kind === "timeout" && from === row.cursor && until - from === minute ? row.timeouts + 1 : 0;
      fail.run(width, timeouts, row.mailbox);
      if (timeouts >= skipAfter && until + minute <= horizon) {
        try {
          await scan(mailbox, until, until + minute, own);
        } catch {
          stallIfDue(row, options.clock.now());
          return;
        }
        if (stopped) return;
        const publish = mailTransaction(db, () => {
          advance.run(until + minute, until, minute, options.clock.now(), row.mailbox);
          return options.writeNotice(text("mail.skipped", { mailbox: row.label, from: format.format(from), until: format.format(until) }));
        });
        publish();
        return;
      }
      stallIfDue(row, options.clock.now());
    }
  };

  const poll = async () => {
    if (stopped) return;
    const now = options.clock.now();
    const horizon = Math.floor(now / 1000) * 1000;
    inventoryKnown = options.gateway.hasInventory();
    if (!inventoryKnown) {
      for (const raw of cursors.all()) stallIfDue(Cursor.parse(raw), now);
      options.changed();
      return;
    }
    const accounts = options.gateway.mailboxes().filter((mailbox) => mailbox.provider === "gmail" || mailbox.link !== undefined);
    mailTransaction(db, () => {
      deactivate.run();
      for (const mailbox of accounts) {
        const start = horizon - mailPollMilliseconds;
        upsert.run(mailbox.id, mailbox.label, mailbox.provider, start, start, maximumSlice, now);
      }
    });
    const rows = new Map(cursors.all().map((raw) => {
      const row = Cursor.parse(raw);
      return [row.mailbox, row] as const;
    }));
    const own = new Set([options.ownerEmail, ...accounts.flatMap(({ email }) => email === undefined ? [] : [email])].map(email));
    options.changed();
    await Promise.all(accounts.map((mailbox) => {
      const existing = running.get(mailbox.id);
      if (existing !== undefined) return existing;
      const task = pollMailbox(mailbox, rows.get(mailbox.id)!, horizon, own).catch(() => {
        options.report?.("Mail intake: storage failure");
      }).finally(() => {
        running.delete(mailbox.id);
        if (!stopped) options.changed();
      });
      running.set(mailbox.id, task);
      return task;
    }));
  };

  return {
    poll,
    start: () => {
      const tick = () => { void poll().catch(() => options.report?.("Mail intake: storage failure")); };
      tick();
      cancel = (options.ticker ?? intervalTicker(mailPollMilliseconds))(tick);
    },
    status: (): AppGatewayStatus["mailboxes"] => cursors.all().map((raw) => {
      const row = Cursor.parse(raw);
      return { provider: row.provider, label: row.label,
        reading: row.failed || row.stalled || !inventoryKnown ? "stalled" : row.cursor === row.floor ? "waiting" : "reading" };
    }),
    close: () => { stopped = true; cancel?.(); },
    idle: async () => { await Promise.all([...running.values()]); },
  };
}
