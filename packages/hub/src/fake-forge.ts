export const fakeGitHubBase = "https://github.test";
export const fakeWoodpeckerServer = "https://woodpecker.test";

export interface FakePull {
  number: number;
  open: boolean;
  merged: boolean;
  head: string;
  headRef: string;
  base: string;
  mergeable: boolean | null;
  mergeCommit: string | null;
  files: { path: string; previous?: string }[];
  baseFiles: string[];
  closes: number[];
}

export interface FakeRepository {
  readonly pulls: Map<number, FakePull>;
  readonly issues: Map<number, "open" | "closed">;
  readonly trees: Map<string, string[]>;
  readonly texts: Map<string, string>;
  readonly mainline: string[];
  readonly branches: Set<string>;
  squash: boolean;
}

export interface FakeStep {
  id: number;
  name: string;
  state: string;
  exitCode: number | null;
}

export interface FakeWorkflow {
  name: string;
  state: string;
  steps: FakeStep[];
  agent?: number;
  started?: number;
}

export interface FakePipeline {
  number: number;
  commit: string;
  ref: string;
  event: string;
  status: string;
  workflows: FakeWorkflow[];
  config: string[];
  errors?: unknown;
  created?: number;
  finished?: number;
}

export interface FakeWoodpeckerRepository {
  id: number;
  active: boolean;
  configFile: string;
  pipelines: FakePipeline[];
}

export interface FakeForge {
  readonly fetch: typeof fetch;
  readonly github: Map<string, FakeRepository>;
  readonly woodpecker: Map<string, FakeWoodpeckerRepository>;
  readonly logs: Map<number, string[]>;
  readonly calls: string[];
  readonly merges: { repository: string; number: number; sha: string; method: string }[];
  beforePullRead: ((repository: string, pull: FakePull, reads: number) => void) | undefined;
  beforeMerge: ((repository: string, pull: FakePull) => void) | undefined;
  loseMergeAnswer: boolean;
  failing: RegExp | undefined;
  readonly closedMeanwhile: Set<number>;
  repository(name: string): FakeRepository;
  pull(name: string, number: number, head: string, files: readonly string[], ref?: string, closes?: readonly number[]): FakePull;
  tree(name: string, commit: string, paths: readonly string[]): void;
  file(name: string, commit: string, path: string, text: string): void;
  calledWith(pattern: RegExp): string[];
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pullJson(name: string, pull: FakePull): unknown {
  return {
    number: pull.number,
    state: pull.open ? "open" : "closed",
    merged: pull.merged,
    merged_at: pull.merged ? "2026-11-17T12:00:00Z" : null,
    merge_commit_sha: pull.mergeCommit,
    mergeable: pull.mergeable,
    html_url: `https://github.com/${name}/pull/${pull.number}`,
    head: { sha: pull.head, ref: pull.headRef, repo: { full_name: name } },
    base: { ref: pull.base },
  };
}

export function fakeForge(): FakeForge {
  const github = new Map<string, FakeRepository>();
  const woodpecker = new Map<string, FakeWoodpeckerRepository>();
  const logs = new Map<number, string[]>();
  const calls: string[] = [];
  const merges: FakeForge["merges"] = [];
  const pullReads = new Map<string, number>();

  const repositoryOf = (name: string): FakeRepository => {
    const found = github.get(name);
    if (found !== undefined) {
      return found;
    }
    const created: FakeRepository = { pulls: new Map(), issues: new Map(), trees: new Map(), texts: new Map(), mainline: [], branches: new Set(), squash: true };
    github.set(name, created);
    return created;
  };

  const forge: FakeForge = {
    github,
    woodpecker,
    logs,
    calls,
    merges,
    beforePullRead: undefined,
    beforeMerge: undefined,
    loseMergeAnswer: false,
    failing: undefined,
    closedMeanwhile: new Set(),
    repository: repositoryOf,
    pull: (name, number, head, files, ref, closes) => {
      const repository = repositoryOf(name);
      const pull: FakePull = {
        number,
        open: true,
        merged: false,
        head,
        headRef: ref ?? `sa2/ticket-${number}`,
        base: "main",
        mergeable: true,
        mergeCommit: null,
        files: files.map((path) => ({ path })),
        baseFiles: [],
        closes: [...(closes ?? repository.issues.keys())],
      };
      repository.pulls.set(number, pull);
      repository.branches.add(pull.headRef);
      return pull;
    },
    tree: (name, commit, paths) => {
      repositoryOf(name).trees.set(commit, [...paths]);
    },
    file: (name, commit, path, text) => {
      const repository = repositoryOf(name);
      const tree = repository.trees.get(commit) ?? [];
      if (!tree.includes(path)) {
        tree.push(path);
      }
      repository.trees.set(commit, tree);
      repository.texts.set(`${commit}:${path}`, text);
    },
    calledWith: (pattern) => calls.filter((call) => pattern.test(call)),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      const path = decodeURIComponent(url.pathname);
      calls.push(`${method} ${url.origin}${path}${url.search}`);
      if (forge.failing?.test(path) === true) {
        throw new TypeError("fetch failed");
      }
      if (url.origin === fakeGitHubBase) {
        return gitHub(method, path, url, init);
      }
      if (url.origin === fakeWoodpeckerServer) {
        return woodpeckerAnswer(path, url);
      }
      throw new TypeError(`fetch failed: nothing at ${url.origin}`);
    },
  };

  const closing = (init: RequestInit | undefined): Response => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { owner?: string; name?: string; number?: number } };
    const variables = body.variables ?? {};
    const name = `${variables.owner ?? ""}/${variables.name ?? ""}`;
    const pull = github.get(name)?.pulls.get(variables.number ?? 0);
    if (pull === undefined) {
      return json(200, { data: { repository: github.has(name) ? { pullRequest: null } : null }, errors: [{ message: "Could not resolve to a PullRequest" }] });
    }
    return json(200, {
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: pull.closes.map((number) => ({ number, repository: { nameWithOwner: name } })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  };

  const gitHub = (method: string, path: string, url: URL, init: RequestInit | undefined): Response => {
    if (path === "/graphql" && method === "POST") {
      return closing(init);
    }
    const match = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(path);
    if (match === null) {
      return json(404, { message: "Not Found" });
    }
    const name = match[1] ?? "";
    const rest = match[2] ?? "";
    const repository = github.get(name);
    if (repository === undefined) {
      return json(404, { message: "Not Found" });
    }
    if (rest === "") {
      return json(200, { allow_squash_merge: repository.squash, allow_merge_commit: true, allow_rebase_merge: true });
    }
    const pullMatch = /^pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
    if (pullMatch !== null) {
      const pull = repository.pulls.get(Number(pullMatch[1]));
      if (pull === undefined) {
        return json(404, { message: "Not Found" });
      }
      if (pullMatch[2] === undefined) {
        const key = `${name}#${pull.number}`;
        const reads = (pullReads.get(key) ?? 0) + 1;
        pullReads.set(key, reads);
        forge.beforePullRead?.(name, pull, reads);
        return json(200, pullJson(name, pull));
      }
      if (pullMatch[2] === "/files") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const size = Number(url.searchParams.get("per_page") ?? "30");
        return json(
          200,
          pull.files.slice((page - 1) * size, page * size).map((file) => ({ filename: file.path, ...(file.previous === undefined ? {} : { previous_filename: file.previous }) })),
        );
      }
      if (method !== "PUT") {
        return json(404, { message: "Not Found" });
      }
      forge.beforeMerge?.(name, pull);
      const body = JSON.parse(String(init?.body ?? "{}")) as { sha?: string; merge_method?: string };
      if (pull.merged || !pull.open) {
        return json(405, { message: "Pull Request is not mergeable" });
      }
      if (body.sha !== pull.head) {
        return json(409, { message: "Head branch was modified. Review and try the merge again." });
      }
      if (pull.mergeable === false) {
        return json(405, { message: "Pull Request is not mergeable" });
      }
      if (body.merge_method === "squash" && !repository.squash) {
        return json(405, { message: "Squash merges are not allowed on this repository." });
      }
      pull.merged = true;
      pull.open = false;
      pull.mergeCommit = `merge-of-${pull.head}`;
      merges.push({ repository: name, number: pull.number, sha: body.sha, method: body.merge_method ?? "merge" });
      repository.trees.set(pull.mergeCommit, [...(repository.trees.get(pull.head) ?? [])]);
      for (const [key, text] of [...repository.texts]) {
        const at = key.indexOf(":");
        if (key.slice(0, at) === pull.head) {
          repository.texts.set(`${pull.mergeCommit}:${key.slice(at + 1)}`, text);
        }
      }
      repository.mainline.push(pull.mergeCommit);
      if (forge.loseMergeAnswer) {
        forge.loseMergeAnswer = false;
        throw new TypeError("fetch failed: the connection was reset after the request was sent");
      }
      return json(200, { sha: pull.mergeCommit, merged: true, message: "Pull Request successfully merged" });
    }
    const compareMatch = /^compare\/(.+)\.\.\.(.+)$/.exec(rest);
    if (compareMatch !== null) {
      const pull = [...repository.pulls.values()].find((entry) => entry.head === compareMatch[1] && entry.base === compareMatch[2]);
      if (pull !== undefined) {
        return json(200, { files: pull.baseFiles.map((filename) => ({ filename })) });
      }
      const base = repository.mainline.indexOf(compareMatch[1] ?? "");
      const head = repository.mainline.indexOf(compareMatch[2] ?? "");
      if (base < 0 || head < 0) {
        return json(404, { message: "Not Found" });
      }
      return json(200, { status: head > base ? "ahead" : head < base ? "behind" : "identical", files: [] });
    }
    const commitMatch = /^commits\/(.+)$/.exec(rest);
    if (commitMatch !== null) {
      const ref = commitMatch[1] ?? "";
      const sha = repository.trees.has(ref) ? ref : ref === "main" || ref === "HEAD" ? repository.mainline.at(-1) : undefined;
      return sha === undefined ? json(422, { message: `No commit found for SHA: ${ref}` }) : json(200, { sha });
    }
    const issueMatch = /^issues\/(\d+)$/.exec(rest);
    if (issueMatch !== null) {
      const number = Number(issueMatch[1]);
      const state = repository.issues.get(number);
      if (state === undefined) {
        return json(404, { message: "Not Found" });
      }
      if (method === "PATCH") {
        const raced = state === "open" && forge.closedMeanwhile.delete(number);
        repository.issues.set(number, "closed");
        return raced ? json(422, { message: "Validation Failed" }) : json(200, { number, state: "closed" });
      }
      return json(200, { number, state });
    }
    const refMatch = /^git\/refs\/heads\/(.+)$/.exec(rest);
    if (refMatch !== null && method === "DELETE") {
      const branch = refMatch[1] ?? "";
      if (!repository.branches.delete(branch)) {
        return json(422, { message: "Reference does not exist" });
      }
      return new Response(null, { status: 204 });
    }
    const contentsMatch = /^contents\/(.+)$/.exec(rest);
    if (contentsMatch !== null) {
      const wanted = (contentsMatch[1] ?? "").replace(/\/+$/, "");
      const tree = repository.trees.get(url.searchParams.get("ref") ?? "") ?? [];
      if (tree.includes(wanted)) {
        const text = repository.texts.get(`${url.searchParams.get("ref") ?? ""}:${wanted}`) ?? "";
        return json(200, { type: "file", name: wanted.split("/").at(-1), path: wanted, encoding: "base64", content: Buffer.from(text).toString("base64") });
      }
      const inside = tree.filter((entry) => entry.startsWith(`${wanted}/`));
      if (inside.length === 0) {
        return json(404, { message: "Not Found" });
      }
      const children = new Map<string, string>();
      for (const entry of inside) {
        const [first, ...more] = entry.slice(wanted.length + 1).split("/");
        children.set(first ?? "", more.length === 0 ? "file" : "dir");
      }
      return json(
        200,
        [...children].map(([child, type]) => ({ name: child, path: `${wanted}/${child}`, type })),
      );
    }
    return json(404, { message: "Not Found" });
  };

  const woodpeckerAnswer = (path: string, url: URL): Response => {
    const lookup = /^\/api\/repos\/lookup\/(.+)$/.exec(path);
    if (lookup !== null) {
      const found = woodpecker.get(lookup[1] ?? "");
      return found === undefined ? json(404, null) : json(200, { id: found.id, full_name: lookup[1], active: found.active, config_file: found.configFile });
    }
    const byId = (id: string) => [...woodpecker.values()].find((entry) => entry.id === Number(id));
    const list = /^\/api\/repos\/(\d+)\/pipelines$/.exec(path);
    if (list !== null) {
      const found = byId(list[1] ?? "");
      if (found === undefined) {
        return json(404, null);
      }
      const ref = url.searchParams.get("ref") ?? "";
      const event = url.searchParams.get("event") ?? "";
      const size = Number(url.searchParams.get("perPage") ?? "50");
      const page = Number(url.searchParams.get("page") ?? "1");
      const matching = [...found.pipelines]
        .filter((pipeline) => pipeline.ref.startsWith(ref) && (event === "" || pipeline.event === event))
        .sort((a, b) => b.number - a.number)
        .slice((page - 1) * size, page * size);
      return json(
        200,
        matching.map((pipeline) => ({
          number: pipeline.number,
          commit: pipeline.commit,
          ref: pipeline.ref,
          event: pipeline.event,
          status: pipeline.status,
          created: pipeline.created ?? 0,
          finished: pipeline.finished ?? 0,
        })),
      );
    }
    const one = /^\/api\/repos\/(\d+)\/pipelines\/(\d+)(\/config)?$/.exec(path);
    if (one !== null) {
      const pipeline = byId(one[1] ?? "")?.pipelines.find((entry) => entry.number === Number(one[2]));
      if (pipeline === undefined) {
        return json(404, null);
      }
      if (one[3] === "/config") {
        return json(
          200,
          pipeline.config.map((name) => ({ hash: name, name, data: "" })),
        );
      }
      return json(200, {
        number: pipeline.number,
        status: pipeline.status,
        commit: pipeline.commit,
        errors: pipeline.errors ?? null,
        created: pipeline.created ?? 0,
        started: pipeline.created ?? 0,
        finished: pipeline.finished ?? 0,
        workflows: pipeline.workflows.map((workflow) => ({
          name: workflow.name,
          state: workflow.state,
          agent_id: workflow.agent ?? 0,
          started: workflow.started ?? 0,
          children: workflow.steps.map((step) => ({ id: step.id, name: step.name, state: step.state, exit_code: step.exitCode ?? 0 })),
        })),
      });
    }
    const log = /^\/api\/repos\/(\d+)\/logs\/(\d+)\/(\d+)$/.exec(path);
    if (log !== null) {
      const lines = logs.get(Number(log[3])) ?? [];
      return json(
        200,
        lines.map((line, index) => ({ line: index, data: Buffer.from(line).toString("base64") })),
      );
    }
    return json(404, null);
  };

  return forge;
}
