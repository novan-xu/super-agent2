import { readFileSync } from "node:fs";
import { type GeneratedText, Handback } from "@super-agent2/protocol";
import { z } from "zod";
import type { ProcessRunner } from "./git.js";

export interface PullRequestState {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly head: string;
  readonly closes: readonly number[];
}

export type PullRequestReader = (repository: string, number: number, environment: Readonly<Record<string, string>>, cwd: string) => Promise<PullRequestState | string>;

const PullRequestJson = z.looseObject({
  number: z.number().int(),
  url: z.string(),
  state: z.string(),
  headRefName: z.string(),
  closingIssuesReferences: z.array(z.looseObject({ number: z.number().int() })).default([]),
});

export function readPullRequestWith(run: ProcessRunner, gh: string): PullRequestReader {
  return async (repository, number, environment, cwd) => {
    const result = await run(gh, ["pr", "view", String(number), "--repo", repository, "--json", "number,url,state,headRefName,closingIssuesReferences"], {
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
        closes: parsed.closingIssuesReferences.map((issue) => issue.number),
      };
    } catch (error) {
      return `gh pr view ${number} gave an answer that could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

export type HandbackOutcome =
  | { readonly ok: true; readonly pullRequest: number; readonly url: string; readonly report: GeneratedText }
  | { readonly ok: false; readonly problem: string };

export interface HandbackCheck {
  readonly path: string;
  readonly repository: string;
  readonly branch: string;
  readonly issues: readonly number[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly read: PullRequestReader;
}

export async function checkHandback(check: HandbackCheck): Promise<HandbackOutcome> {
  let text: string;
  try {
    text = readFileSync(check.path, "utf8").replace(/^﻿/, "");
  } catch {
    return { ok: false, problem: `You have not handed back: there is no file at ${check.path}. Open the pull request if it is not open yet, then write that file as described in your task.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `The hand-back file ${check.path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Write it again.` };
  }
  const parsed = Handback.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `The hand-back file ${check.path} does not have the expected shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`).join("; ")}. It needs "pullRequest" (a number) and "summary" with "en" in English and "zh" in Simplified Chinese.`,
    };
  }
  const handback = parsed.data;
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
  const missing = check.issues.filter((issue) => !state.closes.includes(issue));
  if (missing.length > 0) {
    return {
      ok: false,
      problem: `Pull request #${handback.pullRequest} does not close ${missing.map((issue) => `#${issue}`).join(", ")}. Edit its body so that it has a line "Closes #<number>" for every issue of your task (gh pr edit ${handback.pullRequest} --body-file <file>), then write the hand-back file again.`,
    };
  }
  return { ok: true, pullRequest: state.number, url: state.url, report: handback.summary };
}
