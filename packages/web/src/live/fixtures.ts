import { finishedTicketStates, startingEngineTable } from "@super-agent2/protocol";
import type { MachineChoice, SettingsSnapshot, StartChoice, StoredWorkEvent, Ticket, TicketVerification, WaitingCard, WorkEvent, WorkStatus } from "@super-agent2/protocol";

export function verification(overrides: Partial<TicketVerification> = {}): TicketVerification {
  return {
    head: "abcdef1234567890",
    level: "code",
    rule: "workflows",
    state: "waiting",
    waiting: "pipeline",
    reason: null,
    pipeline: null,
    workflows: [],
    failures: [],
    mergeCommit: null,
    deployment: null,
    skipReason: null,
    conflictReturns: 0,
    checkedAt: 10_000,
    ...overrides,
  };
}

export function workStatus(overrides: Partial<WorkStatus> = {}): WorkStatus {
  return {
    attempt: 1,
    state: "running",
    machine: "pc",
    engine: "codex",
    model: "gpt-6-luna",
    effort: "medium",
    session: null,
    failure: null,
    reason: null,
    unreachableSince: null,
    last: 0,
    createdAt: 10_000,
    startedAt: 10_000,
    endedAt: null,
    ...overrides,
  };
}

export function workEvent(id: number, event: WorkEvent, overrides: Partial<Omit<StoredWorkEvent, "event">> = {}): StoredWorkEvent {
  return { id, ticket: 1, attempt: 1, seq: id, at: 10_000 + id, event, ...overrides };
}

export function ticket(id: number, overrides: Partial<Ticket> = {}): Ticket {
  const repository = "novan-xu/super-agent-sandbox";
  const finished = overrides.state !== undefined && finishedTicketStates.includes(overrides.state);
  const title = { en: `Work ${id}`, zh: `工作 ${id}` };
  const summary = { en: "Do it", zh: "做这件事" };
  return {
    id,
    code: String.fromCharCode(97 + Math.floor((id - 1) / 26), 97 + (id - 1) % 26),
    codeDate: "2026-11-19",
    form: "code",
    repository,
    issues: [{ repository, number: id, url: `https://github.com/${repository}/issues/${id}`, title, summary }],
    title,
    summary,
    kind: "feature",
    difficulty: null,
    difficultyReason: null,
    platform: null,
    requiredMachine: null,
    commitRef: null,
    commit: null,
    deploys: false,
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
    pullRequests: [],
    decisions: [],
    round: 0,
    freeRetry: false,
    stuck: null,
    waitsFor: [],
    waits: [],
    deployedAt: null,
    beginFailure: null,
    report: null,
    work: null,
    verification: null,
    stopReason: null,
    joinedInto: null,
    repairs: null,
    repairedBy: null,
    conversation: null,
    createdAt: id * 1000,
    updatedAt: id * 1000,
    endedAt: finished ? (overrides.updatedAt ?? id * 1000) : null,
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
      target: "studio",
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

export function stuckTicket(id: number, overrides: Partial<NonNullable<Ticket["stuck"]>> = {}): Ticket {
  return ticket(id, {
    state: "stuck",
    round: 3,
    branch: `sa2/ticket-${id}-beef`,
    stuck: { at: 40_000, round: 3, from: "verifying", failure: { kind: "workflow", detail: "Pipeline #9 on abc1234 failed: workflow check, step test (exit code 1)" }, where: null, ...overrides },
  });
}

export function stuckCard(id: number, overrides: Partial<NonNullable<Ticket["stuck"]>> = {}, guidance: { readonly en: string; readonly zh: string } | null = { en: "Return hello", zh: "让 greet 返回 hello" }): WaitingCard {
  return { kind: "stuck", key: `stuck:${id}-40000`, at: 40_000, ticket: stuckTicket(id, overrides), guidance };
}

export function settingsSnapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    machines: [],
    canAdd: { cloudflare: true, release: true },
    repositories: [],
    accounts: [
      { account: "novan-xu", configured: true },
      { account: "nuofan-island", configured: false },
    ],
    brain: { linked: true, order: ["gpt", "claude", "deepseek"], providers: [] },
    table: startingEngineTable,
    subscriptions: [],
    unavailable: [],
    devices: [],
    ...overrides,
  };
}
