import type { Ticket } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { rearrangePrompt } from "./rearrange.js";

const code = (id: number) => ["", "aaa", "aab", "aac"][id];

const item = (id: number, repository: string | null, waitsFor: number[]): Ticket => ({
  id, code: code(id), codeDate: "2026-11-19", repository, waits: waitsFor.map((before) => ({ reference: `${code(before)}-2026-11-19` })), state: "waiting", form: "task", kind: "deployment", issues: [{ number: 9 }],
}) as unknown as Ticket;

describe("rearrange prompt", () => {
  it("includes scoped ticket details and current dependencies", () => {
    const tickets = [item(1, "org/one", [2, 3]), item(2, null, []), item(3, "org/two", [])];
    const project = rearrangePrompt("ORG/ONE", tickets);
    expect(project).toContain('repository "ORG/ONE"');
    expect(project).toContain('"state":"waiting"');
    expect(project).toContain('"kind":"deployment"');
    expect(project).toContain('"issues":[{"number":9}]');
    expect(project).toContain('"after":["ticket aab-2026-11-19","ticket aac-2026-11-19"]');
    expect(project).not.toContain('"ticket":"ticket aab-2026-11-19"');
    expect(rearrangePrompt(null, tickets)).toContain('"ticket":"ticket aab-2026-11-19"');
    expect(rearrangePrompt(undefined, tickets)).toContain('"ticket":"ticket aac-2026-11-19"');
  });
});
