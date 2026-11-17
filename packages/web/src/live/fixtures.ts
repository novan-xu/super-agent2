import type { Ticket, WaitingCard } from "@super-agent2/protocol";

export function ticket(id: number, overrides: Partial<Ticket> = {}): Ticket {
  const repository = "novan-xu/super-agent-sandbox";
  const title = { en: `Work ${id}`, zh: `工作 ${id}` };
  const summary = { en: "Do it", zh: "做这件事" };
  return {
    id,
    repository,
    issues: [{ repository, number: id, url: `https://github.com/${repository}/issues/${id}`, title, summary }],
    title,
    summary,
    kind: "feature",
    difficulty: null,
    platform: null,
    state: "pending",
    machine: null,
    engine: null,
    model: null,
    effort: null,
    branch: null,
    pullRequest: null,
    round: 0,
    waitsFor: [],
    stopReason: null,
    conversation: null,
    createdAt: id * 1000,
    updatedAt: id * 1000,
    ...overrides,
  };
}

export function holdCard(id: string, overrides: { readonly at?: number; readonly command?: string; readonly cwd?: string | null; readonly fingerprint?: string } = {}): WaitingCard {
  const at = overrides.at ?? 1_000;
  return {
    kind: "hold",
    key: `hold:${id}`,
    at,
    command: {
      id,
      target: "nas",
      command: overrides.command ?? "gh repo delete novan-xu/old --yes",
      account: "novan-xu",
      cwd: overrides.cwd === undefined ? "/srv/projects/app" : overrides.cwd,
      state: "held",
      exitCode: null,
      signal: null,
      reason: null,
      createdAt: at,
      startedAt: null,
      endedAt: null,
    },
    hold: {
      command: id,
      form: "repository-deletion",
      description: "删除仓库",
      evidence: "gh repo delete",
      fingerprint: overrides.fingerprint ?? id.padEnd(64, "0").replaceAll(/[^0-9a-f]/g, "a"),
      heldAt: at,
      answer: null,
      answeredAt: null,
      answeredBy: null,
    },
  };
}
