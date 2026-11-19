import type { Ticket } from "@super-agent2/protocol";

export const rearrangePrefix = "[hub] The owner pressed Rearrange.";

export function rearrangePrompt(repository: string | null | undefined, tickets: readonly Ticket[]): string {
  const scope = repository === undefined ? "all repositories and daily work" : repository === null ? "daily work (no repository)" : `repository ${JSON.stringify(repository)}`;
  const matching = tickets.filter((ticket) => repository === undefined || (ticket.repository?.toLowerCase() ?? null) === (repository?.toLowerCase() ?? null));
  const snapshot = matching.map((ticket) => ({ id: ticket.id, state: ticket.state, form: ticket.form, kind: ticket.kind, repository: ticket.repository, issues: ticket.issues, after: ticket.waitsFor }));
  return `${rearrangePrefix}\nReview every open ticket in scope: ${scope}. This snapshot may have changed; use list_tickets and read_ticket to check the latest state and dependencies before acting.\n${JSON.stringify(snapshot)}\nLook for redundant steps, including multiple deployments of the same repository that one deployment after all relevant chains could cover; chains that should be one, needless cuts, wrong order, and missing dependencies. Rearrange pending chains with arrange_chains and restate defaults with choose_defaults when arrangements change. Stop redundant tickets that have started but are not running with stop_ticket, ensuring the remaining work still covers all relevant chains. Never touch a ticket whose worker is running. Never start anything; only the owner starts work. Record each change with record_decision. Reply in Chinese with a short list of changes and reasons, or say that nothing needed changing.`;
}
