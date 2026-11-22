import { RepositoryName } from "@super-agent2/protocol";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import { gitHubApiBase, type Fetch } from "./github-api.js";
import type { RepositoryAccounts } from "./repositories.js";
import type { TopicContext } from "./topic-context.js";
import { topicCall } from "./topic-tools.js";

const query = z.string().trim().min(1).max(300);
const repository = RepositoryName;
const page = z.number().int().min(1).max(100).optional();
const number = z.number().int().positive();
const state = z.enum(["open", "closed", "all"]).optional();
const path = z.string().max(1024).refine((value) => value === "" || value.split("/").every((part) =>
  part !== "" && part !== "." && part !== ".." && !/[\\\p{Cc}]/u.test(part)));
const search = query.refine((value) => !/[:"]/u.test(value));
const repo = { repository };
const list = { repository, state, page };

const tools = {
  search_conversations: ["Search literal text across all topics, including archived ones.", z.strictObject({
    query, before: z.number().int().positive().optional(),
  })],
  read_conversation_message: ["Read a message returned by conversation search. Use nextOffset to read more.", z.strictObject({
    id: z.string().min(1).max(256), offset: z.number().int().nonnegative().optional(),
  })],
  list_repositories: ["List the repositories available to this call.", z.strictObject({})],
  read_repository_file: ["Read a text file or list a directory. Use an empty path for the root and nextOffset for more file text.", z.strictObject({
    ...repo, path, ref: z.string().min(1).max(256).optional(), offset: z.number().int().nonnegative().optional(),
  })],
  search_repository_code: ["Search code in a single repository using plain search terms.", z.strictObject({ ...repo, query: search, page })],
  list_issues: ["List GitHub issues in one repository. Pass page for more results.", z.strictObject(list)],
  read_issue: ["Read one GitHub issue by number.", z.strictObject({ ...repo, number })],
  list_pull_requests: ["List pull requests in one repository. Pass page for more results.", z.strictObject(list)],
  read_pull_request: ["Read one pull request by number.", z.strictObject({ ...repo, number })],
  submit_summary: ["Propose the agreed summary for the owner's final confirmation. It is sent only after the owner confirms in the app.", z.strictObject({
    summary: z.string().trim().min(1).max(16_000),
  })],
} as const;

type ToolName = keyof typeof tools;

export const voiceToolDefinitions = Object.entries(tools).map(([name, [description, schema]]) => ({
  type: "function" as const, name, description, parameters: z.toJSONSchema(schema, { io: "input" }), strict: false,
}));

export function parseVoiceTool(name: string, raw: unknown) {
  if (!Object.hasOwn(tools, name)) return undefined;
  const known = name as ToolName;
  const parsed = tools[known][1].safeParse(raw);
  if (!parsed.success) return undefined;
  return { name: known, args: parsed.data } as {
    [T in ToolName]: { name: T; args: z.output<(typeof tools)[T][1]> }
  }[ToolName];
}

const entry = z.object({
  number, title: z.string().max(1024), html_url: z.string(), state: z.string(),
  body: z.string().nullable().optional(), pull_request: z.unknown().optional(), merged_at: z.string().nullable().optional(),
});
const files = z.array(z.object({ name: z.string(), path: z.string(), type: z.string() }));
const file = z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string() });
const matches = z.object({ items: z.array(z.object({
  path: z.string(), html_url: z.string(), repository: z.object({ full_name: z.string() }),
  text_matches: z.array(z.object({ fragment: z.string() })).optional(),
})) });

export interface VoiceToolSources {
  readonly repositories: RepositoryAccounts;
  readonly topics: TopicContext;
  readonly credentials: CredentialSource;
  readonly fetch: Fetch;
  readonly base?: string | undefined;
}

export async function voiceRead(sources: VoiceToolSources, { name, args }: Exclude<NonNullable<ReturnType<typeof parseVoiceTool>>, { name: "submit_summary" }>) {
  if (name === "search_conversations") {
    return topicCall(sources.topics, undefined, "search_topic_history", { ...args, limit: 10 }, undefined);
  }
  if (name === "read_conversation_message") {
    return topicCall(sources.topics, undefined, "read_topic_history", { message: args.id, offset: args.offset }, undefined);
  }
  const known = sources.repositories.list();
  if (name === "list_repositories") return known.map(({ repository, alias }) => ({ repository, alias }));
  const found = known.find(({ repository }) => repository.toLowerCase() === args.repository.toLowerCase());
  if (found === undefined) return undefined;
  const credentials = sources.credentials(found.account);
  const token = credentials.ok ? credentials.credentials.GH_TOKEN : undefined;
  if (token === undefined) return { error: "GitHub credentials are unavailable for this repository." };

  const prefix = `/repos/${found.repository}`;
  const read = async (path: string, parameters: Record<string, string> = {}, accept = "application/vnd.github+json"): Promise<unknown> => {
    const url = new URL(`${sources.base ?? gitHubApiBase}${path}`);
    url.search = new URLSearchParams(parameters).toString();
    const response = await sources.fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { accept, authorization: `Bearer ${token}`, "user-agent": "super-agent2-hub", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const data: unknown = await response.json();
    if (JSON.stringify(data).includes(token)) throw new Error("GitHub returned credentials in its response.");
    return data;
  };

  switch (name) {
    case "read_repository_file": {
      const path = args.path.split("/").map(encodeURIComponent).join("/");
      const data = await read(`${prefix}/contents/${path}`, args.ref === undefined ? {} : { ref: args.ref });
      if (Array.isArray(data)) {
        const entries = files.parse(data);
        const offset = args.offset ?? 0;
        return { entries: entries.slice(offset, offset + 40), nextOffset: offset + 40 < entries.length ? offset + 40 : null };
      }
      const content = Buffer.from(file.parse(data).content, "base64").toString("utf8");
      if (content.includes(token)) throw new Error("GitHub returned credentials in its response.");
      const offset = args.offset ?? 0;
      return { text: content.slice(offset, offset + 8_000), nextOffset: offset + 8_000 < content.length ? offset + 8_000 : null };
    }
    case "search_repository_code": {
      const data = matches.parse(await read("/search/code", {
        q: `${args.query} repo:${found.repository}`, per_page: "10", page: String(args.page ?? 1),
      }, "application/vnd.github.text-match+json"));
      return data.items.filter(({ repository }) => repository.full_name.toLowerCase() === found.repository.toLowerCase())
        .map(({ path, html_url, text_matches }) => ({ path, html_url, snippets: text_matches?.slice(0, 2).map(({ fragment }) => fragment.slice(0, 500)) }));
    }
    case "list_issues":
    case "list_pull_requests": {
      const issues = name === "list_issues";
      const entries = z.array(entry).parse(await read(`${prefix}/${issues ? "issues" : "pulls"}`, {
        state: args.state ?? "open", per_page: "20", page: String(args.page ?? 1),
      }));
      return { entries: entries.filter((item) => !issues || item.pull_request === undefined)
        .map(({ number, title, state, html_url }) => ({ number, title, state, html_url })),
      nextPage: entries.length === 20 && (args.page ?? 1) < 100 ? (args.page ?? 1) + 1 : null };
    }
    case "read_issue":
    case "read_pull_request": {
      const issues = name === "read_issue";
      const item = entry.parse(await read(`${prefix}/${issues ? "issues" : "pulls"}/${args.number}`));
      if (issues && item.pull_request !== undefined) return { error: "Use read_pull_request for this number." };
      const { number, title, state, html_url, body, merged_at } = item;
      return { number, title, state, html_url, body: body?.slice(0, 12_000), merged_at };
    }
  }
}
