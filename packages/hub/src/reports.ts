import { ticketProject, ticketReference } from "@super-agent2/protocol";
import { type CommandRecord, deploymentFile, type LoopFailureKind, type MachineChoice, mergedIssueNumbers, openIssueNumbers, openPullRequest, type ProviderUnavailable, type StartChoice, type Subscription, type Subscriptions, type Ticket, type TicketDecision, type TicketMove, type TicketWait } from "@super-agent2/protocol";
import { durationWords, overrunFactor } from "./pipeline-times.js";
import type { WaitedFor } from "./verification.js";

export const reportLimit = 40_000;

export function clip(text: string, limit: number = reportLimit): string {
  if (text.length <= limit) {
    return text;
  }
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - tail)}`;
}

export const loopFailureWords: Readonly<Record<LoopFailureKind, string>> = {
  workflow: "a Woodpecker workflow on its pull request's head is red",
  "no-pull-request": "the worker ended without handing back a valid result",
  program: "the worker's program failed (it exited, crashed, reported an error, or no other provider could take over from one that was unavailable)",
  lost: "the worker was lost: its machine came back without it",
  prepare: "the worker's folder could not be prepared",
  "task-failed": "the worker handed back that its task failed",
};

export function waitedLine(waited: WaitedFor): string {
  const usual =
    waited.usual === null
      ? `there is no usual time for this repository yet (${waited.samples} green pipeline${waited.samples === 1 ? "" : "s"} recorded), so the first-time allowance applies`
      : `usual for this repository: ${durationWords(waited.usual)}, the median of its last ${waited.samples} green pipelines`;
  const when = waited.usual === null ? "the allowance" : `${overrunFactor} times the usual`;
  return `Waiting on the pipeline for ${durationWords(waited.waited)}; ${usual}. You are told at ${durationWords(waited.threshold)} (${when}) and again at each doubling. The time decides nothing: the ticket stays verifying.`;
}

export function tail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const kept = text.slice(text.length - limit);
  return `[the first ${text.length - limit} of ${text.length} characters are cut; this is the end, where the failure is]\n${kept}`;
}

export function commandSummary(command: CommandRecord): string {
  const parts = [`Command ${command.id} on target ${command.target} (account ${command.account}) is ${command.state}`];
  if (command.exitCode !== null) {
    parts.push(`with exit code ${command.exitCode}`);
  }
  if (command.signal !== null) {
    parts.push(`after signal ${command.signal}`);
  }
  return `${parts.join(" ")}.`;
}

export function commandReport(command: CommandRecord, output: string): string {
  const lines = [commandSummary(command), `Command: ${command.command}`];
  if (command.cwd !== null) {
    lines.push(`Folder: ${command.cwd}`);
  }
  if (command.reason !== null) {
    lines.push(`Reason: ${command.reason}`);
  }
  lines.push(output === "" ? "Output: (none)" : `Output:\n${clip(output)}`);
  return lines.join("\n");
}

function chosen(value: string | number | null): string {
  return value === null ? "not set" : String(value);
}

function waitText(wait: TicketWait): string {
  const what = `ticket ${wait.reference ?? "(unavailable)"}${wait.deployment ? " to be merged and deployed" : " to be merged"}`;
  return wait.waived ? `${what} (waived)` : what;
}

function numbers(list: readonly number[]): string {
  return list.map((number) => `#${number}`).join(", ");
}

export function repairWords(ticket: Pick<Ticket, "repairsReference" | "repairedByReference">): string {
  return [ticket.repairsReference === undefined ? "" : `repair of ticket ${ticket.repairsReference}`, ticket.repairedByReference === undefined ? "" : `repaired by ticket ${ticket.repairedByReference}`].filter((part) => part !== "").join(", ");
}

export function repairLines(ticket: Ticket, get: (id: number) => Ticket | undefined): string[] {
  const lines: string[] = [];
  if (ticket.repairs !== null) {
    const before = get(ticket.repairs);
    lines.push(
      `This is a repair ticket: it carries on the work of ticket ${ticket.repairsReference ?? "(unavailable)"}${before === undefined ? "" : ` (${before.state})`}${ticket.form === "code" ? `, on branch ${ticket.branch ?? "(none)"}, with the issues that were still open` : ", the same task"}. Its worker was given what the earlier workers did and what failed.`,
    );
  }
  if (ticket.repairedBy !== null) {
    const after = get(ticket.repairedBy);
    lines.push(`Its work goes on in repair ticket ${ticket.repairedByReference ?? "(unavailable)"}${after === undefined ? "" : ` (${after.state})`}; what waited for it waits for that ticket.`);
  }
  return lines;
}

export function ticketLine(ticket: Ticket): string {
  const where = ticketProject(ticket) ?? "no repository";
  const merged = new Set(mergedIssueNumbers(ticket));
  const closedOutside = new Set(ticket.closedOutside?.map((issue) => issue.number));
  const issues = ticket.issues.map((issue) => `#${issue.number}${merged.has(issue.number) ? " merged" : closedOutside.has(issue.number) ? " closed on GitHub" : ""}`).join(", ");
  const pulls = ticket.pullRequests.map((pull) => `#${pull.number} ${pull.state}`).join(", ");
  const task = ticket.form === "task" ? ` task${ticket.deploys ? " deploying" : ""}${ticket.commit === null ? (ticket.commitRef === null ? "" : ` at ${ticket.commitRef}`) : ` at ${ticket.commit.slice(0, 12)}`}` : "";
  const repair = repairWords(ticket);
  return `Ticket ${ticketReference(ticket)} [${ticket.state}] ${ticket.kind}${task} in ${where}${issues === "" ? "" : ` (issues ${issues}${pulls === "" ? "" : `; pull requests ${pulls}`})`}${repair === "" ? "" : ` [${repair}]`}: ${ticket.title.en}`;
}

export function ranWords(ticket: Ticket): string {
  const run = ticket.ran ?? (ticket.work === null ? null : { machine: ticket.work.machine, engine: ticket.work.engine, model: ticket.work.model, effort: ticket.work.effort });
  return run === null ? "no machine, as no worker ever ran for it" : `${run.machine} with ${run.engine} ${run.model} at ${run.effort}`;
}

export function repairReport(ended: Ticket, repair: Ticket, followers: readonly Ticket[], stateDefaults: boolean): string[] {
  const open = openPullRequest(ended.pullRequests);
  const remaining = openIssueNumbers(repair);
  return [
    `A repair ticket was opened for ticket ${ticketReference(ended)} in the same step: ticket ${ticketReference(repair)}. It is pending: the hub does not start it, and the owner starts it with 开始 on its card in 工作台, like any ticket.`,
    repair.form === "task"
      ? "It is the same task, in a new ticket, with the same material."
      : `It continues on branch ${repair.branch ?? "(none)"}${open === undefined ? "" : `, where pull request #${open.number} is open`}, and holds the issues still open: ${numbers(remaining)}. Its worker hands in that same pull request, or a new one if it sees fit. What is merged stays merged.`,
    `It keeps the kind (${repair.kind}), difficulty (${chosen(repair.difficulty)}), platform (${chosen(repair.platform)}) and repository (${repair.repository ?? "none"}) of ticket ${ticketReference(ended)}${repair.requiredMachine === null ? "" : `, and runs only on ${repair.requiredMachine}`}. Its worker is given the account of what was done and what failed (every guided round, your description of why it was stuck, the owner's words, the decisions recorded), and ticket ${ticketReference(ended)}'s folder is kept for it.`,
    followers.length === 0
      ? "No other ticket waited for it."
      : `What waited for ticket ${ticketReference(ended)} now waits for ticket ${ticketReference(repair)}: ${followers.map((follower) => `ticket ${ticketReference(follower)} (${follower.state})`).join(", ")}. The owner's 开始 on ticket ${ticketReference(repair)} starts those not yet started with it, and the ones already started begin once it has merged or is done.`,
    `Ticket ${ticketReference(ended)} ran on ${ranWords(ended)}.`,
    ...(stateDefaults
      ? [
          `Now call choose_defaults for ticket ${ticketReference(repair)}: kind ${repair.kind}${repair.issues.length === 0 ? "" : `, the difficulty of each of its issues (${numbers(remaining)})`}, its platform, a one-line reason and its engine (codex or claude) as for any ticket. It failed on the run above, so usually prefer a different provider, or a stronger model (a higher difficulty gives one), than that one, by what is left on each subscription; read_allowance shows it. Say in the reason, in one line, why you chose it: the owner reads that line on the card, beside the choice. Then tell the owner in Chinese, in a line or two, that a repair ticket waits for their 开始 and what you chose.`,
        ]
      : []),
  ];
}

export function chainProgress(ticket: Ticket): string[] {
  if (ticket.repository === null) {
    return [];
  }
  const merged = ticket.pullRequests.filter((pull) => pull.state === "merged");
  const open = openPullRequest(ticket.pullRequests);
  const remaining = openIssueNumbers(ticket);
  const last = merged.at(-1);
  const lines = [
    merged.length === 0
      ? "No pull request of this chain is merged."
      : `Pull requests merged, in order: ${merged.map((pull) => `#${pull.number} (closed ${pull.closes.length === 0 ? "no issue of the chain" : numbers(pull.closes)}${pull.mergeCommit === null ? "" : `, commit ${pull.mergeCommit}`})`).join("; ")}. The issues they closed stay closed.`,
    remaining.length === 0 ? "Every issue of the chain is closed." : `Still open: ${numbers(remaining)}${open === undefined ? "; no pull request is open for them" : `; open pull request: #${open.number} from ${open.branch}`}.`,
  ];
  if (last !== undefined && last.deployment !== null) {
    lines.push(
      last.deployment
        ? `Deployment: the repository has a deployment (${deploymentFile}), so what is merged needs deploying, through a task ticket that deploys it; the last merge commit is ${last.mergeCommit ?? "unknown"}, and it contains every earlier one.`
        : "Deployment: the repository has no deployment, so nothing needs deploying.",
    );
  }
  return lines;
}

function decisionWho(decision: TicketDecision): string {
  if (decision.source === "brain") {
    return "recorded by you, the brain";
  }
  return decision.pullRequest === null ? "recorded by the worker" : `recorded by the worker with pull request #${decision.pullRequest}`;
}

function reviewWords(decision: TicketDecision): string {
  if (decision.verdict === null) {
    return "Not reviewed by the owner yet.";
  }
  if (decision.verdict === "ok") {
    return "The owner reviewed it: OK.";
  }
  return `The owner reviewed it and disagrees; the owner's opinion, in their words: ${decision.opinion ?? ""}`;
}

export function decisionLine(decision: TicketDecision, review = true): string {
  return [
    `Decision ${decision.id} (${decisionWho(decision)}):`,
    `Chosen: ${decision.chosen.en}`,
    `Why: ${decision.why.en}`,
    `Other options: ${decision.otherOptions.en}`,
    ...(review ? [reviewWords(decision)] : []),
  ].join(" ");
}

export function decisionLines(ticket: Ticket): string[] {
  if (ticket.decisions.length === 0) {
    return ["Decisions made on the owner's behalf: none is recorded for this ticket."];
  }
  return [`Decisions made on the owner's behalf, as recorded for this ticket (${ticket.decisions.length}):`, ...ticket.decisions.map((decision, index) => `${index + 1}. ${decisionLine(decision)}`)];
}

export function decisionReport(ticket: Ticket): string[] {
  if (ticket.decisions.length === 0) {
    return decisionLines(ticket);
  }
  return [
    ...decisionLines(ticket),
    "Their Chinese copies, as recorded, in the same order:",
    ...ticket.decisions.map((decision, index) => `${index + 1}. ${decision.chosen.zh}；${decision.why.zh}`),
    "Report every one of these decisions to the owner in Chinese in your answer, briefly: what was chosen, and why. The owner reviews them on the ticket's page, where each shows with 可以 and a box for an opinion; nothing waits on that review, and you are told what the owner says once they have gone through them.",
  ];
}

export function ticketReport(ticket: Ticket, moves: readonly TicketMove[] = []): string {
  const lines = [
    ticketLine(ticket),
    `Chinese title: ${ticket.title.zh}`,
    `Summary: ${ticket.summary.en}`,
    `Chinese summary: ${ticket.summary.zh}`,
  ];
  if (ticket.issues.length > 0) {
    const merged = new Set(mergedIssueNumbers(ticket));
    const closedOutside = new Set(ticket.closedOutside?.map((issue) => issue.number));
    lines.push("Issues in working order:");
    for (const issue of ticket.issues) {
      lines.push(`  ${issue.repository}#${issue.number} ${issue.title.en} (${issue.url})${merged.has(issue.number) ? ", closed by a merged pull request" : closedOutside.has(issue.number) ? ", closed on GitHub without a pull request of this chain" : ""}`);
    }
  }
  if (ticket.pullRequests.length > 0) {
    lines.push("Pull requests, in the order handed in:");
    for (const pull of ticket.pullRequests) {
      lines.push(
        `  #${pull.number} ${pull.state} from ${pull.branch} (${pull.url})${pull.state === "merged" ? `, closed ${pull.closes.length === 0 ? "no issue of the chain" : numbers(pull.closes)}${pull.mergeCommit === null ? "" : `, commit ${pull.mergeCommit}`}` : pull.closes.length === 0 ? "" : `, to close ${numbers(pull.closes)}`}`,
      );
    }
  }
  lines.push(
    `Difficulty: ${chosen(ticket.difficulty)}; platform: ${chosen(ticket.platform)}${ticket.requiredMachine === null ? "" : `; it runs only on ${ticket.requiredMachine}, the machine its deployment file names`}`,
    `Difficulty reason: ${ticket.difficultyReason === null ? "not stated" : ticket.difficultyReason.en}; engine you chose: ${chosen(ticket.brainEngine)}`,
    `Machine: ${chosen(ticket.machine)}; engine: ${chosen(ticket.engine)}; model: ${chosen(ticket.model)}; effort: ${chosen(ticket.effort)}${
      ticket.chosenBy === null
        ? ""
        : ` (chosen by: machine ${ticket.chosenBy.machine}, engine ${ticket.chosenBy.engine}, model ${ticket.chosenBy.model}, effort ${ticket.chosenBy.effort})`
    }`,
    `Actually ran: ${ticket.ran === null ? "nothing yet" : `${ticket.ran.machine}, ${ticket.ran.engine}, ${ticket.ran.model}, ${ticket.ran.effort}`}`,
    `Branch: ${chosen(ticket.branch)}; pull request: ${ticket.pullRequest === null ? "none" : `#${ticket.pullRequest}`}; guided round: ${ticket.round}`,
    `Waits for: ${ticket.waits.length === 0 ? "nothing" : ticket.waits.map(waitText).join(", ")}`,
  );
  if (ticket.work !== null) {
    const work = ticket.work;
    const reach = work.unreachableSince === null ? "" : `; its machine has not been reachable since ${new Date(work.unreachableSince).toISOString()}`;
    const why = work.reason === null ? "" : `: ${work.failure === null ? "" : `${work.failure}, `}${work.reason}`;
    lines.push(`Worker: attempt ${work.attempt} on ${work.machine} with ${work.engine} ${work.model} ${work.effort} is ${work.state}${why}${reach}`);
  }
  if (ticket.report !== null) {
    lines.push(`Worker's report: ${ticket.report.en}`, `Chinese report: ${ticket.report.zh}`);
  }
  const verification = ticket.verification;
  if (verification !== null) {
    const parts = [
      `Verification: ${verification.state}${verification.waiting === null ? "" : ` (waiting: ${verification.waiting})`}`,
      `rule ${verification.rule ?? "not decided yet"}`,
      `change ${verification.level ?? "not read yet"}`,
      `head ${verification.head ?? "unknown"}`,
    ];
    if (verification.pipeline !== null) {
      parts.push(`pipeline ${verification.pipeline.url}`);
    }
    if (verification.workflows.length > 0) {
      parts.push(`workflows ${verification.workflows.map((workflow) => `${workflow.name} ${workflow.state}`).join(", ")}`);
    }
    if (verification.mergeCommit !== null) {
      parts.push(`merged as ${verification.mergeCommit}`);
    }
    if (verification.deployment !== null) {
      parts.push(verification.deployment ? "the repository has a deployment" : "the repository has no deployment");
    }
    if (verification.conflictReturns > 0) {
      parts.push(`went back to its worker for a conflict ${verification.conflictReturns} time${verification.conflictReturns === 1 ? "" : "s"}`);
    }
    lines.push(`${parts.join("; ")}${verification.reason === null ? "" : `. ${verification.reason}`}`);
  }
  if (ticket.deployedAt !== null) {
    lines.push(`Deployed: recorded at ${new Date(ticket.deployedAt).toISOString()}`);
  }
  if (ticket.startBlock != null) lines.push(`Cannot begin: ${ticket.startBlock.en}`);
  if (ticket.beginFailure !== null) {
    lines.push(`Its work could not begin: ${ticket.beginFailure}`);
  }
  if (ticket.stopReason !== null) {
    lines.push(`Stopped because: ${ticket.stopReason.en}`);
  }
  lines.push(...decisionLines(ticket));
  if (ticket.conversation !== null) {
    lines.push(`Filed in conversation ${ticket.conversation}`);
  }
  for (const move of moves) {
    const reason = move.reason === null ? "" : `: ${move.reason.en}`;
    lines.push(`  ${new Date(move.at).toISOString()} ${move.from ?? "filed"} -> ${move.to}${reason}`);
  }
  return lines.join("\n");
}

export function choiceText(choice: StartChoice): string {
  const what = `${chosen(choice.machine)}, ${chosen(choice.engine)}, ${chosen(choice.model)}, ${chosen(choice.effort)}`;
  if (choice.missing.length === 0) {
    return `It would run on ${what}.`;
  }
  const unavailable = choice.machine === null && choice.engine !== null && choice.model !== null && choice.effort !== null
    ? ` No online machine matching the platform offers ${choice.engine}, ${choice.model} at ${choice.effort}.`
    : "";
  return `It cannot start yet (missing: ${choice.missing.join(", ")}); so far: ${what}.${unavailable}`;
}

function subscriptionLine(name: string, subscription: Subscription): string {
  if (subscription.state === "unknown") {
    return `${name}: unknown (no current reading)`;
  }
  const left = subscription.remainingPercent === null ? "" : `, ${subscription.remainingPercent}% left`;
  const resets = subscription.resetsAt === null ? "" : `, resets ${new Date(subscription.resetsAt).toISOString()}`;
  const read = subscription.readAt === null ? "" : `, read ${new Date(subscription.readAt).toISOString()} on ${subscription.machine ?? "?"}`;
  return `${name}: ${subscription.state === "exhausted" ? "used up" : "available"}${left}${resets}${read}`;
}

const programWords: Readonly<Record<ProviderUnavailable["program"], string>> = {
  codex: "Codex (GPT)",
  claude: "Claude Code (Claude)",
  dsh: "dsh (DeepSeek)",
  antigravity: "Antigravity",
};

export function allowanceReport(subscriptions: Subscriptions, machines: readonly MachineChoice[], unavailable: readonly ProviderUnavailable[] = [], balance?: import("@super-agent2/protocol").Balance): string {
  const lines = [
    subscriptionLine("GPT subscription (codex)", subscriptions.codex),
    subscriptionLine("Claude subscription (claude)", subscriptions.claude),
    "An unknown reading is not used up. dsh is the default only when both are used up.",
  ];
  if (balance !== undefined) {
    const amounts = balance.wallets.map((wallet) => `${wallet.currency} ${wallet.total} (granted ${wallet.granted}, topped up ${wallet.toppedUp})`).join(", ");
    const read = balance.machine === null ? "" : `, read ${new Date(balance.readAt).toISOString()} on ${balance.machine}`;
    lines.push(`DeepSeek balance (dsh): ${balance.state}${amounts ? `, ${amounts}` : ""}${read}${balance.problem ? `, ${balance.problem}` : ""}`);
  }
  if (unavailable.length === 0) {
    lines.push("No worker program is marked unavailable.");
  } else {
    lines.push("Worker programs marked unavailable, because a worker's program reported itself so when it was really called:");
    for (const mark of unavailable) {
      lines.push(
        `- ${programWords[mark.program]}: ${mark.reason === "" ? "no reason given" : mark.reason}; ${mark.until === null ? "no time given" : `${mark.given ? "until" : "tried again at"} ${new Date(mark.until).toISOString()}`}`,
      );
    }
    lines.push("A marked program counts as used up for choosing an engine. Running tickets switch away from it by themselves, and a mark clears when its time passes, when an attempt on that program succeeds, or when a newer allowance reading shows it available.");
  }
  if (machines.length === 0) {
    lines.push("No work machine is online.");
  }
  for (const machine of machines) {
    lines.push(`Machine ${machine.name} (${machine.platform}), ${machine.free} free slot(s): ${machine.engines.map((offer) => offer.engine).join(", ") || "no programs"}`);
  }
  return lines.join("\n");
}
