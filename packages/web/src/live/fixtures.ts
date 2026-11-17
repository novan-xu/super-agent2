import type { WaitingCard } from "@super-agent2/protocol";

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
