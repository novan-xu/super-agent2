import { ticketReference } from "@super-agent2/protocol";
import { text } from "@super-agent2/catalog";
import { type DecisionReview, type Ticket, type TicketDecision, unsettledDecisions } from "@super-agent2/protocol";
import type { Tell } from "./chains.js";
import { decisionLine } from "./reports.js";
import { TicketError, type TicketService } from "./tickets.js";

export type ReviewError = "not_found" | "conflict";

export type ReviewOutcome = { readonly ok: true; readonly ticket: Ticket; readonly sent: readonly TicketDecision[] } | { readonly ok: false; readonly error: ReviewError };

export interface DecisionReviews {
  review(ticket: number, decision: number, review: DecisionReview): ReviewOutcome;
}

export interface DecisionReviewsOptions {
  readonly tickets: TicketService;
  readonly tell?: Tell;
}

function described(ticket: Ticket): string {
  return `ticket ${ticketReference(ticket)} (${ticket.title.en})`;
}

export function reviewPrompt(ticket: Ticket, batch: readonly TicketDecision[]): string {
  const opinions = batch.filter((decision) => decision.verdict === "opinion");
  const accepted = batch.filter((decision) => decision.verdict === "ok");
  return [
    `[hub] The owner went through the decisions recorded on ${described(ticket)}, which is ${ticket.state}, and disagrees with ${opinions.length} of them. Each opinion below means the owner does not agree with that decision; the owner's words are as written.`,
    ...opinions.flatMap((decision, index) => [`${index + 1}. ${decisionLine(decision, false)}`, `   The owner's opinion: ${decision.opinion ?? ""}`]),
    ...(accepted.length === 0 ? [] : [`Accepted as they were: ${accepted.map((decision) => `decision ${decision.id}`).join(", ")}.`]),
    "Decide what to do with the opinions. Group them into follow-up work as you see fit: one issue may cover several opinions, an opinion may need several issues, and one that needs no change may need only an answer. Write follow-up issues as plans, as for any need; where the goal or the scope of a fix is unclear, talk with the owner first, one short question at a time, before filing. Tell the owner in Chinese, briefly, what you will do with each opinion.",
  ].join("\n");
}

export function createDecisionReviews(options: DecisionReviewsOptions): DecisionReviews {
  const { tickets } = options;
  const tell: Tell = options.tell ?? (() => undefined);
  return {
    review: (id, decision, review) => {
      const before = tickets.get(id);
      const found = before?.decisions.find((entry) => entry.id === decision);
      if (before === undefined || found === undefined) {
        return { ok: false, error: "not_found" };
      }
      if (found.verdict !== null) {
        return { ok: false, error: "conflict" };
      }
      let batch: TicketDecision[] = [];
      let ticket: Ticket;
      try {
        ticket = tickets.change((writes) => {
          writes.settleDecision(id, decision, review);
          const settled = writes.get(id);
          if (settled === undefined || unsettledDecisions(settled.decisions).length > 0) {
            return settled ?? before;
          }
          batch = settled.decisions.filter((entry) => entry.sentAt === null);
          if (batch.length > 0) {
            writes.sentDecisions(id, batch.map((entry) => entry.id));
          }
          return writes.get(id) ?? settled;
        });
      } catch (error) {
        if (error instanceof TicketError) {
          return { ok: false, error: "conflict" };
        }
        throw error;
      }
      const opinions = batch.filter((entry) => entry.verdict === "opinion");
      if (opinions.length > 0) {
        tell(ticket.id, text("notice.decisionsReviewed", { ticket: ticket.code, count: opinions.length }), reviewPrompt(ticket, batch));
      }
      return { ok: true, ticket, sent: batch };
    },
  };
}
