import type { MachineChoice, StartChoice, Ticket, WaitingCard } from "@super-agent2/protocol";

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
    difficultyReason: null,
    platform: null,
    brainEngine: null,
    ownerChoice: { machine: null, engine: null, model: null, effort: null },
    state: "pending",
    machine: null,
    engine: null,
    model: null,
    effort: null,
    chosenBy: null,
    chosenAt: null,
    ran: null,
    branch: null,
    pullRequest: null,
    round: 0,
    waitsFor: [],
    waits: [],
    deployedAt: null,
    beginFailure: null,
    report: null,
    work: null,
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

export const fixtureMachines: MachineChoice[] = [
  {
    name: "pc",
    platform: "win32",
    free: 2,
    engines: [
      { engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["medium", "high"] }, { id: "gpt-6-luna", efforts: ["low", "medium"] }] },
      { engine: "claude", models: [{ id: "claude-opus-5-5", efforts: ["high", "max"] }] },
    ],
  },
  { name: "mini", platform: "darwin", free: 1, engines: [{ engine: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["high"] }] }] },
];

export function fixtureChoice(overrides: Partial<StartChoice> = {}): StartChoice {
  return {
    machine: "pc",
    engine: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    by: { machine: "default", engine: "default", model: "default", effort: "default" },
    missing: [],
    ...overrides,
  };
}

export function startCard(
  id: number,
  overrides: {
    readonly before?: readonly { readonly id: number; readonly zh: string; readonly state?: Ticket["state"] }[];
    readonly startable?: boolean;
    readonly ticket?: Partial<Ticket>;
    readonly fingerprint?: string;
    readonly choice?: Partial<StartChoice>;
    readonly machines?: readonly MachineChoice[];
  } = {},
): WaitingCard {
  return {
    kind: "start",
    key: `start:${id}`,
    at: id * 1000,
    ticket: ticket(id, overrides.ticket),
    fingerprint: overrides.fingerprint ?? String(id % 10).repeat(64),
    before: (overrides.before ?? []).map((entry) => ({
      id: entry.id,
      title: { en: `Work ${entry.id}`, zh: entry.zh },
      repository: "novan-xu/super-agent-sandbox",
      state: entry.state ?? "pending",
    })),
    startable: overrides.startable ?? true,
    choice: fixtureChoice(overrides.choice),
    machines: [...(overrides.machines ?? fixtureMachines)],
  };
}
