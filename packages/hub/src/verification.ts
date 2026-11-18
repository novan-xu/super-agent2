import type { GitHubAccount } from "@super-agent2/protocol";
import { text } from "@super-agent2/catalog";
import {
  changeLevel,
  deploymentFile,
  type FailedStep,
  type GeneratedText,
  type Ticket,
  VerificationRule,
  type VerificationWait,
  type VerifiedPipeline,
  type VerifiedWorkflow,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Tell } from "./chains.js";
import type { Clock } from "./clock.js";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import { accountFor } from "./filing.js";
import { createGitHubApi, type Fetch, type GitHubApi, type MergeMethod, type MergeMethods, type PullRequestState } from "./github-api.js";
import type { FailureReport } from "./failure-loop.js";
import { clip, tail } from "./reports.js";
import type { TicketService } from "./tickets.js";
import { closedIssuesOf, logsOf, type StepLog, VerificationRow } from "./verification-record.js";
import { createWoodpeckerApi, type Pipeline, pipelinePageSize, type PipelineSummary, type WoodpeckerApi } from "./woodpecker.js";

export type Ticker = (tick: () => void) => () => void;

export type AgainOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type SendBack = (ticket: number, note: string, reason: GeneratedText) => AgainOutcome;

export interface VerificationOptions {
  readonly accountOf?: (repository: string) => GitHubAccount;
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly tickets: TicketService;
  readonly credentials: CredentialSource;
  readonly fetch?: Fetch;
  readonly gitHubBase?: string;
  readonly sendBack?: SendBack;
  readonly tell?: Tell;
  readonly ticker?: Ticker;
  readonly pollMilliseconds?: number;
  readonly report?: (report: FailureReport) => void;
  readonly ownRepository?: string;
}

export type SkipOutcome = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly reason: string };

export interface VerificationService {
  check(ticket: number): Promise<void>;
  poll(): Promise<void>;
  skip(ticket: number, reason: string): Promise<SkipOutcome>;
  logs(ticket: number): StepLog[];
  resume(): void;
  idle(): Promise<void>;
  close(): void;
}

export const defaultVerificationPoll = 30_000;

export function intervalTicker(milliseconds: number): Ticker {
  return (tick) => {
    const timer = setInterval(tick, milliseconds);
    return () => clearInterval(timer);
  };
}

export type FailedAt = FailedStep & { readonly stepId: number | null };

export type Evidence =
  | { readonly kind: "green"; readonly workflows: readonly VerifiedWorkflow[] }
  | { readonly kind: "red"; readonly workflows: readonly VerifiedWorkflow[]; readonly failed: readonly FailedAt[]; readonly reason: string }
  | { readonly kind: "waiting"; readonly wait: VerificationWait; readonly workflows: readonly VerifiedWorkflow[]; readonly reason: string };

const failedStates = new Set(["failure", "error"]);
const runningStates = new Set(["pending", "running", "created"]);

export function workflowName(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.ya?ml$/i, "").replace(/^\./, "");
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

export function judge(head: string, expected: readonly string[], pipeline: Pipeline, config: readonly string[]): Evidence {
  const workflows = pipeline.workflows.map((workflow) => ({ name: workflow.name, state: workflow.state }));
  if (pipeline.commit !== head) {
    return { kind: "waiting", wait: "pipeline", workflows: [], reason: `Pipeline #${pipeline.number} ran commit ${short(pipeline.commit)}, not the head ${short(head)}` };
  }
  const failed = pipeline.workflows.filter((workflow) => failedStates.has(workflow.state));
  if (failed.length > 0 || failedStates.has(pipeline.status)) {
    const steps = failed.flatMap((workflow): FailedAt[] => {
      const broken = workflow.steps.filter((step) => failedStates.has(step.state));
      return broken.length === 0
        ? [{ workflow: workflow.name, step: "", exitCode: null, stepId: null }]
        : broken.map((step) => ({ workflow: workflow.name, step: step.name, exitCode: step.exitCode, stepId: step.id }));
    });
    const listed: FailedAt[] = steps.length === 0 ? [{ workflow: "", step: "", exitCode: null, stepId: null }] : steps;
    const said = listed.map((step) => (step.workflow === "" ? `the pipeline ${pipeline.status}` : step.step === "" ? `workflow ${step.workflow} ${pipeline.status}` : `workflow ${step.workflow}, step ${step.step}${step.exitCode === null ? "" : ` (exit code ${step.exitCode})`}`));
    return { kind: "red", workflows, failed: listed, reason: `Pipeline #${pipeline.number} on ${short(head)} failed: ${said.join("; ")}${pipeline.errors === null ? "" : `. Errors: ${pipeline.errors}`}` };
  }
  const missing = expected.filter((name) => !config.includes(name));
  if (missing.length > 0) {
    return { kind: "waiting", wait: "halted", workflows, reason: `Pipeline #${pipeline.number} was built without ${missing.join(", ")}, which the head defines` };
  }
  if (pipeline.workflows.length === 0) {
    return { kind: "waiting", wait: runningStates.has(pipeline.status) ? "workflows" : "halted", workflows, reason: `Pipeline #${pipeline.number} on ${short(head)} has no workflow yet (${pipeline.status})` };
  }
  const unfinished = pipeline.workflows.filter((workflow) => runningStates.has(workflow.state));
  if (unfinished.length > 0 || runningStates.has(pipeline.status)) {
    return { kind: "waiting", wait: "workflows", workflows, reason: `Pipeline #${pipeline.number} on ${short(head)} is ${pipeline.status}` };
  }
  const notGreen = pipeline.workflows.filter((workflow) => workflow.state !== "success");
  if (notGreen.length > 0 || pipeline.status !== "success") {
    const which = notGreen.map((workflow) => `${workflow.name} ${workflow.state}`).join(", ");
    return { kind: "waiting", wait: "halted", workflows, reason: `Pipeline #${pipeline.number} on ${short(head)} is ${pipeline.status}${which === "" ? "" : ` (${which})`}, which is not green` };
  }
  return { kind: "green", workflows };
}

const ruleWords: Readonly<Record<VerificationRule, string>> = {
  documentation: "only text and documentation files changed, so no pipeline was waited for",
  workflows: "every Woodpecker workflow on the head commit was green",
  none: "the repository has no Woodpecker workflow, so there was no rule to wait for",
  skipped: "you merged it with the rules skipped",
  outside: "it was merged on GitHub outside the hub",
};

type Patch = Partial<Omit<VerificationRow, "ticket_id">>;

type Outcome = { readonly kind: "none"; readonly reason: string } | { readonly kind: "green"; readonly pipeline: VerifiedPipeline; readonly workflows: readonly VerifiedWorkflow[] } | {
  readonly kind: "red";
  readonly pipeline: VerifiedPipeline;
  readonly workflows: readonly VerifiedWorkflow[];
  readonly failed: readonly FailedStep[];
  readonly logs: readonly StepLog[];
  readonly reason: string;
} | { readonly kind: "waiting"; readonly wait: VerificationWait; readonly reason: string; readonly pipeline: VerifiedPipeline | null; readonly workflows: readonly VerifiedWorkflow[] };

const columns = [
  "entry",
  "head",
  "level",
  "rule",
  "state",
  "waiting",
  "reason",
  "pipeline",
  "workflows",
  "failures",
  "logs",
  "told",
  "skip_reason",
  "skip_at",
  "conflict_returns",
  "merging_head",
  "merging_rule",
  "merge_commit",
  "merged_at",
  "closed_issues",
  "branch_done",
  "deployment",
  "reported_at",
  "checked_at",
] as const;

const IdRow = z.object({ ticket_id: z.number().int() });
const SeqRow = z.object({ seq: z.number().int().nullable() });

const pipelinePages = 5;
const logLimit = 20_000;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function methodOf(methods: MergeMethods): MergeMethod {
  return methods.squash ? "squash" : methods.merge ? "merge" : "rebase";
}

export function createVerification(options: VerificationOptions): VerificationService {
  const { tickets, clock } = options;
  const { connection } = options.database;
  const doFetch = options.fetch ?? fetch;
  const tell: Tell = options.tell ?? (() => undefined);
  const ticker = options.ticker ?? intervalTicker(options.pollMilliseconds ?? defaultVerificationPoll);
  const tails = new Map<number, Promise<void>>();
  const pending = new Set<number>();
  const states = new Map<number, string>();
  let stopTicker: (() => void) | undefined;
  let closed = false;

  const selectRow = connection.prepare("SELECT * FROM ticket_verifications WHERE ticket_id = ?");
  const insertRow = connection.prepare("INSERT OR IGNORE INTO ticket_verifications (ticket_id, state) VALUES (?, 'checking')");
  const updateRow = connection.prepare(`UPDATE ticket_verifications SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE ticket_id = ?`);
  const selectVerifying = connection.prepare("SELECT id AS ticket_id FROM tickets WHERE state = 'verifying' ORDER BY id");
  const selectUnreported = connection.prepare(
    "SELECT v.ticket_id FROM ticket_verifications v JOIN tickets t ON t.id = v.ticket_id WHERE t.state = 'merged' AND v.merged_at IS NOT NULL AND v.reported_at IS NULL ORDER BY v.ticket_id",
  );
  const selectEntry = connection.prepare("SELECT MAX(seq) AS seq FROM ticket_moves WHERE ticket_id = ? AND to_state = 'verifying' AND from_state = 'working'");

  const rowOf = (id: number): VerificationRow | undefined => {
    const row = selectRow.get(id);
    return row === undefined ? undefined : VerificationRow.parse(row);
  };

  const write = (id: number, patch: Patch): boolean => {
    insertRow.run(id);
    const current = rowOf(id);
    if (current === undefined) {
      return false;
    }
    const changed = Object.entries(patch).some(([column, value]) => current[column as keyof VerificationRow] !== value);
    if (!changed) {
      return false;
    }
    const next: VerificationRow = { ...current, ...patch, checked_at: clock.now() };
    updateRow.run(...columns.map((column) => next[column]), id);
    return true;
  };

  const save = (id: number, patch: Patch) => {
    if (closed) {
      return;
    }
    tickets.change((writes) => {
      if (write(id, patch)) {
        writes.touched(id);
      }
    });
  };

  const wait = (id: number, waiting: VerificationWait, reason: string, extra: Patch = {}) => {
    save(id, { state: "waiting", waiting, reason, ...extra });
  };

  const tellOnce = (ticket: Ticket, key: string, notice: string, prompt: string) => {
    if (closed || rowOf(ticket.id)?.told === key) {
      return;
    }
    save(ticket.id, { told: key });
    tell(ticket.conversation, notice, prompt);
  };

  const reportOnce = (ticket: Ticket, key: string, report: FailureReport, notice: string, prompt: string) => {
    if (options.report === undefined) {
      tellOnce(ticket, key, notice, prompt);
      return;
    }
    if (closed || rowOf(ticket.id)?.told === key) {
      return;
    }
    save(ticket.id, { told: key });
    options.report(report);
  };

  const bothSides = async (gitHub: GitHubApi, ticket: Ticket, head: string, base: string): Promise<string> => {
    const repository = ticket.repository ?? "";
    try {
      const ours = new Set((await gitHub.files(repository, ticket.pullRequest ?? 0)).map((file) => file.path));
      const theirs = await gitHub.changedOn(repository, head, base);
      const shared = theirs.filter((path) => ours.has(path));
      return shared.length === 0
        ? `no file is changed both by the pull request and on ${base} since it branched (${theirs.length} file(s) changed on ${base})`
        : `files changed both by the pull request and on ${base} since it branched: ${shared.join(", ")}`;
    } catch (error) {
      return `the files changed on both sides could not be read: ${reasonOf(error)}`;
    }
  };

  const entryOf = (id: number): number => SeqRow.parse(selectEntry.get(id)).seq ?? 0;

  const described = (ticket: Ticket) => `ticket ${ticket.id} (${ticket.title.en})`;

  const gitHubFor = (repository: string): GitHubApi | string => {
    const found = options.credentials((options.accountOf ?? accountFor)(repository));
    if (!found.ok) {
      return found.reason;
    }
    const token = found.credentials["GH_TOKEN"];
    if (token === undefined || token === "") {
      return `There is no GitHub token for ${repository}`;
    }
    return createGitHubApi({ fetch: doFetch, token, ...(options.gitHubBase === undefined ? {} : { base: options.gitHubBase }) });
  };

  const woodpeckerFor = (repository: string): WoodpeckerApi | undefined => {
    const found = options.credentials((options.accountOf ?? accountFor)(repository));
    if (!found.ok) {
      return undefined;
    }
    const server = found.credentials["WOODPECKER_SERVER"];
    const token = found.credentials["WOODPECKER_TOKEN"];
    if (server === undefined || server === "" || token === undefined || token === "") {
      return undefined;
    }
    return createWoodpeckerApi({ fetch: doFetch, server, token });
  };

  const configured = async (gitHub: GitHubApi, repository: string, head: string, configFile: string): Promise<string[]> => {
    const candidates = configFile === "" ? [".woodpecker", ".woodpecker.yaml", ".woodpecker.yml"] : [configFile];
    for (const path of candidates) {
      const found = await gitHub.contents(repository, path, head);
      if (found === null) {
        continue;
      }
      if (found.kind === "file") {
        return [workflowName(path)];
      }
      const names = found.files.filter((name) => /\.ya?ml$/i.test(name)).map(workflowName);
      if (names.length > 0) {
        return names.sort();
      }
    }
    return [];
  };

  const findPipeline = async (woodpecker: WoodpeckerApi, repository: number, pullRequest: number, head: string): Promise<PipelineSummary | undefined> => {
    const prefix = `refs/pull/${pullRequest}/`;
    for (let page = 1; page <= pipelinePages; page += 1) {
      const list = await woodpecker.pipelines(repository, pullRequest, page);
      const found = list
        .filter((entry) => entry.commit === head && entry.ref.startsWith(prefix) && (entry.event === "" || entry.event === "pull_request"))
        .sort((a, b) => b.number - a.number)[0];
      if (found !== undefined) {
        return found;
      }
      if (list.length < pipelinePageSize) {
        return undefined;
      }
    }
    return undefined;
  };

  const workflowsOutcome = async (ticket: Ticket, repository: string, pullRequest: number, head: string, gitHub: GitHubApi): Promise<Outcome> => {
    const woodpecker = woodpeckerFor(repository);
    if (woodpecker === undefined) {
      const names = await configured(gitHub, repository, head, "");
      if (names.length === 0) {
        return { kind: "none", reason: `The head ${short(head)} defines no Woodpecker workflow` };
      }
      return {
        kind: "waiting",
        wait: "woodpecker",
        reason: `The head ${short(head)} defines Woodpecker workflows (${names.join(", ")}), and the hub has no WOODPECKER_SERVER and WOODPECKER_TOKEN to read their results`,
        pipeline: null,
        workflows: [],
      };
    }
    let known;
    try {
      known = await woodpecker.repository(repository);
    } catch (error) {
      return { kind: "waiting", wait: "woodpecker", reason: reasonOf(error), pipeline: null, workflows: [] };
    }
    if (known === null || !known.active) {
      return { kind: "none", reason: `Woodpecker does not run ${repository}` };
    }
    const names = await configured(gitHub, repository, head, known.configFile);
    if (names.length === 0) {
      return { kind: "none", reason: `The head ${short(head)} defines no Woodpecker workflow` };
    }
    try {
      const summary = await findPipeline(woodpecker, known.id, pullRequest, head);
      if (summary === undefined) {
        return { kind: "waiting", wait: "pipeline", reason: `Woodpecker has no pipeline for the head ${short(head)} yet; the head defines ${names.join(", ")}`, pipeline: null, workflows: [] };
      }
      const pipeline = await woodpecker.pipeline(known.id, summary.number);
      const config = await woodpecker.config(known.id, summary.number);
      const shown: VerifiedPipeline = { number: pipeline.number, url: woodpecker.pipelineUrl(known.id, pipeline.number) };
      const evidence = judge(head, names, pipeline, config);
      if (evidence.kind === "green") {
        return { kind: "green", pipeline: shown, workflows: evidence.workflows };
      }
      if (evidence.kind === "waiting") {
        return { kind: "waiting", wait: evidence.wait, reason: evidence.reason, pipeline: shown, workflows: evidence.workflows };
      }
      const logs: StepLog[] = [];
      for (const step of evidence.failed) {
        let log = "";
        if (step.stepId !== null) {
          try {
            log = tail(await woodpecker.log(known.id, pipeline.number, step.stepId), logLimit);
          } catch (error) {
            log = `(the log could not be read: ${reasonOf(error)})`;
          }
        } else if (pipeline.errors !== null) {
          log = pipeline.errors;
        }
        logs.push({ workflow: step.workflow, step: step.step, exitCode: step.exitCode, log });
      }
      return {
        kind: "red",
        pipeline: shown,
        workflows: evidence.workflows,
        failed: evidence.failed.map((step) => ({ workflow: step.workflow, step: step.step, exitCode: step.exitCode })),
        logs,
        reason: evidence.reason,
      };
    } catch (error) {
      return { kind: "waiting", wait: "woodpecker", reason: reasonOf(error), pipeline: null, workflows: [] };
    }
  };

  const report = (id: number) => {
    const ticket = tickets.get(id);
    const row = rowOf(id);
    if (closed || ticket === undefined || row === undefined || ticket.state !== "merged" || row.reported_at !== null) {
      return;
    }
    const rule = VerificationRule.catch("outside").parse(row.rule ?? "outside");
    const issues = ticket.issues.map((issue) => `#${issue.number}`).join(", ");
    const own = options.ownRepository !== undefined && (ticket.repository ?? "").toLowerCase() === options.ownRepository.toLowerCase();
    const deployed = row.deployment === 1 && !own;
    const waitingForDeployment = tickets.waitingFor(id).filter((after) => after.waits.some((entry) => entry.ticket === id && entry.deployment && !entry.waived) && (after.state === "waiting" || after.state === "pending"));
    const lines = [
      `[hub] Ticket ${ticket.id} (${ticket.title.en}) is merged: pull request #${ticket.pullRequest ?? 0} in ${ticket.repository ?? ""} was merged${row.head === null ? "" : ` at ${row.head}`}${row.merge_commit === null ? "" : ` as commit ${row.merge_commit}`}, because ${ruleWords[rule]}${rule === "skipped" && row.skip_reason !== null ? ` (${row.skip_reason})` : ""}.`,
      `Issues closed: ${issues === "" ? "none" : issues}. Its worktree is removed, and the tickets that waited for it begin by themselves.`,
      own
        ? "Deployment: this is Super-agent2 itself, which the hub does not deploy, since it cannot reach the NAS host. It is deployed on the NAS by hand, or by a worker when the owner files work for it. Tell the owner the new version is merged and waits to be deployed; once the owner says it is deployed, report it with report_deployment."
        : deployed
          ? `Deployment: the repository has a deployment (${deploymentFile} at the merged commit), so this change needs deploying. The ticket deployed nothing. Deploy it with deploy_repository at ${row.merge_commit ?? "the merge commit"} unless the owner said otherwise.`
          : `Deployment: the repository has no deployment (no ${deploymentFile} at the merged commit), so nothing needs deploying.`,
      ...((deployed || own) && waitingForDeployment.length > 0
        ? [`Waiting for this deployment: ${waitingForDeployment.map((after) => `ticket ${after.id}`).join(", ")}; they begin once a deployment that contains this commit succeeds.`]
        : []),
      "Tell the owner in Chinese, in a line or two.",
    ];
    save(id, { reported_at: clock.now() });
    tell(ticket.conversation, text(own ? "notice.ticketMergedSelf" : deployed ? "notice.ticketMergedDeploy" : "notice.ticketMerged", { ticket: id }), lines.join("\n"));
  };

  const finish = async (ticket: Ticket, gitHub: GitHubApi, pull: PullRequestState, rule: VerificationRule): Promise<void> => {
    const repository = ticket.repository ?? "";
    const before = rowOf(ticket.id);
    const commit = pull.mergeCommit ?? before?.merge_commit ?? null;
    save(ticket.id, { rule, state: "merging", waiting: null, reason: null, merge_commit: commit, merged_at: before?.merged_at ?? clock.now(), head: pull.head });
    try {
      const current = rowOf(ticket.id);
      const done = new Set(current === undefined ? [] : closedIssuesOf(current));
      for (const issue of ticket.issues) {
        if (done.has(issue.number) || issue.repository.toLowerCase() !== repository.toLowerCase()) {
          continue;
        }
        const open = await gitHub.issueOpen(repository, issue.number);
        if (open === true) {
          try {
            await gitHub.closeIssue(repository, issue.number);
          } catch (error) {
            if ((await gitHub.issueOpen(repository, issue.number)) === true) {
              throw error;
            }
          }
        }
        done.add(issue.number);
        save(ticket.id, { closed_issues: JSON.stringify([...done]) });
      }
      const row = rowOf(ticket.id);
      if (row !== undefined && row.branch_done === 0) {
        if (ticket.branch !== null && pull.headRef === ticket.branch && (pull.headRepository === null || pull.headRepository.toLowerCase() === repository.toLowerCase())) {
          await gitHub.deleteBranch(repository, ticket.branch);
        }
        save(ticket.id, { branch_done: 1 });
      }
      if (rowOf(ticket.id)?.deployment === null) {
        const found = await gitHub.contents(repository, deploymentFile, commit ?? pull.head);
        save(ticket.id, { deployment: found === null ? 0 : 1 });
      }
    } catch (error) {
      wait(ticket.id, "finishing", `Merged on GitHub; finishing failed and is tried again: ${reasonOf(error)}`, { state: "merging" });
      return;
    }
    if (closed) {
      return;
    }
    tickets.change((writes) => {
      if (writes.get(ticket.id)?.state !== "verifying") {
        return;
      }
      write(ticket.id, { state: "merged", waiting: null, reason: null });
      writes.move(ticket.id, "merged", { en: `Merged: ${ruleWords[rule]}`, zh: text(`verification.merged.${rule}`) });
    });
    report(ticket.id);
  };

  const conflict = async (ticket: Ticket, head: string, base: string, gitHub: GitHubApi): Promise<void> => {
    const files = await bothSides(gitHub, ticket, head, base);
    if (closed) {
      return;
    }
    const returns = (rowOf(ticket.id)?.conflict_returns ?? 0) + 1;
    save(ticket.id, {
      state: "conflict",
      waiting: null,
      reason: `The pull request conflicts with ${base} at ${short(head)}; ${files}`,
      merging_head: null,
      merging_rule: null,
      skip_at: null,
      skip_reason: null,
    });
    const again = returns === 1 ? "" : ` It has come back for a conflict before; this is time ${returns}.`;
    const note = `Pull request #${ticket.pullRequest ?? 0} cannot be merged: it conflicts with ${base} at ${short(head)}.${again} ${files.charAt(0).toUpperCase()}${files.slice(1)}. Merge the latest ${base} into this branch, resolve every conflict, run the tests, push, and hand back the same pull request.`;
    const outcome = options.sendBack?.(ticket.id, note, { en: `The pull request conflicts with ${base}; it went back to the worker`, zh: text("verification.conflictReturned", { base }) }) ?? {
      ok: false,
      reason: "The hub has no worker service to send it back to",
    };
    if (outcome.ok) {
      save(ticket.id, { conflict_returns: returns, reason: `The pull request conflicts with ${base} at ${short(head)}; it went back to the worker, time ${returns}` });
      return;
    }
    save(ticket.id, { reason: `The pull request conflicts with ${base} at ${short(head)}, and it could not go back to the worker: ${outcome.reason}` });
    tellOnce(
      ticket,
      `again:${head}`,
      text("notice.verificationFailed", { ticket: ticket.id }),
      `[hub] The pull request #${ticket.pullRequest ?? 0} of ${described(ticket)} conflicts with ${base} at ${head}, and it could not go back to its worker: ${outcome.reason}. Tell the owner in Chinese what happened.`,
    );
  };

  const merge = async (ticket: Ticket, gitHub: GitHubApi, head: string, rule: VerificationRule): Promise<void> => {
    const repository = ticket.repository ?? "";
    const number = ticket.pullRequest ?? 0;
    const fresh = await gitHub.pullRequest(repository, number);
    if (closed) {
      return;
    }
    if (fresh.merged) {
      await finish(ticket, gitHub, fresh, rule);
      return;
    }
    if (!fresh.open) {
      wait(ticket.id, "closed", `The pull request #${number} was closed without merging`);
      return;
    }
    if (fresh.head !== head) {
      save(ticket.id, { state: "checking", waiting: null, reason: `The head moved from ${short(head)} to ${short(fresh.head)} while it was checked` });
      void check(ticket.id);
      return;
    }
    if (fresh.mergeable === null) {
      wait(ticket.id, "mergeable", `GitHub has not yet worked out whether ${short(head)} merges cleanly into ${fresh.base}`, { rule });
      return;
    }
    if (!fresh.mergeable) {
      await conflict(ticket, head, fresh.base, gitHub);
      return;
    }
    const method = methodOf(await gitHub.mergeMethods(repository));
    save(ticket.id, { rule, state: "merging", waiting: null, reason: null, merging_head: head, merging_rule: rule });
    const answer = await gitHub.merge(repository, number, head, method);
    if (closed) {
      return;
    }
    if (answer.ok) {
      save(ticket.id, { merge_commit: answer.sha, merged_at: clock.now() });
      await finish(ticket, gitHub, { ...fresh, merged: true, open: false, mergeCommit: answer.sha }, rule);
      return;
    }
    save(ticket.id, { merging_head: null, merging_rule: null });
    if (answer.kind === "moved") {
      save(ticket.id, { state: "checking", reason: answer.message });
      void check(ticket.id);
      return;
    }
    if (answer.kind === "unmergeable") {
      const again = await gitHub.pullRequest(repository, number);
      if (again.open && again.head === head && again.mergeable === false) {
        await conflict(ticket, head, again.base, gitHub);
        return;
      }
    }
    wait(ticket.id, "mergeable", answer.message, { rule });
    tellOnce(
      ticket,
      `refused:${head}`,
      text("notice.verificationFailed", { ticket: ticket.id }),
      `[hub] GitHub refused to merge pull request #${number} of ${described(ticket)} at ${head}: ${answer.message}. The ticket stays verifying and the merge is tried again on the next check. Tell the owner in Chinese if it keeps failing.`,
    );
  };

  const examine = async (id: number): Promise<void> => {
    const ticket = tickets.get(id);
    if (ticket === undefined || closed) {
      return;
    }
    if (ticket.state === "merged") {
      report(id);
      return;
    }
    if (ticket.state !== "verifying") {
      return;
    }
    const repository = ticket.repository;
    const number = ticket.pullRequest;
    if (repository === null || number === null) {
      wait(id, "github", `Ticket ${id} has no pull request to verify`);
      return;
    }
    const gitHub = gitHubFor(repository);
    if (typeof gitHub === "string") {
      wait(id, "github", gitHub);
      return;
    }
    let pull: PullRequestState;
    try {
      pull = await gitHub.pullRequest(repository, number);
    } catch (error) {
      wait(id, "github", reasonOf(error));
      return;
    }
    if (closed) {
      return;
    }
    const entry = entryOf(id);
    const known = rowOf(id);
    if (pull.merged) {
      const ours = known !== undefined && known.merging_head === pull.head ? known.merging_rule : null;
      const recorded = known !== undefined && known.merged_at !== null ? known.rule : null;
      await finish(ticket, gitHub, pull, VerificationRule.catch("outside").parse(ours ?? recorded ?? "outside"));
      return;
    }
    if (!pull.open) {
      wait(id, "closed", `The pull request #${number} was closed without merging`);
      tellOnce(
        ticket,
        `closed:${entry}:${pull.head}`,
        text("notice.pullRequestClosed", { ticket: id }),
        `[hub] The pull request #${number} of ${described(ticket)} was closed on GitHub without merging. The ticket stays verifying, and merges by its rules if the pull request is reopened. Tell the owner in Chinese; stop it with stop_ticket if the work is abandoned.`,
      );
      return;
    }
    if (known === undefined || known.head !== pull.head || known.entry !== entry) {
      const sameHead = known?.head === pull.head;
      save(id, {
        entry,
        head: pull.head,
        level: sameHead ? (known?.level ?? null) : null,
        rule: null,
        state: "checking",
        waiting: null,
        reason: null,
        pipeline: null,
        workflows: "[]",
        failures: "[]",
        logs: "[]",
        ...(sameHead ? {} : { merging_head: null, merging_rule: null }),
      });
    }
    const row = rowOf(id);
    if (row === undefined) {
      return;
    }
    const skipping = row.skip_at !== null;
    if (!skipping && (row.state === "failed" || row.state === "conflict")) {
      return;
    }
    let rule: VerificationRule;
    if (skipping) {
      rule = "skipped";
    } else {
      let level = row.level;
      if (level === null) {
        const files = await gitHub.files(repository, number);
        level = changeLevel(files.map((file) => ({ path: file.path, previous: file.previous })));
        save(id, { level });
      }
      if (level === "documentation") {
        rule = "documentation";
      } else {
        const outcome = await workflowsOutcome(ticket, repository, number, pull.head, gitHub);
        if (closed) {
          return;
        }
        if (outcome.kind === "waiting") {
          wait(id, outcome.wait, outcome.reason, { rule: "workflows", pipeline: outcome.pipeline === null ? null : JSON.stringify(outcome.pipeline), workflows: JSON.stringify(outcome.workflows) });
          return;
        }
        if (outcome.kind === "red") {
          save(id, {
            rule: "workflows",
            state: "failed",
            waiting: null,
            reason: outcome.reason,
            pipeline: JSON.stringify(outcome.pipeline),
            workflows: JSON.stringify(outcome.workflows),
            failures: JSON.stringify(outcome.failed),
            logs: JSON.stringify(outcome.logs),
          });
          reportOnce(
            ticket,
            `failed:${entry}:${pull.head}:${outcome.pipeline.number}`,
            {
              ticket: id,
              failure: { kind: "workflow", detail: outcome.reason },
              evidence: [
                `The verification rules failed for ${described(ticket)}: ${outcome.reason}.`,
                `Pull request #${number} in ${repository}, head ${pull.head}, branch ${ticket.branch ?? "(none)"}; pipeline ${outcome.pipeline.url}.`,
                ...outcome.logs.flatMap((log) => [`The log of workflow ${log.workflow}, step ${log.step}${log.exitCode === null ? "" : ` (exit code ${log.exitCode})`}, ends with:`, tail(log.log || "(empty)", 8_000)]),
              ].join("\n"),
            },
            text("notice.verificationFailed", { ticket: id }),
            [
              `[hub] The verification rules failed for ${described(ticket)}: ${outcome.reason}.`,
              `Pull request #${number} in ${repository}, head ${pull.head}; pipeline ${outcome.pipeline.url}.`,
              ...outcome.logs.flatMap((log) => [`The log of workflow ${log.workflow}, step ${log.step}, ends with:`, clip(log.log || "(empty)", 6_000)]),
              "The ticket stays verifying with this failure recorded. Nothing is retried and no pipeline is run again. Tell the owner in Chinese what failed. Merge it with merge_ticket only if the owner asks you to skip the rules; stop it with stop_ticket if it cannot be done.",
            ].join("\n"),
          );
          return;
        }
        if (outcome.kind === "green") {
          rule = "workflows";
          save(id, { rule, pipeline: JSON.stringify(outcome.pipeline), workflows: JSON.stringify(outcome.workflows), reason: null });
        } else {
          rule = "none";
          save(id, { rule, reason: outcome.reason });
        }
      }
    }
    await merge(ticket, gitHub, pull.head, rule);
  };

  const guarded = async (id: number): Promise<void> => {
    try {
      await examine(id);
    } catch (error) {
      if (closed) {
        return;
      }
      try {
        const ticket = tickets.get(id);
        if (ticket?.state === "verifying") {
          wait(id, "github", reasonOf(error));
        }
      } catch {
        return;
      }
    }
  };

  const check = (id: number): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    const tail = tails.get(id) ?? Promise.resolve();
    if (pending.has(id)) {
      return tail;
    }
    pending.add(id);
    const next = tail.then(() => {
      pending.delete(id);
      return guarded(id);
    });
    tails.set(id, next);
    void next.then(() => {
      if (tails.get(id) === next) {
        tails.delete(id);
      }
    });
    return next;
  };

  const poll = async (): Promise<void> => {
    if (closed) {
      return;
    }
    const ids = [...selectVerifying.all(), ...selectUnreported.all()].map((row) => IdRow.parse(row).ticket_id);
    await Promise.all([...new Set(ids)].map((id) => check(id)));
  };

  const unsubscribe = tickets.subscribe((ticket) => {
    const before = states.get(ticket.id);
    if (ticket.state === "verifying" || ticket.state === "working") {
      states.set(ticket.id, ticket.state);
    } else {
      states.delete(ticket.id);
    }
    if (ticket.state === "verifying" && before !== "verifying" && !closed) {
      void check(ticket.id);
    }
  });

  return {
    check,
    poll,
    skip: async (id, reason) => {
      const ticket = tickets.get(id);
      if (ticket === undefined) {
        return { ok: false, reason: `There is no ticket ${id}.` };
      }
      if (ticket.state !== "verifying") {
        return {
          ok: false,
          reason:
            ticket.state === "merged"
              ? `Ticket ${id} is already merged.`
              : `Ticket ${id} is ${ticket.state}; only a ticket in verifying, whose worker has handed back its pull request, can be merged.`,
        };
      }
      if (reason.trim() === "") {
        return { ok: false, reason: "Say why the rules are skipped: what the owner asked." };
      }
      save(id, { skip_at: clock.now(), skip_reason: reason.trim() });
      await check(id);
      const after = tickets.get(id);
      return after === undefined ? { ok: false, reason: `There is no ticket ${id}.` } : { ok: true, ticket: after };
    },
    logs: (id) => {
      const row = rowOf(id);
      return row === undefined ? [] : logsOf(row);
    },
    resume: () => {
      if (closed || stopTicker !== undefined) {
        return;
      }
      for (const ticket of tickets.list({ open: true, limit: 100_000 })) {
        if (ticket.state === "verifying" || ticket.state === "working") {
          states.set(ticket.id, ticket.state);
        }
      }
      stopTicker = ticker(() => {
        void poll();
      });
      void poll();
    },
    idle: async () => {
      while (tails.size > 0) {
        await Promise.all([...tails.values()]);
      }
    },
    close: () => {
      closed = true;
      stopTicker?.();
      unsubscribe();
    },
  };
}
