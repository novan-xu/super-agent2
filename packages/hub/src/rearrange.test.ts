import type { Ticket } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { rearrangePrompt } from "./rearrange.js";

const item = (id: number, repository: string | null, waitsFor: number[]): Ticket => ({
  id, repository, waitsFor, state: "waiting", form: "task", kind: "deployment", issues: [{ number: 9 }],
}) as unknown as Ticket;

describe("rearrange prompt", () => {
  it("includes scoped ticket details and current dependencies", () => {
    const tickets = [item(1, "org/one", [2, 3]), item(2, null, []), item(3, "org/two", [])];
    const project = rearrangePrompt("ORG/ONE", tickets);
    expect(project).toContain('repository "ORG/ONE"');
    expect(project).toContain('"state":"waiting"');
    expect(project).toContain('"kind":"deployment"');
    expect(project).toContain('"issues":[{"number":9}]');
    expect(project).toContain('"after":[2,3]');
    expect(project).not.toContain('"id":2');
    expect(rearrangePrompt(null, tickets)).toContain('"id":2');
    expect(rearrangePrompt(undefined, tickets)).toContain('"id":3');
  });
});
