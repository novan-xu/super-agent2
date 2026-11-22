import { z } from "zod";
import type { OpenAICost } from "@super-agent2/protocol";

const Page = z.object({ data: z.array(z.object({ results: z.array(z.object({ amount: z.object({ value: z.number().finite(), currency: z.string().min(1) }) })) })), next_page: z.string().nullable().optional(), has_more: z.boolean().optional() });

export function monthStart(now: number, timeZone: string): number {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map((part) => [part.type, Number(part.value)]));
  const current = parts(now);
  const target = Date.UTC(current.year!, current.month! - 1, 1);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(result);
    result += target - Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  }
  return result;
}

export function createOpenAICosts(options: { key: string; timeZone: string; now: () => number; changed: () => void; report: (message: string) => void; fetch?: typeof fetch }) {
  let reading: OpenAICost = { state: "unknown", amount: null, currency: null, readAt: null, budget: null };
  let pending: Promise<void> | undefined;
  let closed = false;
  const refresh = () => {
    if (pending) return pending;
    pending = (async () => {
      try {
        const url = new URL("https://api.openai.com/v1/organization/costs");
        url.searchParams.set("start_time", String(Math.floor(monthStart(options.now(), options.timeZone) / 1000)));
        url.searchParams.set("bucket_width", "1d");
        url.searchParams.set("limit", "31");
        let amount = 0;
        let currency: string | null = null;
        let count = 0;
        const pages = new Set<string>();
        do {
          const response = await (options.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${options.key}` }, signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error("http");
          const page = Page.parse(await response.json());
          for (const bucket of page.data) for (const item of bucket.results) {
            const unit = item.amount.currency.toUpperCase();
            if (currency !== null && currency !== unit) throw new Error("currency");
            currency = unit;
            amount += item.amount.value;
            count++;
          }
          if (page.has_more && !page.next_page) throw new Error("pagination");
          if (!page.next_page) break;
          if (pages.has(page.next_page) || pages.size >= 100) throw new Error("pagination");
          pages.add(page.next_page);
          url.searchParams.set("page", page.next_page);
        } while (true);
        if (!count) throw new Error("empty");
        reading = { state: "available", amount, currency, readAt: options.now(), budget: null };
      } catch {
        reading = { ...reading, state: "unknown" };
        options.report("OpenAI costs read failed");
      }
      if (!closed) options.changed();
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(() => { void refresh(); }, 15 * 60_000);
  timer.unref();
  void refresh();
  return { reading: (budget: number | null) => ({ ...reading, budget }), refresh, close: () => { closed = true; clearInterval(timer); } };
}
