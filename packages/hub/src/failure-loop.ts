import { text } from "@super-agent2/catalog";
import {
  capReached,
  type GeneratedText,
  type GuidanceRefusal,
  guidanceRefusal,
  isMachineFailure,
  type LoopFailure,
  type LoopFailureKind,
  loopFailureOf,
  nextRound,
  roundCap,
  type StuckAnswerRequest,
  type StuckCard,
  stuckCardKey,
  type Ticket,
  type TicketRound,
} from "@super-agent2/protocol";
import type { AccessVerifier } from "./access.js";
import type { Tell } from "./chains.js";
import { chainProgress, tail } from "./reports.js";
import { TicketError, type TicketService } from "./tickets.js";
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
  readonly assertion: string | undefined;
  readonly ticket: number;
  readonly request: StuckAnswerRequest;
}

export interface FailureLoop {
  failed(report: FailureReport): void;
  guide(ticket: number, guidance: GeneratedText): LoopOutcome;
  describe(ticket: number, where: GeneratedText): LoopOutcome;
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

export const failureWords: Readonly<Record<LoopFailureKind, string>> = {
  workflow: "a Woodpecker workflow on its pull request's head is red",
  conflict: "its pull request still conflicts with the base branch after the worker had it back",
  "no-pull-request": "the worker ended without handing back a valid result",
  program: "the worker's program failed (it exited, refused, or ran out of allowance)",
  lost: "the worker was lost: its machine came back without it",
  prepare: "the worker's folder could not be prepared",
};

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

function described(ticket: Ticket): string {
  return `ticket ${ticket.id} (${ticket.title.en})`;
}

export function workerNote(ticket: Ticket, failure: LoopFailure, guidance: GeneratedText, counted: boolean, round: number): string {
  const head = counted
    ? `Guided round ${round} of ${roundCap}.`
    : "A retry after a failure of the machine, not counted as a guided round.";
  const back =
    ticket.kind === "writing"
      ? "Start again from what is in this folder, and hand back as before."
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

  const isOwner = async (assertion: string | undefined): Promise<boolean> => {
    try {
      const result = await options.verify(assertion);
      return result.ok && result.identity.kind === "person" && result.identity.email === owner;
    } catch {
      return false;
    }
  };

  const evidenceOf = (ticket: Ticket, failure: LoopFailure): string => {
    if (failure.kind === "workflow") {
      const logs = options.verification?.()?.logs(ticket.id) ?? [];
      return logs.flatMap((log) => [`The log of workflow ${log.workflow}, step ${log.step}, ends with:`, tail(log.log || "(empty)", 8_000)]).join("\n");
    }
    if (failure.kind === "conflict") {
      return "";
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
      stuck.conversation,
      text("notice.ticketStuck", { ticket: stuck.id, round: stuck.round }),
      [
        `[hub] ${described(stuck)} failed again after ${stuck.round} guided rounds, the cap of ${roundCap}: ${failureWords[report.failure.kind]}.`,
        report.evidence,
        `The hub stopped it for the owner. Its branch, its pull request and the worker's output are kept, nothing runs for it, and no round can start: guide_ticket refuses it. The owner decides on its card in 等你, where they can resume it with a fresh count or give it up.`,
        ...chainProgress(stuck),
        "Now call describe_stuck once with where it is stuck, in English with a Chinese copy, in a few sentences: what the work is, what keeps failing, what each round tried, and what you think the owner should decide. The owner reads the Chinese on the card. Then tell the owner in Chinese, in a line or two, that it waits for them.",
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
      stick(ticket, report);
      return;
    }
    const next = nextRound(ticket, report.failure);
    const counting = next.counted
      ? `Guided rounds so far: ${ticket.round} of ${roundCap}. Your guidance starts round ${next.round}${next.round === roundCap ? ", the last: if it fails too, the hub stops the ticket for the owner" : ""}.`
      : `This failure is the machine's, not the worker's, so your guidance starts a retry that is not counted as a guided round (still ${ticket.round} of ${roundCap}). A second failure of the machine in a row is counted.`;
    const verifying = report.failure.kind === "workflow" || report.failure.kind === "conflict";
    tell(
      ticket.conversation,
      text(verifying ? "notice.verificationFailed" : "notice.workerFailed", { ticket: ticket.id }),
      [
        `[hub] ${described(ticket)} failed: ${failureWords[report.failure.kind]}.`,
        report.evidence,
        counting,
        "Read the failure, then call guide_ticket with your guidance to the worker: what failed and why, and what to change. The worker tries again on the same branch. Do not do the worker's work yourself. Stop it with stop_ticket only if it cannot be done. Tell the owner in Chinese, in a line or two, what failed and what you told the worker.",
      ].join("\n"),
    );
  };

  const guide = (id: number, guidance: GeneratedText): LoopOutcome => {
    const ticket = tickets.get(id);
    if (ticket === undefined) {
      return { ok: false, reason: `There is no ticket ${id}.` };
    }
    const refusal = guidanceRefusal(ticket);
    if (refusal !== null) {
      return { ok: false, reason: `Ticket ${id} cannot have a guided round: ${refusalWords[refusal]}.` };
    }
    const failure = loopFailureOf(ticket);
    const work = options.work();
    if (failure === null || work === undefined) {
      return { ok: false, reason: `Ticket ${id} cannot have a guided round: ${refusalWords["nothing-failed"]}.` };
    }
    const next = nextRound(ticket, failure);
    const reason = next.counted
      ? { en: `Back to its worker for guided round ${next.round}`, zh: text("timeline.round", { round: next.round }) }
      : { en: "Back to its worker for a retry not counted as a round", zh: text("timeline.retry") };
    const outcome = work.again(id, workerNote(ticket, failure, guidance, next.counted, next.round), reason, { guidance, failure });
    if (!outcome.ok) {
      return outcome;
    }
    return { ok: true, ticket: outcome.ticket, round: tickets.rounds(id).at(-1) };
  };

  const describe = (id: number, where: GeneratedText): LoopOutcome => {
    try {
      const ticket = tickets.change((writes) => writes.describeStuck(id, where));
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
      const stopped = tickets.stop(ticket.id, ownerGaveUpReason);
      if (!stopped.ok) {
        return { ok: false, error: stopped.error === "not_found" ? "not_found" : "conflict" };
      }
      tell(
        stopped.ticket.conversation,
        text("notice.ownerGaveUp", { ticket: ticket.id }),
        [
          `[hub] The owner gave up ${described(ticket)} on its card, after ${stuck.round} guided rounds. It is stopped: its worker's folder is removed; the branch and any pull request stay on GitHub.`,
          ...chainProgress(stopped.ticket),
          words === "" ? "The owner gave no words." : `The owner's words to you: ${words}`,
          "Acknowledge it to the owner in Chinese in a line.",
        ].join("\n"),
      );
      return { ok: true, ticket: stopped.ticket };
    }
    let resumed: Ticket;
    try {
      resumed = tickets.change((writes) => {
        const current = writes.get(ticket.id);
        if (current?.state !== "stuck" || current.stuck?.at !== given.request.at) {
          throw new TicketError(`Ticket ${ticket.id} changed meanwhile`);
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
      resumed.conversation,
      words === "" ? text("notice.ownerResumed", { ticket: resumed.id }) : text("notice.ownerResumedWords", { ticket: resumed.id, words }),
      [
        `[hub] The owner resumed ${described(resumed)} on its card. Its guided rounds count from 0 of ${roundCap} again. It is ${resumed.state} again with the failure it stopped on, and nothing runs for it yet.`,
        words === "" ? "The owner gave no words." : `The owner's words to you: ${words}`,
        `The failure it stopped on: ${failureWords[stuck.failure.kind]}${stuck.failure.detail === "" ? "" : `: ${stuck.failure.detail}`}`,
        ...(evidence === "" ? [] : [evidence]),
        `Now call guide_ticket with your guidance to the worker, taking the owner's words into account; it starts round 1 of the new count${isMachineFailure(stuck.failure.kind) ? ", or a retry that is not counted, since the failure was the machine's" : ""}. Tell the owner in Chinese what you told the worker.`,
      ].join("\n"),
    );
    return { ok: true, ticket: resumed };
  };

  const ownerStopped = (ticket: Ticket) => {
    if (closed || ticket.repository === null || !ticket.pullRequests.some((pull) => pull.state === "merged")) {
      return;
    }
    tell(
      ticket.conversation,
      text("notice.ownerStoppedChain", { ticket: ticket.id }),
      [
        `[hub] The owner stopped ${described(ticket)}. Its worker's folder is removed; its branch and any open pull request stay on GitHub, and nothing more of the chain is done.`,
        ...chainProgress(ticket),
        "Tell the owner in Chinese, in a line or two, what is merged and what is not. If what is merged needs deploying, deploy it once with deploy_repository at the last merge commit, unless the owner said otherwise.",
      ].join("\n"),
    );
  };

  const cards = (): StuckCard[] =>
    tickets
      .list({ open: true, limit: everyTicket })
      .flatMap((ticket) => {
        if (ticket.state !== "stuck" || ticket.stuck === null) {
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
