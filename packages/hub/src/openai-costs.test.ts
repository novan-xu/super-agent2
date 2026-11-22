import { describe, expect, it, vi } from "vitest";
import { createOpenAICosts, monthStart } from "./openai-costs.js";

const page = (value: number, next: string | null = null) => Response.json({ data: [{ results: [{ amount: { value, currency: "usd" } }] }], next_page: next, has_more: next !== null });

describe("OpenAI costs", () => {
  it("uses the local month boundary across a daylight saving transition", () => {
    expect(new Date(monthStart(Date.parse("2026-11-01T03:30:00Z"), "America/New_York")).toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(new Date(monthStart(Date.parse("2026-11-01T05:30:00Z"), "America/New_York")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
  it("sums pages and retains the last reading as unknown on failure or empty results", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(1.25, "next")).mockResolvedValueOnce(page(2.5)).mockResolvedValueOnce(new Response("secret body", { status: 403 })).mockResolvedValueOnce(Response.json({ data: [], next_page: null }));
    const report = vi.fn();
    const costs = createOpenAICosts({ key: "private-admin-value", timeZone: "America/New_York", now: () => Date.parse("2026-11-22T12:00:00Z"), changed: () => undefined, report, fetch: fetcher });
    await costs.refresh();
    expect(costs.reading(10)).toMatchObject({ state: "available", amount: 3.75, currency: "USD", budget: 10 });
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("start_time")).toBe(String(Date.parse("2026-11-01T04:00:00Z") / 1000));
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("page")).toBe("next");
    await costs.refresh();
    expect(costs.reading(null)).toMatchObject({ state: "unknown", amount: 3.75, readAt: Date.parse("2026-11-22T12:00:00Z") });
    await costs.refresh();
    expect(costs.reading(null).state).toBe("unknown");
    expect(JSON.stringify(report.mock.calls)).not.toContain("private-admin-value");
    expect(JSON.stringify(report.mock.calls)).not.toContain("secret body");
    costs.close();
  });
});
