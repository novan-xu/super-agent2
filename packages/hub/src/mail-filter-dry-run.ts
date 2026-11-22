import { readFile, writeFile } from "node:fs/promises";
import { AppGateway, type Mailbox } from "./app-gateway.js";
import { codexMailFilter, groupKept, validateFilter, type MailFilter } from "./mail-filter.js";
import { incoming, pages } from "./mail-intake.js";

interface DryRunOptions {
  readonly from: number;
  readonly mailbox?: string;
  readonly memory: string;
  readonly until: number;
}

export async function dryRun(gateway: Pick<AppGateway, "call" | "mailboxes">, filter: MailFilter, options: DryRunOptions) {
  const start = Date.now();
  const { from, until } = options;
  const accounts = gateway.mailboxes().filter((account) => account.provider === "gmail" || account.link !== undefined);
  if (accounts.length === 0) throw new Error("No linked mailboxes found");
  const selected = options.mailbox === undefined ? accounts : accounts.filter((account) => account.id === options.mailbox);
  if (options.mailbox !== undefined && selected.length === 0) throw new Error("Mailbox not found");
  const own = new Set(accounts.flatMap(({ email }) => email === undefined ? [] : [email.toLowerCase()]));
  const rows: { mailbox: string; messageId: string; received: string; sender: string; subject: string; action: string; reason: string; kind: string | null; mergedInto: string | null; merged_into: string | null; groupCount: number }[] = [];
  const totals: { id: string; mailbox: string; kept: number; ignored: number; merged: number }[] = [];
  let calls = 0;
  for (const account of selected) {
    const seen = new Set<string>();
    const messages: ReturnType<typeof incoming>[] = [];
    for await (const page of pages(gateway, account as Mailbox, from, until)) {
      for (const raw of page) {
        const message = incoming(raw, own, from, until);
        if (message !== undefined && !seen.has(message.id)) { seen.add(message.id); messages.push(message); }
      }
    }
    let kept = 0;
    let ignored = 0;
    let merged = 0;
    for (let offset = 0; offset < messages.length; offset += 20) {
      const batch = messages.slice(offset, offset + 20).filter((message) => message !== undefined);
      const envelopes = batch.map((message, index) => ({ item: index + 1, mailbox: account.label, sender: message.sender, subject: message.subject, snippet: message.snippet }));
      const decisions = validateFilter({ items: await filter(envelopes, options.memory) }, envelopes);
      calls += 1;
      const byId = new Map(decisions.map((decision) => [decision.item, decision]));
      const groups = groupKept(batch.map((message, index) => ({ ...message, item: index + 1 })), decisions);
      const groupByItem = new Map(groups.flatMap((group) => group.members.map((member) => [member.item, group] as const)));
      batch.forEach((message, index) => {
        const decision = byId.get(index + 1);
        if (decision === undefined || decisions.length !== batch.length || byId.size !== batch.length) throw new Error("Invalid filter response");
        if (decision.action === "keep") kept += 1; else ignored += 1;
        const group = groupByItem.get(index + 1);
        const mergedInto = group !== undefined && group.representative.item !== index + 1 ? group.representative.id : null;
        if (mergedInto !== null) merged += 1;
        rows.push({ mailbox: account.label, messageId: message.id, received: new Date(message.timestamp).toISOString(), sender: message.sender, subject: message.subject, action: decision.action, reason: decision.reason, kind: decision.action === "keep" ? decision.kind : null, mergedInto, merged_into: mergedInto, groupCount: group?.representative.item === index + 1 ? group.members.length : 0 });
      });
    }
    totals.push({ id: account.id, mailbox: account.label, kept, ignored, merged });
  }
  return { rows, totals, filterCalls: calls, elapsedMilliseconds: Date.now() - start };
}

export function parseWindow(values: ReadonlyMap<string, string>, now: number): { from: number; until: number } {
  const daysText = values.get("--days");
  const since = values.get("--since");
  const untilText = values.get("--until");
  if (daysText !== undefined && since === undefined && untilText === undefined) {
    const days = Number(daysText);
    if (!Number.isInteger(days) || days <= 0 || !Number.isFinite(now - days * 86_400_000)) throw new Error("Invalid days");
    return { from: now - days * 86_400_000, until: now };
  }
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (daysText !== undefined || since === undefined || untilText === undefined || !iso.test(since) || !iso.test(untilText)) throw new Error("Invalid window");
  const from = Date.parse(since); const until = Date.parse(untilText);
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) throw new Error("Invalid window");
  return { from, until };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: node dist/mail-filter-dry-run.js (--days 30 | --since ISO --until ISO) [--mailbox ID] [--memory-file PATH] [--out FILE]\n");
    return;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (key === undefined || !["--days", "--since", "--until", "--mailbox", "--memory-file", "--out"].includes(key) || value === undefined || value.startsWith("--") || values.has(key)) throw new Error("Invalid arguments; use --help");
    values.set(key, value);
  }
  const window = parseWindow(values, Date.now());
  const memoryFile = values.get("--memory-file");
  const memory = memoryFile === undefined ? "" : await readFile(memoryFile, "utf8");
  const gateway = new AppGateway({ cwd: process.cwd(), environment: process.env });
  try {
    await gateway.refresh();
    if (!gateway.hasInventory()) throw new Error("Could not discover connected apps");
    const mailbox = values.get("--mailbox");
    const result = await dryRun(gateway, codexMailFilter(process.cwd(), process.env), { ...window, memory, ...(mailbox === undefined ? {} : { mailbox }) });
    const output = `${JSON.stringify(result, null, 2)}\n`;
    const file = values.get("--out");
    if (file === undefined) process.stdout.write(output); else await writeFile(file, output, { mode: 0o600 });
  } finally { await gateway.close(); }
}

if (process.argv[1]?.endsWith("mail-filter-dry-run.js")) main().catch(() => { process.stderr.write("Mail filter dry run failed. Check login, connections and arguments.\n"); process.exitCode = 1; });
