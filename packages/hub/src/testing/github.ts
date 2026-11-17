import { readFileSync } from "node:fs";
import type { Job, Target } from "../targets.js";

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  pullRequest: boolean;
}

export interface FakeGitHub extends Target {
  readonly repositories: Map<string, FakeIssue[]>;
  readonly jobs: Job[];
  failAfterCreate: number;
  created: number;
}

function json(repository: string, issue: FakeIssue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    html_url: `https://github.com/${repository}/${issue.pullRequest ? "pull" : "issues"}/${issue.number}`,
    state: issue.state,
    ...(issue.pullRequest ? { pull_request: { url: "x" } } : {}),
  };
}

export function fakeGitHub(name = "hub"): FakeGitHub {
  const fake: FakeGitHub = {
    name,
    repositories: new Map(),
    jobs: [],
    failAfterCreate: 0,
    created: 0,
    run: (job, sink) => {
      fake.jobs.push(job);
      const answer = (code: number, out: string, err = "") => {
        if (out !== "") {
          sink("stdout", Buffer.from(out));
        }
        if (err !== "") {
          sink("stderr", Buffer.from(err));
        }
        return { ended: Promise.resolve({ exitCode: code, signal: null }), stop: () => Promise.resolve() };
      };
      const create = /^gh api "repos\/([^"]+)\/issues" --method POST --input "([^"]+)"$/.exec(job.command);
      const list = /^gh api "repos\/([^"]+)\/issues\?[^"]*"$/.exec(job.command);
      const read = /^gh api "repos\/([^"]+)\/issues\/(\d+)"$/.exec(job.command);
      const repository = (create ?? list ?? read)?.[1];
      if (repository === undefined) {
        return answer(1, "", `unknown command ${job.command}\n`);
      }
      const issues = fake.repositories.get(repository);
      if (issues === undefined) {
        return answer(1, "", "gh: Not Found (HTTP 404)\n");
      }
      if (create !== null) {
        const input = JSON.parse(readFileSync(create[2] ?? "", "utf8")) as { title: string; body: string };
        const issue: FakeIssue = { number: issues.length + 1, title: input.title, body: input.body, state: "open", pullRequest: false };
        issues.push(issue);
        fake.created += 1;
        if (fake.failAfterCreate > 0) {
          fake.failAfterCreate -= 1;
          return answer(1, "", "connection reset after the request was sent\n");
        }
        return answer(0, JSON.stringify(json(repository, issue)));
      }
      if (read !== null) {
        const issue = issues.find((entry) => entry.number === Number(read[2]));
        return issue === undefined ? answer(1, "", "gh: Not Found (HTTP 404)\n") : answer(0, JSON.stringify(json(repository, issue)));
      }
      return answer(0, JSON.stringify([...issues].reverse().map((issue) => json(repository, issue))));
    },
  };
  return fake;
}
