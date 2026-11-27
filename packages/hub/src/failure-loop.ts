import { ticketReference } from "@super-agent2/protocol";
import { text } from "@super-agent2/catalog";
import {
  capReached,
  type GeneratedText,
  type GuidanceRefusal,
  guidanceRefusal,
  isMachineFailure,
  type LoopFailure,
  loopFailureOf,
  nextRound,
  roundCap,
  type StuckAnswerRequest,
  type StuckCard,
  stuckCardKey,
  type Ticket,
  type TicketRound,
} from "@super-agent2/protocol";
import type { AccessVerifier, OwnerProof } from "./access.js";
import type { Tell } from "./chains.js";
import { chainProgress, decisionReport, loopFailureWords as failureWords, repairReport, tail } from "./reports.js";
import { TicketError, type TicketService } from "./tickets.js";
import type { TicketTurn } from "./ticket-versions.js";
import type { VerificationService } from "./verification.js";
import type { WorkService } from "./work.js";

export interface FailureReport {
  readonly ticket: number;
  readonly failure: LoopFailure;
  readonly evidence: string;
}

export type LoopOutcome = { readonly ok: true; readonly ticket: Ticket; readonly round?: TicketRound | undefined } | { readonly ok: false; readonly reason: string };

export type StuckAnswerError = "forbidden" | "not_found" | "conflict";

export type StuckAnswerOutcome = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly error: StuckAnswerError };

export interface OwnerStuckAnswer {
  readonly assertion: OwnerProof;
  readonly ticket: number;
  readonly request: StuckAnswerRequest;
}

export interface FailureLoop {
  failed(report: FailureReport): void;
  guide(ticket: number, guidance: GeneratedText, turn?: TicketTurn): LoopOutcome;
  describe(ticket: number, where: GeneratedText, turn?: TicketTurn): LoopOutcome;
  answer(given: OwnerStuckAnswer): Promise<StuckAnswerOutcome>;
  ownerStopped(ticket: Ticket): void;
  cards(): StuckCard[];
  close(): void;
}

export interface FailureLoopOptions {
  readonly tickets: TicketService;
  readonly work: () => WorkService | undefined;
  readonly verification?: () => VerificationService | undefined;
  readonly tell?: Tell;
  readonly verify: AccessVerifier;
  readonly ownerEmail: string;
}

export { failureWords };

export const refusalWords: Readonly<Record<GuidanceRefusal, string>> = {
  closed: "it is not working or verifying, so it has no failure to guide",
  stuck: "it is stopped for the owner, and only the owner's answer on its card in 等你 can resume it",
  running: "its worker is still running; send it a message with message_worker instead",
  "nothing-failed": "nothing has failed: a guided round answers a failure the hub reported",
  cap: `it has had ${roundCap} guided rounds without passing, the cap; only the owner can give it more`,
};

export const ownerResumedReason = { en: "The owner resumed it; its guided rounds count from zero again", zh: text("ticket.reason.resumed") };

export const ownerGaveUpReason = { en: "The owner gave it up after its guided rounds reached the cap", zh: text("ticket.reason.gaveUp") };

const everyTicket = 100_000;

const retryAdvice = [
  "Find the decisive error. Use read_ticket and inspect the code if the evidence is unclear.",
  "In guide_ticket, quote the key error, explain its cause and give the worker a concrete change and a command to check it, in English with a Chinese copy.",
  "For an external failure, explain it and retry the same work. If a failure repeats, look for a different cause.",
  "Leave the fix to the worker and keep the checks intact. Record a decision if your advice changes the scope or approach.",
];

function described(ticket: Ticket): string {
  return `ticket ${ticketReference(ticket)} (${ticket.title.en})`;
}

export function workerNote(ticket: Ticket, failure: LoopFailure, guidance: GeneratedText, counted: boolean, round: number): string {
  const head = counted
    ? `Guided round ${round} of ${roundCap}.`
    : "A retry after a failure of the machine, not counted as a guided round.";
  const back =
    ticket.form === "task"
      ? "Start again from what is in your folders, and hand back as before."
      : `Continue on the same branch ${ticket.branch ?? ""}, from what is already there; push your changes and hand back${ticket.pullRequest === null ? "" : ` the same pull request #${ticket.pullRequest}`} as before.`;
  return [head, `The last attempt failed: ${failureWords[failure.kind]}.`, failure.detail === "" ? "" : `What the hub recorded: ${failure.detail}`, "The brain's guidance:", guidance.en, back]
    .filter((line) => line !== "")
    .join("\n");
}

export function createFailureLoop(options: FailureLoopOptions): FailureLoop {
  const { tickets } = options;
  const tell: Tell = options.tell ?? (() => undefined);
  const owner = options.ownerEmail.toLowerCase();
  let closed = false;

  const isOwner = async (assertion: OwnerProof): Promise<boolean> => {
    try {
      const result = await options.verify(assertion);
      return result.ok && result.identity.kind === "person" && result.identity.email === owner;
    } catch {
      return false;
    }
  };

  const evidenceOf = (ticket: Ticket, failure: LoopFailure): string => {
    if (failure.kind === "workflow" || failure.kind === "check") {
      const logs = options.verification?.()?.logs(ticket.id) ?? [];
      return logs.flatMap((log) => [failure.kind === "check" ? "The repository check output ends with:" : `The log of workflow ${log.workflow}, step ${log.step}, ends with:`, tail(log.log || "(empty)", 8_000)]).join("\n");
    }
    const output = options.work()?.output(ticket.id, 8_000) ?? "";
    return output === "" ? "" : `The worker's output ends with:\n${output}`;
  };

  const stick = (ticket: Ticket, report: FailureReport) => {
    let stuck: Ticket;
    try {
      stuck = tickets.change((writes) => writes.stick(ticket.id, report.failure));
    } catch (error) {
      if (error instanceof TicketError) {
        return;
      }
      throw error;
    }
    tell(
      stuck.id,
      text("notice.ticketStuck", { ticket: stuck.code, round: stuck.round }),
      [
        `[hub] ${described(stuck)} failed again after ${stuck.round} guided rounds, the cap of ${roundCap}: ${failureWords[report.failure.kind]}.`,
        report.evidence,
        `The hub stopped it for the owner. Its branch, its pull request and the worker's output are kept, nothing runs for it, and no round can start: guide_ticket refuses it. The owner decides on its card in 等你, where they can resume it with a fresh count, or give it up, which stops it and opens a repair ticket that continues the work.`,
        ...chainProgress(stuck),
        "Use read_ticket if you need the round history. Call describe_stuck once in English and Chinese with the goal, recurring failure, each round's attempt and your recommendation. Write it so a repair worker can pick up the work. Tell the owner briefly in Chinese that it waits for their decision.",
        ...decisionReport(stuck),
      ].join("\n"),
    );
  };

  const failed = (report: FailureReport) => {
    if (closed) {
      return;
    }
    const ticket = tickets.get(report.ticket);
    if (ticket === undefined || (ticket.state !== "working" && ticket.state !== "verifying")) {
      return;
    }
    if (capReached(ticket.round, report.failure.kind, ticket.freeRetry)) {
      if (ticket.light !== undefined) {
        tickets.stop(ticket.id, { en: `Light task failed after its guided rounds: ${report.failure.detail}`, zh: text("notice.lightTaskFailed") });
      } else {
        stick(ticket, report);
      }
      return;
    }
    const next = nextRound(ticket, report.failure);
    const counting = next.counted
      ? `Guided rounds so far: ${ticket.round} of ${roundCap}. Your guidance starts round ${next.round}${next.round === roundCap ? ", the last: if it fails too, the hub stops the ticket for the owner" : ""}.`
      : `This failure is the machine's, not the worker's, so your guidance starts a retry that is not counted as a guided round (still ${ticket.round} of ${roundCap}). A second failure of the machine in a row is counted.`;
    const verifying = report.failure.kind === "workflow" || report.failure.kind === "check";
    const providerBlock = report.failure.kind === "program"
      ? ["The hub handles temporary provider unavailability separately. If no machine offers a compatible provider, guide only if you can identify what to change. Otherwise report the blocker for a visible ticket."]
      : [];
    tell(
      ticket.id,
      text(verifying ? "notice.verificationFailed" : "notice.workerFailed", { ticket: ticket.code }),
      [
        `[hub] ${described(ticket)} failed: ${failureWords[report.failure.kind]}.`,
        report.evidence,
        counting,
        ...providerBlock,
        ...retryAdvice,
        ticket.light === undefined
          ? "Use stop_ticket only if the work cannot be done. Tell the owner briefly in Chinese what failed and what you told the worker."
          : "Handle this light-task retry internally. The hub reports terminal failure in the conversation.",
      ].join("\n"),
    );
  };

  const guide = (id: number, guidance: GeneratedText, turn?: TicketTurn): LoopOutcome => {
    const ticket = tickets.get(id);
    if (ticket === undefined) {
      return { ok: false, reason: `There is no ticket ${tickets.reference(id) ?? "(unavailable)"}.` };
    }
    const refusal = guidanceRefusal(ticket);
    if (refusal !== null) {
      return { ok: false, reason: `Ticket ${ticketReference(ticket)} cannot have a guided round: ${refusalWords[refusal]}.` };
    }
    const failure = loopFailureOf(ticket);
    const work = options.work();
    if (failure === null || work === undefined) {
      return { ok: false, reason: `Ticket ${ticketReference(ticket)} cannot have a guided round: ${refusalWords["nothing-failed"]}.` };
    }
    const next = nextRound(ticket, failure);
    const reason = next.counted
      ? { en: `Back to its worker for guided round ${next.round}`, zh: text("timeline.round", { round: next.round }) }
      : { en: "Back to its worker for a retry not counted as a round", zh: text("timeline.retry") };
    const outcome = work.again(id, workerNote(ticket, failure, guidance, next.counted, next.round), reason, { guidance, failure }, turn);
    if (!outcome.ok) {
      return outcome;
    }
    return { ok: true, ticket: outcome.ticket, round: tickets.rounds(id).at(-1) };
  };

  const describe = (id: number, where: GeneratedText, turn?: TicketTurn): LoopOutcome => {
    try {
      const ticket = tickets.change((writes) => writes.describeStuck(id, where), turn);
      return { ok: true, ticket };
    } catch (error) {
      if (error instanceof TicketError) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
  };

  const answer = async (given: OwnerStuckAnswer): Promise<StuckAnswerOutcome> => {
    if (!(await isOwner(given.assertion))) {
      return { ok: false, error: "forbidden" };
    }
    const ticket = tickets.get(given.ticket);
    if (ticket === undefined) {
      return { ok: false, error: "not_found" };
    }
    if (closed || ticket.state !== "stuck" || ticket.stuck === null || ticket.stuck.at !== given.request.at) {
      return { ok: false, error: "conflict" };
    }
    const stuck = ticket.stuck;
    const words = given.request.words?.trim() ?? "";
    if (given.request.answer === "give-up") {
      const gave = tickets.giveUp(ticket.id, ownerGaveUpReason, words);
      if (!gave.ok) {
        return { ok: false, error: gave.error === "not_found" ? "not_found" : "conflict" };
      }
      const ended = gave.ticket;
      const repair = gave.repair;
      tell(
        ended.id,
        repair === null ? text("notice.ownerGaveUpEnded", { ticket: ticket.code }) : text("notice.ownerGaveUp", { ticket: ticket.code, repair: repair.code }),
        [
          `[hub] The owner gave up ${described(ticket)} on its card, after ${stuck.round} guided rounds. It is stopped, and nothing of it is destroyed: its branch and any pull request stay on GitHub, and its folder is kept for the repair and saved to the branch where its machine can.`,
          ...chainProgress(ended),
          ...(repair === null ? ["No work remained, so no repair ticket was opened."] : repairReport(ended, repair, gave.followers, true)),
          words === "" ? "The owner gave no words." : `The owner's words, which the repair's worker is given as well: ${words}`,
          `It was stuck on: ${failureWords[stuck.failure.kind]}${stuck.failure.detail === "" ? "" : ` (${stuck.failure.detail})`}.`,
          ...decisionReport(ended),
        ].join("\n"),
      );
      return { ok: true, ticket: ended };
    }
    let resumed: Ticket;
    try {
      resumed = tickets.change((writes) => {
        const current = writes.get(ticket.id);
        if (current?.state !== "stuck" || current.stuck?.at !== given.request.at) {
          throw new TicketError(`Ticket ${ticketReference(ticket)} changed meanwhile`);
        }
        return writes.resume(ticket.id, ownerResumedReason);
      });
    } catch (error) {
      if (error instanceof TicketError) {
        return { ok: false, error: "conflict" };
      }
      throw error;
    }
    const evidence = evidenceOf(resumed, stuck.failure);
    tell(
      resumed.id,
      words === "" ? text("notice.ownerResumed", { ticket: resumed.code }) : text("notice.ownerResumedWords", { ticket: resumed.code, words }),
      [
        `[hub] The owner resumed ${described(resumed)} on its card. Its guided rounds count from 0 of ${roundCap} again. It is ${resumed.state} again with the failure it stopped on, and nothing runs for it yet.`,
        words === "" ? "The owner gave no words." : `The owner's words to you: ${words}`,
        `The failure it stopped on: ${failureWords[stuck.failure.kind]}${stuck.failure.detail === "" ? "" : `: ${stuck.failure.detail}`}`,
        ...(evidence === "" ? [] : [evidence]),
        ...retryAdvice,
        `Now call guide_ticket with your guidance to the worker, taking the owner's words into account; it starts round 1 of the new count${isMachineFailure(stuck.failure.kind) ? ", or a retry that is not counted, since the failure was the machine's" : ""}. Tell the owner in Chinese what you told the worker.`,
      ].join("\n"),
    );
    return { ok: true, ticket: resumed };
  };

  const ownerStopped = (ticket: Ticket) => {
    const merged = ticket.repository !== null && ticket.pullRequests.some((pull) => pull.state === "merged");
    if (closed || ticket.light !== undefined || (!merged && ticket.decisions.length === 0)) {
      return;
    }
    tell(
      ticket.id,
      text(merged ? "notice.ownerStoppedChain" : "notice.ownerStopped", { ticket: ticket.code }),
      [
        merged
          ? `[hub] The owner stopped ${described(ticket)}. Its worker's folder is removed; its branch and any open pull request stay on GitHub, and nothing more of the chain is done unless the owner asks for it to go on: then open a repair ticket for it with open_repair_ticket.`
          : `[hub] The owner stopped ${described(ticket)}. Its worker's folder is removed, and nothing more of it is done.`,
        ...chainProgress(ticket),
        merged
          ? "Tell the owner in Chinese, in a line or two, what is merged and what is not. If what is merged needs deploying and no deployment ticket is arranged, read deployment.md. If a registered machine of this installation can run the deployment and the owner has not deferred, grouped or declined it, open a task ticket at the last merge commit with open_task_ticket. The owner starts it."
          : "Acknowledge it to the owner in Chinese in a line.",
        ...decisionReport(ticket),
      ].join("\n"),
    );
  };

  const cards = (): StuckCard[] =>
    tickets
      .list({ open: true, limit: everyTicket })
      .flatMap((ticket) => {
        if (ticket.light !== undefined || ticket.state !== "stuck" || ticket.stuck === null) {
          return [];
        }
        const last = tickets.rounds(ticket.id).at(-1);
        return [{ kind: "stuck" as const, key: stuckCardKey(ticket.id, ticket.stuck.at), at: ticket.stuck.at, ticket, guidance: last?.guidance ?? null }];
      });

  return {
    failed,
    guide,
    describe,
    answer,
    ownerStopped,
    cards,
    close: () => {
      closed = true;
    },
  };
}
