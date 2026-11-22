import { readFile, writeFile } from "node:fs/promises";
import { AppGateway, type Mailbox } from "./app-gateway.js";
import { codexMailFilter, validateFilter, type MailFilter } from "./mail-filter.js";
import { incoming, pages } from "./mail-intake.js";

interface DryRunOptions {
  readonly days: number;
  readonly mailbox?: string;
  readonly memory: string;
  readonly now: number;
}

export async function dryRun(gateway: Pick<AppGateway, "call" | "mailboxes">, filter: MailFilter, options: DryRunOptions) {
  const start = Date.now();
  const from = options.now - options.days * 86_400_000;
  const accounts = gateway.mailboxes().filter((account) => account.provider === "gmail" || account.link !== undefined);
  if (accounts.length === 0) throw new Error("No linked mailboxes found");
  const selected = options.mailbox === undefined ? accounts : accounts.filter((account) => account.id === options.mailbox);
  if (options.mailbox !== undefined && selected.length === 0) throw new Error("Mailbox not found");
  const own = new Set(accounts.flatMap(({ email }) => email === undefined ? [] : [email.toLowerCase()]));
  const rows: { mailbox: string; received: string; sender: string; subject: string; action: string; reason: string }[] = [];
  const totals: { id: string; mailbox: string; kept: number; ignored: number }[] = [];
  let calls = 0;
  for (const account of selected) {
    const seen = new Set<string>();
    const messages: ReturnType<typeof incoming>[] = [];
    for await (const page of pages(gateway, account as Mailbox, from, options.now)) {
      for (const raw of page) {
        const message = incoming(raw, own, from, options.now);
        if (message !== undefined && !seen.has(message.id)) { seen.add(message.id); messages.push(message); }
      }
    }
    let kept = 0;
    let ignored = 0;
    for (let offset = 0; offset < messages.length; offset += 20) {
      const batch = messages.slice(offset, offset + 20).filter((message) => message !== undefined);
      const envelopes = batch.map((message, index) => ({ item: index + 1, mailbox: account.label, sender: message.sender, subject: message.subject, snippet: message.snippet }));
      const decisions = validateFilter({ items: await filter(envelopes, options.memory) }, envelopes);
      calls += 1;
      const byId = new Map(decisions.map((decision) => [decision.item, decision]));
      batch.forEach((message, index) => {
        const decision = byId.get(index + 1);
        if (decision === undefined || decisions.length !== batch.length || byId.size !== batch.length) throw new Error("Invalid filter response");
        if (decision.action === "keep") kept += 1; else ignored += 1;
        rows.push({ mailbox: account.label, received: new Date(message.timestamp).toISOString(), sender: message.sender, subject: message.subject, action: decision.action, reason: decision.reason });
      });
    }
    totals.push({ id: account.id, mailbox: account.label, kept, ignored });
  }
  return { rows, totals, filterCalls: calls, elapsedMilliseconds: Date.now() - start };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: node dist/mail-filter-dry-run.js --days 30 [--mailbox ID] [--memory-file PATH] [--out FILE]\n");
    return;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (key === undefined || !["--days", "--mailbox", "--memory-file", "--out"].includes(key) || value === undefined || value.startsWith("--") || values.has(key)) throw new Error("Invalid arguments; use --help");
    values.set(key, value);
  }
  const days = Number(values.get("--days"));
  if (!Number.isInteger(days) || days <= 0) throw new Error("--days must be a positive integer");
  const memoryFile = values.get("--memory-file");
  const memory = memoryFile === undefined ? "" : await readFile(memoryFile, "utf8");
  const gateway = new AppGateway({ cwd: process.cwd(), environment: process.env });
  try {
    await gateway.refresh();
    if (!gateway.hasInventory()) throw new Error("Could not discover connected apps");
    const mailbox = values.get("--mailbox");
    const result = await dryRun(gateway, codexMailFilter(process.cwd(), process.env), { days, now: Date.now(), memory, ...(mailbox === undefined ? {} : { mailbox }) });
    const output = `${JSON.stringify(result, null, 2)}\n`;
    const file = values.get("--out");
    if (file === undefined) process.stdout.write(output); else await writeFile(file, output, { mode: 0o600 });
  } finally { await gateway.close(); }
}

if (process.argv[1]?.endsWith("mail-filter-dry-run.js")) main().catch(() => { process.stderr.write("Mail filter dry run failed. Check login, connections and arguments.\n"); process.exitCode = 1; });
