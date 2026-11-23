import { readFileSync } from "node:fs";
import { type Decision, type GeneratedText, Handback, type HandbackScreenshot, HeadCommit } from "@super-agent2/protocol";
import { z } from "zod";
import type { ProcessRunner } from "./git.js";

export interface PullRequestState {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly head: string;
  readonly commit?: string;
  readonly closes: readonly number[];
}

export type PullRequestReader = (repository: string, number: number, environment: Readonly<Record<string, string>>, cwd: string) => Promise<PullRequestState | string>;

type GitHubContext = { readonly repository: string; readonly environment: Readonly<Record<string, string>>; readonly cwd: string };

export type ClosedIssueReader = (context: GitHubContext, numbers: readonly number[]) => Promise<number[]>;
export type BranchPullReader = (context: GitHubContext, branch: string, issues: readonly number[]) => Promise<number | null>;

const ClosingReferences = z.array(z.looseObject({ number: z.number().int(), url: z.string().optional() })).default([]);
const PullRequestJson = z.looseObject({
  number: z.number().int(),
  url: z.string(),
  state: z.string(),
  headRefName: z.string(),
  headRefOid: HeadCommit.optional(),
  closingIssuesReferences: ClosingReferences,
});

function closingNumbers(references: z.output<typeof ClosingReferences>, repository: string): number[] {
  const prefix = `https://github.com/${repository.toLowerCase()}/issues/`;
  return references.filter((issue) => issue.url === undefined || issue.url.toLowerCase().startsWith(prefix)).map((issue) => issue.number);
}

export function readPullRequestWith(run: ProcessRunner, gh: string): PullRequestReader {
  return async (repository, number, environment, cwd) => {
    const result = await run(gh, ["pr", "view", String(number), "--repo", repository, "--json", "number,url,state,headRefName,headRefOid,closingIssuesReferences"], {
      cwd,
      env: environment,
    });
    if (result.code !== 0) {
      return `gh pr view ${number} failed: ${`${result.stderr}${result.stdout}`.trim()}`;
    }
    try {
      const parsed = PullRequestJson.parse(JSON.parse(result.stdout));
      return {
        number: parsed.number,
        url: parsed.url,
        state: parsed.state,
        head: parsed.headRefName,
        ...(parsed.headRefOid === undefined ? {} : { commit: parsed.headRefOid }),
        closes: closingNumbers(parsed.closingIssuesReferences, repository),
      };
    } catch (error) {
      return `gh pr view ${number} gave an answer that could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

const IssueState = z.object({ state: z.enum(["OPEN", "CLOSED"]) });
const BranchPulls = z.array(z.object({
  number: z.number().int().positive(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  closingIssuesReferences: ClosingReferences,
}));

async function readGitHub(run: ProcessRunner, gh: string, context: GitHubContext, args: string[]): Promise<unknown> {
  const result = await run(gh, [...args, "--repo", context.repository], { cwd: context.cwd, env: context.environment });
  if (result.code !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${`${result.stderr}${result.stdout}`.trim()}`);
  }
  return JSON.parse(result.stdout);
}

export function readClosedIssuesWith(run: ProcessRunner, gh: string): ClosedIssueReader {
  return async (context, numbers) => {
    const states = await Promise.all(numbers.map(async (number) => {
      const issue = IssueState.parse(await readGitHub(run, gh, context, ["issue", "view", String(number), "--json", "state"]));
      return issue.state === "CLOSED" ? [number] : [];
    }));
    return states.flat();
  };
}

export function readBranchPullWith(run: ProcessRunner, gh: string): BranchPullReader {
  return async (context, branch, issues) => {
    const pulls = BranchPulls.parse(await readGitHub(run, gh, context, [
      "pr", "list", "--state", "open", "--head", branch, "--limit", "100", "--json", "number,headRepositoryOwner,closingIssuesReferences",
    ]));
    const owner = context.repository.split("/")[0]?.toLowerCase();
    return pulls.find((pull) => pull.headRepositoryOwner?.login.toLowerCase() === owner
      && closingNumbers(pull.closingIssuesReferences, context.repository).some((number) => issues.includes(number)))?.number ?? null;
  };
}

export type HandbackOutcome =
  | { readonly ok: true; readonly outcome: "finished"; readonly pullRequest: number; readonly url: string; readonly closes: readonly number[]; readonly report: GeneratedText; readonly decisions: readonly Decision[];
      readonly screenshots?: { readonly head: string; readonly images: readonly HandbackScreenshot[]; readonly newViews: string[] } }
  | { readonly ok: true; readonly outcome: "settled" }
  | { readonly ok: true; readonly outcome: "failed"; readonly report: GeneratedText }
  | { readonly ok: false; readonly problem: string };

export interface HandbackCheck extends GitHubContext {
  readonly path: string;
  readonly branch: string;
  readonly outstanding: readonly number[];
  readonly closedOutside?: readonly number[] | undefined;
  readonly readClosedIssues: ClosedIssueReader;
  readonly read: PullRequestReader;
  readonly readBranchPull: BranchPullReader;
}

function listed(numbers: readonly number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

export async function checkHandback(check: HandbackCheck): Promise<HandbackOutcome> {
  const handback = readHandback(check.path);
  const failure = handback.kind === "given" && handback.value.outcome === "failed"
    ? { ok: true, outcome: "failed", report: handback.value.report } as const : undefined;
  try {
    const closed = check.closedOutside ?? await check.readClosedIssues(check, check.outstanding);
    const open = check.outstanding.filter((issue) => !closed.includes(issue));
    const outcome = await checkPullHandback(check, open, handback);
    if (open.length > 0 || (outcome.ok && outcome.outcome === "finished")) {
      return outcome;
    }
    const pull = check.outstanding.length === 0 ? null : await check.readBranchPull(check, check.branch, check.outstanding);
    return pull === null
      ? { ok: true, outcome: "settled" }
      : failure ?? { ok: false, problem: `Every issue is settled, and pull request #${pull} is still open from this branch with a closing reference to the chain. Hand in #${pull} by writing the JSON file at ${check.path}.` };
  } catch (error) {
    if (failure !== undefined) {
      return failure;
    }
    throw error;
  }
}

type ReadHandback = { readonly kind: "missing" } | { readonly kind: "invalid"; readonly problem: string } | { readonly kind: "given"; readonly value: Handback };

function readHandback(path: string): ReadHandback {
  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch {
    return { kind: "missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: "invalid", problem: `The hand-back file ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Write it again.` };
  }
  const parsed = Handback.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "invalid",
      problem: `The hand-back file ${path} does not have the expected shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`).join("; ")}. For a pull request, give "pullRequest" (a number) and "summary". If you cannot hand in a pull request, give "outcome": "failed" and "report". Both "summary" and "report" need "en" in English and "zh" in Simplified Chinese. A pull request hand-in may list "decisions", each with "chosen", "why" and "otherOptions", every one of them with "en" and "zh".`,
    };
  }
  return { kind: "given", value: parsed.data };
}

async function checkPullHandback(check: HandbackCheck, open: readonly number[], submission: ReadHandback): Promise<HandbackOutcome> {
  if (submission.kind === "missing") {
    return {
      ok: false,
      problem: `You have not handed in a pull request: there is no file at ${check.path}. ${listed(open)} ${open.length === 1 ? "is" : "are"} still open. Hand in a pull request that closes one of them, or write a failed hand-back as described in your task if you cannot.`,
    };
  }
  if (submission.kind === "invalid") {
    return { ok: false, problem: submission.problem };
  }
  const handback = submission.value;
  if (handback.outcome === "failed") {
    return { ok: true, outcome: "failed", report: handback.report };
  }
  const state = await check.read(check.repository, handback.pullRequest, check.environment, check.cwd);
  if (typeof state === "string") {
    return { ok: false, problem: `Pull request #${handback.pullRequest} named in the hand-back file could not be read: ${state}` };
  }
  if (state.head !== check.branch) {
    return { ok: false, problem: `Pull request #${handback.pullRequest} is from the branch ${state.head}, not from your branch ${check.branch}. Open the pull request from ${check.branch} and hand back its number.` };
  }
  if (state.state !== "OPEN" && state.state !== "MERGED") {
    return { ok: false, problem: `Pull request #${handback.pullRequest} is ${state.state.toLowerCase()}. Reopen it or open a new one from ${check.branch}, and hand back its number.` };
  }
  const eligible = state.state === "MERGED" || open.length === 0 ? check.outstanding : open;
  const closing = eligible.filter((issue) => state.closes.includes(issue));
  if (closing.length === 0) {
    return {
      ok: false,
      problem: `Pull request #${handback.pullRequest} closes none of the open issues of the chain (${listed(open)}). Edit its body so that it has a line "Closes #<number>" for each open issue it resolves (gh pr edit ${handback.pullRequest} --body-file <file>), then write the hand-back file again.`,
    };
  }
  const images = handback.screenshots ?? [];
  if (images.length > 0 && state.commit === undefined) {
    return { ok: false, problem: `GitHub did not supply the head commit of pull request #${state.number}. Check the pull request and hand in the screenshots again.` };
  }
  return { ok: true, outcome: "finished", pullRequest: state.number, url: state.url, closes: closing, report: handback.summary, decisions: handback.decisions,
    ...(images.length === 0 || state.commit === undefined ? {} : { screenshots: { head: state.commit, images, newViews: handback.newViews ?? [] } }) };
}
