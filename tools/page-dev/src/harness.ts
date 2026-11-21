import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type AccessServiceTokens, createPushDevice, type FakeForge, type Hub, type PushDevice, receivePush, type SubscriptionAdjustment, type Target } from "@super-agent2/hub";
import type { Behaviour, HandBack, ScriptedRunners } from "./scripted.js";
import { AllowanceProgram, AllowanceState, allowancePrograms, brainToolsPath, conversationHeader, deploymentFile, ProgramId, readDeploymentFile, type Subscriptions, TicketState } from "@super-agent2/protocol";

export const demoTargetName = "demo";

export interface AllowanceForcing {
  readonly adjust: SubscriptionAdjustment;
  force(program: AllowanceProgram, state: AllowanceState | null): void;
  forced(): Partial<Record<AllowanceProgram, AllowanceState>>;
}

export function createAllowanceForcing(): AllowanceForcing {
  const forced = new Map<AllowanceProgram, AllowanceState>();
  return {
    adjust: (subscriptions: Subscriptions): Subscriptions => {
      const adjusted = { ...subscriptions };
      for (const [program, state] of forced) {
        adjusted[program] = { ...subscriptions[program], state, remainingPercent: state === "exhausted" ? 0 : subscriptions[program].remainingPercent };
      }
      return adjusted;
    },
    force: (program, state) => {
      if (state === null) {
        forced.delete(program);
      } else {
        forced.set(program, state);
      }
    },
    forced: () => Object.fromEntries(forced),
  };
}

export function forgeHandBack(forge: FakeForge, hub: () => Hub | undefined, deployments: ReadonlyMap<string, string> = new Map()): (given: HandBack) => void {
  let pipelines = 0;
  return (given) => {
    const head = createHash("sha1").update(`${given.ticket}:${given.attempt}:${Date.now()}`).digest("hex");
    const repository = forge.repository(given.repository);
    for (const issue of hub()?.tickets.get(given.ticket)?.issues ?? []) {
      if (!repository.issues.has(issue.number)) {
        repository.issues.set(issue.number, "open");
      }
    }
    const pull = repository.pulls.get(given.pullRequest);
    if (pull === undefined) {
      forge.pull(given.repository, given.pullRequest, head, ["src/parser.ts"], given.branch, given.closes);
    } else {
      pull.head = head;
    }
    forge.tree(given.repository, head, ["src/parser.ts", ".woodpecker/check.yaml"]);
    const declared = deployments.get(given.repository);
    if (declared !== undefined) {
      forge.file(given.repository, head, deploymentFile, declared);
    }
    const woodpecker = forge.woodpecker.get(given.repository) ?? { id: 100 + forge.woodpecker.size, active: true, configFile: "", pipelines: [] };
    forge.woodpecker.set(given.repository, woodpecker);
    const red = given.behaviour === "red-always" || (given.behaviour === "red-once" && given.attempt === 1) || (given.behaviour === "red-second" && given.piece > 1);
    pipelines += 1;
    const step = 5000 + pipelines;
    woodpecker.pipelines.push({
      number: pipelines,
      commit: head,
      ref: `refs/pull/${given.pullRequest}/merge`,
      event: "pull_request",
      status: red ? "failure" : "success",
      workflows: [
        {
          name: "check",
          state: red ? "failure" : "success",
          steps: [
            { id: step - 1000, name: "clone", state: "success", exitCode: 0 },
            { id: step, name: "test", state: red ? "failure" : "success", exitCode: red ? 1 : 0 },
          ],
        },
      ],
      config: ["check"],
    });
    forge.logs.set(step, [
      "+ pnpm test",
      ...Array.from({ length: 600 }, (_, index) => ` ✓ src/notes.test.ts > keeps note ${index + 1} as it was written`),
      ...(red ? [" FAIL src/parser.test.ts > parses relative dates", "AssertionError: expected '2026-11-18' to be '2026-11-17'", " Test Files  1 failed | 12 passed (13)"] : [" Test Files  13 passed (13)"]),
    ]);
  };
}

export function demoTarget(): Target {
  return {
    name: demoTargetName,
    run: (job, sink) => {
      sink("stdout", Buffer.from(`pretend run, nothing executed: ${job.command}\n`));
      return { ended: Promise.resolve({ exitCode: 0, signal: null }), stop: () => Promise.resolve() };
    },
  };
}

const heldCommands: Readonly<Record<string, string>> = {
  repo: "gh repo delete novan-xu/old-experiments --yes",
  branch: "git push --force origin main",
  data: "docker volume rm super-agent-data",
  file: "rm -rf /srv/other/notes",
  long: [
    "set -euo pipefail",
    "cd /srv/projects/app",
    "for repo in alpha beta gamma; do",
    '  echo "checking $repo"',
    "  git -C \"$repo\" fetch --all --prune",
    "done",
    "gh repo delete novan-xu/old-experiments --yes && echo done-with-a-very-long-line-that-keeps-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going",
  ].join("\n"),
  hidden: "gh repo delete novan-xu/old-experiments --yes # ​‮ done",
};

interface Planned {
  readonly name: string;
  readonly repository: string | null;
  readonly titles: readonly (readonly [string, string])[];
  readonly title: readonly [string, string];
  readonly behaviour: Behaviour;
  readonly machine: string;
  readonly engine: ProgramId;
  readonly model?: string;
  readonly effort?: string;
  readonly after?: string;
  readonly task?: string;
  readonly decision?: {
    readonly chosen: GeneratedTextShape;
    readonly why: GeneratedTextShape;
    readonly other_options: GeneratedTextShape;
  };
}

const chainDecision: NonNullable<Planned["decision"]> = {
  chosen: { en: "Put the three date issues on one chain, in the order parse, relative, show", zh: "三个日期问题排成一条链，顺序是解析、相对日期、显示" },
  why: { en: "They touch the same parser and each builds on the one before", zh: "它们改的是同一个解析器，后一个建立在前一个上" },
  other_options: { en: "Three chains in parallel, which would conflict in the parser", zh: "拆成三条并行的链，会在解析器上冲突" },
};

const scenarioPlan: readonly Planned[] = [
  {
    name: "parser",
    repository: "novan-xu/garden-notes",
    title: ["Parse dates in notes", "解析笔记里的日期"],
    titles: [
      ["Parse plain dates", "解析普通日期"],
      ["Parse relative dates", "解析相对日期"],
      ["Show parsed dates", "显示解析出的日期"],
    ],
    behaviour: "long",
    machine: "studio",
    engine: "codex",
    model: "gpt-6-luna",
    effort: "medium",
  },
  { name: "export", repository: "novan-xu/garden-notes", title: ["Export notes", "导出笔记"], titles: [["Export notes as Markdown", "把笔记导出成 Markdown"]], behaviour: "finish", machine: "studio", engine: "claude", after: "parser" },
  { name: "sync", repository: "nuofan-island/plant-log", title: ["Sync the log", "同步植物日志"], titles: [["Sync the log across devices", "在设备间同步日志"]], behaviour: "fail", machine: "studio", engine: "claude" },
  { name: "photos", repository: "nuofan-island/plant-log", title: ["Attach photos", "给日志加照片"], titles: [["Attach photos to entries", "给条目附上照片"]], behaviour: "finish", machine: "mini", engine: "codex" },
  { name: "water", repository: "novan-xu/garden-notes", title: ["Watering reminders", "浇水提醒"], titles: [["Remind me to water", "提醒浇水"]], behaviour: "long", machine: "mini", engine: "claude" },
  {
    name: "notice",
    repository: null,
    title: ["Notice for neighbours", "给邻居的通知"],
    titles: [],
    behaviour: "deliver",
    machine: "studio",
    engine: "antigravity",
    task: "Write a short notice for the neighbours that the garden gate is repainted on Saturday morning.",
  },
  { name: "untasked", repository: null, title: ["Thank-you card", "写一张感谢卡"], titles: [], behaviour: "deliver", machine: "studio", engine: "antigravity" },
];

const historyRepositories: readonly string[] = ["novan-xu/garden-notes", "nuofan-island/plant-log"];

const historyTopics: readonly (readonly [string, string])[] = [
  ["Parse relative dates", "解析相对日期"],
  ["Export notes as Markdown", "把笔记导出成 Markdown"],
  ["Sync the log across devices", "在设备间同步日志"],
  ["Attach photos to entries", "给条目附上照片"],
  ["Remind me to water", "提醒浇水"],
  ["Search inside notes", "在笔记里搜索"],
  ["Dark theme for the editor", "编辑器的深色主题"],
  ["Back up to an external disk", "备份到外接硬盘"],
  ["Count the days since watering", "数一数距离上次浇水过了几天"],
  ["Group plants by room", "按房间给植物分组"],
];

const historyStopReasons: readonly GeneratedTextShape[] = [
  { en: "The owner stopped it", zh: "你停止了它" },
  { en: "The owner gave it up after its guided rounds reached the cap", zh: "引导到上限后，你放弃了它" },
  { en: "Superseded by a newer ticket", zh: "被更新的工单取代了" },
];

interface GeneratedTextShape {
  readonly en: string;
  readonly zh: string;
}

interface Device {
  readonly id: string;
  readonly keys: PushDevice;
  gone: boolean;
}

interface Received {
  readonly device: string;
  readonly text: string;
}

export interface Harness {
  handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean>;
}

export interface HarnessOptions {
  readonly hub: Hub;
  readonly publicUrl: string;
  readonly hubUrl: string;
  readonly assertion: () => Promise<string>;
  readonly allowance: AllowanceForcing;
  readonly brainToken: () => string;
  readonly scripted: ScriptedRunners;
  readonly deployments?: Map<string, string>;
  readonly forge?: FakeForge;
  readonly cloudflare?: FakeServiceTokens;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${text}\n`);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

export interface FakeServiceTokens {
  readonly tokens: AccessServiceTokens;
  failRemove: boolean;
  failCreate: boolean;
  readonly made: string[];
  admits(clientId: string, clientSecret: string): boolean;
}

export function fakeServiceTokens(): FakeServiceTokens {
  const known = new Map<string, { readonly id: string; readonly secret: string; removed: boolean }>();
  const fake: FakeServiceTokens = {
    failRemove: false,
    failCreate: false,
    made: [],
    admits: (clientId, clientSecret) => {
      const token = known.get(clientId);
      return token === undefined || (!token.removed && token.secret === clientSecret);
    },
    tokens: {
      create: (name) => {
        if (fake.failCreate) {
          return Promise.reject(new Error("Cloudflare refused to create the service token (HTTP 403): the harness's Cloudflare refuses to create"));
        }
        fake.made.push(name);
        const token = { id: randomUUID(), clientId: `${randomBytes(16).toString("hex")}.access`, clientSecret: randomBytes(32).toString("hex"), expiresAt: null };
        known.set(token.clientId, { id: token.id, secret: token.clientSecret, removed: false });
        return Promise.resolve(token);
      },
      remove: (id) => {
        if (fake.failRemove) {
          return Promise.reject(new Error("The harness's Cloudflare refuses to delete"));
        }
        for (const token of known.values()) {
          if (token.id === id) {
            token.removed = true;
          }
        }
        return Promise.resolve();
      },
    },
  };
  return fake;
}

export function createHarness(options: HarnessOptions): Harness {
  const devices = new Map<string, Device>();
  const received: Received[] = [];

  const hold = (url: URL, response: ServerResponse): void => {
    const kind = url.searchParams.get("kind") ?? "repo";
    const command = url.searchParams.get("command") ?? heldCommands[kind];
    if (command === undefined) {
      json(response, 400, { error: "kind must be one of", kinds: Object.keys(heldCommands) });
      return;
    }
    const cwd = url.searchParams.get("cwd");
    const target = url.searchParams.get("target") ?? demoTargetName;
    const record = options.hub.commands.start({ target, command, ...(cwd === null ? {} : { cwd }) });
    json(response, 200, { id: record.id, state: record.state, command });
  };

  const moveTicket = (url: URL, response: ServerResponse): void => {
    const id = Number(url.searchParams.get("id"));
    const to = TicketState.safeParse(url.searchParams.get("to"));
    if (!Number.isInteger(id) || id <= 0 || !to.success) {
      json(response, 400, { error: "give id=<ticket> and to=<state>" });
      return;
    }
    const result = options.hub.tickets.move(id, to.data);
    json(response, result.ok ? 200 : 409, result.ok ? { id, state: result.ticket.state } : { id, error: result.error, state: result.ticket?.state ?? null });
  };

  const callTool = async (name: string, args: Record<string, unknown>, conversation?: string): Promise<{ readonly text: string; readonly isError: boolean }> => {
    const answer = await fetch(`${options.hubUrl}${brainToolsPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.brainToken()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(conversation === undefined ? {} : { [conversationHeader]: conversation }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await answer.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    return { text: (body.result?.content ?? []).map((part) => part.text ?? "").join("\n"), isError: body.result?.isError === true };
  };

  const startWork = async (url: URL, response: ServerResponse): Promise<void> => {
    const repository = url.searchParams.get("repository") ?? "";
    const issues = (url.searchParams.get("issues") ?? "").split(",").map(Number).filter((number) => Number.isInteger(number) && number > 0);
    const machine = url.searchParams.get("machine");
    const engine = ProgramId.safeParse(url.searchParams.get("engine"));
    const model = url.searchParams.get("model");
    const effort = url.searchParams.get("effort");
    if (repository === "" || issues.length === 0 || machine === null || !engine.success || model === null || effort === null) {
      json(response, 400, { error: "give repository=, issues=1,2, machine=, engine=, model= and effort=" });
      return;
    }
    const steps: { readonly step: string; readonly text: string }[] = [];
    const call = async (name: string, args: Record<string, unknown>): Promise<string | undefined> => {
      const result = await callTool(name, args);
      steps.push({ step: name, text: result.text });
      return result.isError ? undefined : result.text;
    };
    const opened: number[] = [];
    for (const issue of issues) {
      const text = await call("open_ticket", {
        repository,
        issue,
        title_zh: `测试问题 ${issue}`,
        summary: { en: `A small test issue, #${issue}`, zh: `一个很小的测试问题 ${issue}` },
        kind: "fix",
        platform: "any",
      });
      const ticket = text === undefined ? undefined : /ticket (\d+)/.exec(text)?.[1];
      if (ticket === undefined) {
        json(response, 409, { error: "open_ticket failed", steps });
        return;
      }
      opened.push(Number(ticket));
    }
    let ticket = Math.min(...opened);
    const after = Number(url.searchParams.get("after") ?? "0");
    if (issues.length > 1 || after > 0) {
      const arranged = await call("arrange_chains", {
        chains: [
          {
            name: "test",
            repository,
            issues,
            ...(after > 0 ? { after: [after] } : {}),
            ...(issues.length > 1 ? { title: { en: `Test chain of ${issues.length} issues`, zh: `${issues.length} 个问题的测试链` }, summary: { en: "A chain of small test issues", zh: "几个小测试问题组成的链" } } : {}),
          },
        ],
      });
      if (arranged === undefined) {
        json(response, 409, { error: "arrange_chains failed", steps });
        return;
      }
      const wanted = new Set(issues);
      const pending = options.hub.tickets
        .list({ open: true })
        .find((entry) => entry.state === "pending" && entry.repository === repository && entry.issues.length === issues.length && entry.issues.every((issue) => wanted.has(issue.number)));
      ticket = pending?.id ?? ticket;
    }
    const stated = await call("choose_defaults", {
      chains: [
        {
          ticket,
          kind: "fix",
          issues: issues.map((number) => ({ number, difficulty: "mechanical" })),
          reason: { en: "A tiny test task", zh: "很小的测试任务" },
          platform: "any",
          engine: engine.data === "claude" ? "claude" : "codex",
        },
      ],
    });
    if (stated === undefined) {
      json(response, 409, { error: "choose_defaults failed", steps });
      return;
    }
    const assertion = await options.assertion();
    const chosen = await options.hub.chains.starter.choose({ assertion, ticket, change: { machine, engine: engine.data, model, effort } });
    if (!chosen.ok) {
      json(response, 409, { error: `choice refused: ${chosen.error}`, steps });
      return;
    }
    const card = options.hub.chains.cards().find((entry) => entry.ticket.id === ticket);
    if (card === undefined) {
      json(response, 409, { error: "no start card", steps });
      return;
    }
    const started = await options.hub.chains.starter.start({ assertion, chains: [{ ticket, fingerprint: card.fingerprint }] });
    json(response, started.ok ? 200 : 409, { ticket, started: started.ok ? started.tickets.map((entry) => ({ id: entry.id, state: entry.state })) : started.error, steps });
  };

  const openWriting = async (url: URL, response: ServerResponse): Promise<void> => {
    const task = url.searchParams.get("task");
    const material = url.searchParams.get("text");
    const conversation = url.searchParams.get("conversation") ?? undefined;
    if (task === null) {
      json(response, 400, { error: "give task= (in English) and optionally text= (the material, pasted) and conversation=<id>" });
      return;
    }
    const steps: { readonly step: string; readonly text: string }[] = [];
    const opened = await callTool(
      "open_task_ticket",
      {
        title: { en: "A test piece of writing", zh: "测试写作" },
        summary: { en: "A tiny writing task for testing", zh: "一个很小的写作测试任务" },
        task,
        kind: "writing",
        ...(material === null ? {} : { material: [{ name: "material.txt", source: "pasted by the owner in the conversation", text: material }] }),
      },
      conversation,
    );
    steps.push({ step: "open_task_ticket", text: opened.text });
    const ticket = opened.isError ? undefined : /task ticket (\d+)/.exec(opened.text)?.[1];
    if (ticket === undefined) {
      json(response, 409, { error: "open_task_ticket failed", steps });
      return;
    }
    const stated = await callTool("choose_defaults", {
      chains: [{ ticket: Number(ticket), kind: "writing", reason: { en: "A tiny writing task", zh: "很小的写作任务" }, platform: "any" }],
    });
    steps.push({ step: "choose_defaults", text: stated.text });
    json(response, stated.isError ? 409 : 200, { ticket: Number(ticket), steps });
  };

  let nextIssue = 1000 + Math.floor(Math.random() * 8000);

  const loopCases: Readonly<Record<string, Behaviour>> = { fixed: "red-once", red: "red-always", stuck: "fails", worker: "fail", green: "finish", chain: "red-once", repair: "red-second" };

  const loopCase = async (url: URL, response: ServerResponse): Promise<void> => {
    const name = url.searchParams.get("case") ?? "";
    const behaviour = loopCases[name];
    if (behaviour === undefined) {
      json(response, 400, {
        error:
          "give case=fixed (red pipeline once, then green), red (red pipeline every round), stuck (the worker fails every round), worker (the worker fails once), green (green at once), chain (three issues in two pull requests, the first red once), or repair (three issues in two pull requests, the first merged and the second red every round until the ticket is stuck; give it up on its card and start the repair ticket, which goes green to the end), and optionally repository=<owner/name>",
        cases: Object.keys(loopCases),
      });
      return;
    }
    nextIssue += 1;
    await startPlans(
      [
        {
          name,
          repository: url.searchParams.get("repository") ?? "novan-xu/garden-notes",
          title: [`Failure loop: ${name}`, `失败循环：${name}`],
          titles:
            name === "chain" || name === "repair"
              ? [
                  ["Parse plain dates", "解析普通日期"],
                  ["Parse relative dates", "解析相对日期"],
                  ["Show parsed dates", "显示解析出的日期"],
                ]
              : [[`Parse relative dates (${name})`, `解析相对日期（${name}）`]],
          behaviour,
          machine: "studio",
          engine: "claude",
          ...(name === "chain" || name === "repair" ? { decision: chainDecision } : {}),
        },
      ],
      response,
    );
  };

  const scenario = (response: ServerResponse): Promise<void> => startPlans(scenarioPlan, response);

  const arrangeDeployment = async (url: URL, response: ServerResponse): Promise<void> => {
    const forge = options.forge;
    const repository = url.searchParams.get("repository") ?? "novan-xu/garden-notes";
    if (forge === undefined || options.deployments === undefined) {
      json(response, 400, { error: "needs --forge fake: the chain merges in the fake forge, and the deployment file is read from it" });
      return;
    }
    options.scripted.connect();
    const recipe = JSON.stringify({ target: "studio", deploy: "node scripts/deploy.mjs", health: { command: "curl -fsS http://127.0.0.1:8080/health" }, rollback: "node scripts/rollback.mjs" });
    const known = forge.repository(repository);
    const head = createHash("sha1").update(`${repository}:${Date.now()}`).digest("hex");
    known.mainline.push(head);
    forge.tree(repository, head, ["src/parser.ts"]);
    forge.file(repository, head, deploymentFile, recipe);
    options.deployments.set(repository, recipe);
    nextIssue += 1;
    known.issues.set(nextIssue, "open");
    const chain = options.hub.tickets.open({
      repository,
      issues: [{ repository, number: nextIssue, url: `https://github.com/${repository}/issues/${nextIssue}`, title: { en: "Show the next watering day", zh: "显示下次浇水的日子" }, summary: { en: "Show it on the front page", zh: "在首页显示" } }],
      title: { en: "Show the next watering day", zh: "显示下次浇水的日子" },
      summary: { en: "Show it on the front page", zh: "在首页显示" },
      kind: "feature",
    });
    options.scripted.behave(chain.id, "finish");
    const steps: { readonly step: string; readonly text: string }[] = [];
    const opened = await callTool("open_task_ticket", {
      title: { en: `Deploy ${repository}`, zh: `部署 ${repository}` },
      summary: { en: "Deploy the merged change by the repository's deployment file", zh: "按仓库的部署配置部署合并后的改动" },
      task: "Deploy the repository at the commit of your checkout by its deployment file, check its health, roll back if the new version does not come up, and report what happened.",
      kind: "operation",
      repository,
      deploy: true,
      after: [chain.id],
    });
    steps.push({ step: "open_task_ticket", text: opened.text });
    const deployment = opened.isError ? undefined : Number(/task ticket (\d+)/.exec(opened.text)?.[1]);
    if (deployment === undefined || Number.isNaN(deployment)) {
      json(response, 409, { error: "open_task_ticket failed", steps });
      return;
    }
    const stated = await callTool("choose_defaults", {
      chains: [
        { ticket: chain.id, kind: "feature", issues: [{ number: nextIssue, difficulty: "standard" }], reason: { en: "A small change on one page", zh: "一个页面上的小改动" }, platform: "any", engine: "claude" },
        { ticket: deployment, kind: "operation", difficulty: "mechanical", reason: { en: "A deployment by a known recipe", zh: "按现成配方部署" }, platform: "any", engine: "claude" },
      ],
    });
    steps.push({ step: "choose_defaults", text: stated.text });
    json(response, stated.isError ? 409 : 200, { chain: chain.id, deployment, steps });
  };

  const fillHistory = (url: URL, response: ServerResponse): void => {
    const asked = Number(url.searchParams.get("count") ?? "70");
    const count = Number.isInteger(asked) && asked >= 1 && asked <= 500 ? asked : undefined;
    if (count === undefined) {
      json(response, 400, { error: "give count= between 1 and 500: how many ended tickets to add, across two repositories, newest first, about a hundred minutes apart" });
      return;
    }
    const { tickets, database } = options.hub;
    const now = Date.now();
    const backdate = database.connection.prepare("UPDATE tickets SET created_at = ?, updated_at = ?, ended_at = ? WHERE id = ?");
    const backdateMoves = database.connection.prepare(
      "UPDATE ticket_moves SET at = ? - ((SELECT MAX(seq) FROM ticket_moves AS last WHERE last.ticket_id = ticket_moves.ticket_id) - seq) * 60000 WHERE ticket_id = ?",
    );
    const kinds = ["fix", "feature", "parameter", "maintenance", "refactor"] as const;
    const added: { readonly id: number; readonly state: string }[] = [];
    for (let index = 0; index < count; index += 1) {
      const [en, zh] = historyTopics[index % historyTopics.length] ?? historyTopics[0] ?? ["", ""];
      const round = Math.floor(index / historyTopics.length) + 1;
      const label: readonly [string, string] = round === 1 ? [en, zh] : [`${en} (${round})`, `${zh}（${round}）`];
      const repository = historyRepositories[index % historyRepositories.length] ?? historyRepositories[0] ?? "";
      const writing = index % 7 === 3;
      nextIssue += 1;
      const issues = writing
        ? []
        : [
            {
              repository,
              number: nextIssue,
              url: `https://github.com/${repository}/issues/${nextIssue}`,
              title: { en: label[0], zh: label[1] },
              summary: { en: `${label[0]}, as the issue says`, zh: `${label[1]}，按问题里写的做` },
            },
          ];
      const opened = tickets.open({
        repository: writing ? null : repository,
        issues,
        title: { en: label[0], zh: label[1] },
        summary: { en: `${label[0]}, a finished ticket made by the page harness`, zh: `${label[1]}：页面测试用的已结束工单` },
        kind: writing ? "writing" : (kinds[index % kinds.length] ?? "fix"),
        ...(writing ? { task: { task: `Write a short note about: ${label[0]}`, materials: [] } } : {}),
      });
      const how = index % 6;
      if (how === 4 || how === 5) {
        tickets.stop(opened.id, historyStopReasons[(index + (how === 5 ? 1 : 0)) % historyStopReasons.length] ?? historyStopReasons[0] ?? { en: "Stopped", zh: "已停止" });
      } else {
        tickets.move(opened.id, "working");
        if (writing) {
          tickets.move(opened.id, "delivered");
        } else {
          tickets.move(opened.id, "verifying");
          tickets.move(opened.id, "merged");
          tickets.change((writes) => {
            writes.setPullRequest(opened.id, 100 + index, { en: "The change is merged", zh: "改动已合并" });
            writes.pullRequestMerged(opened.id, { number: 100 + index, closes: (writes.get(opened.id)?.issues ?? []).map((issue) => issue.number), mergeCommit: null, deployment: null });
          });
        }
      }
      const endedAt = now - (index + 1) * 100 * 60_000;
      backdate.run(endedAt - 3_600_000, endedAt, endedAt, opened.id);
      backdateMoves.run(endedAt, opened.id);
      added.push({ id: opened.id, state: tickets.get(opened.id)?.state ?? "" });
    }
    const first = added[0];
    const second = added[1];
    if (first !== undefined && second !== undefined) {
      const noise = tickets.open({
        repository: historyRepositories[0] ?? null,
        issues: [
          {
            repository: historyRepositories[0] ?? "",
            number: ++nextIssue,
            url: `https://github.com/${historyRepositories[0] ?? ""}/issues/${nextIssue}`,
            title: { en: "Joined into another ticket", zh: "并入了别的工单" },
            summary: { en: "Joined by an arrangement", zh: "按安排并入" },
          },
        ],
        title: { en: "Joined into another ticket", zh: "并入了别的工单" },
        summary: { en: "Joined by an arrangement", zh: "按安排并入" },
        kind: "fix",
      });
      tickets.change((writes) => writes.join(noise.id, first.id, { en: `Joined ticket ${first.id} by an arrangement`, zh: `按新的安排并入了工单 ${first.id}` }));
      added.push({ id: noise.id, state: "stopped, joined, not listed" });
    }
    json(response, 200, { added: added.length, newest: added[0]?.id ?? null, tickets: added.slice(0, 12) });
  };

  const declareDeployment = async (request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> => {
    const repository = url.searchParams.get("repository");
    if (options.deployments === undefined || repository === null) {
      json(response, 400, { error: "needs --forge fake, repository=<owner/name> and the deployment file as the request's body (POST), or remove=1" });
      return;
    }
    if (url.searchParams.get("remove") === "1") {
      options.deployments.delete(repository);
      json(response, 200, { repository, declared: false });
      return;
    }
    const body = (await readBody(request)).toString("utf8");
    const reading = readDeploymentFile(body);
    if (!reading.ok) {
      json(response, 400, { error: reading.reason });
      return;
    }
    options.deployments.set(repository, body);
    json(response, 200, { repository, declared: true, file: reading.file });
  };

  const startPlans = async (plans: readonly Planned[], response: ServerResponse): Promise<void> => {
    options.scripted.connect();
    const ids = new Map<string, number>();
    for (const plan of plans) {
      const issues =
        plan.repository === null
          ? []
          : plan.titles.map(([en, zh]) => {
              nextIssue += 1;
              const repository = plan.repository ?? "";
              return { repository, number: nextIssue, url: `https://github.com/${repository}/issues/${nextIssue}`, title: { en, zh }, summary: { en: `${en}, as the issue says`, zh: `${zh}，按问题里写的做` } };
            });
      const after = plan.after === undefined ? undefined : ids.get(plan.after);
      const ticket = options.hub.tickets.open({
        repository: plan.repository,
        issues,
        title: { en: plan.title[0], zh: plan.title[1] },
        summary: { en: `${plan.title[0]}, a scripted ticket of the page harness`, zh: `${plan.title[1]}：页面测试用的脚本工单` },
        kind: plan.repository === null ? "writing" : "feature",
        ...(after === undefined ? {} : { waitsFor: [after] }),
        ...(plan.task === undefined ? {} : { task: { task: plan.task, materials: [] } }),
      });
      ids.set(plan.name, ticket.id);
      options.scripted.behave(ticket.id, plan.behaviour);
      if (plan.decision !== undefined) {
        const recorded = await callTool("record_decision", { ticket: ticket.id, ...plan.decision });
        if (recorded.isError) {
          json(response, 409, { error: `record_decision refused for ${plan.name}: ${recorded.text}` });
          return;
        }
      }
      const stated = options.hub.chains.arranger.state([
        plan.repository === null
          ? { ticket: ticket.id, kind: "writing", reason: { en: "Scripted writing", zh: "脚本写作" }, platform: "any" }
          : {
              ticket: ticket.id,
              kind: "feature",
              issues: issues.map((issue) => ({ number: issue.number, difficulty: "standard" as const })),
              reason: { en: "Scripted work", zh: "脚本工作" },
              platform: "any",
              engine: plan.engine === "claude" ? "claude" : "codex",
            },
      ]);
      if (!stated.ok) {
        json(response, 409, { error: `defaults refused for ${plan.name}: ${stated.reason}` });
        return;
      }
      const chosen = await options.hub.chains.starter.choose({
        assertion: await options.assertion(),
        ticket: ticket.id,
        change: { machine: plan.machine, engine: plan.engine, ...(plan.model === undefined ? {} : { model: plan.model, effort: plan.effort ?? null }) },
      });
      if (!chosen.ok) {
        json(response, 409, { error: `choice refused for ${plan.name}: ${chosen.error}` });
        return;
      }
    }
    const wanted = new Set(ids.values());
    const cards = options.hub.chains.cards().filter((card) => wanted.has(card.ticket.id));
    const started = await options.hub.chains.starter.start({ assertion: await options.assertion(), chains: cards.map((card) => ({ ticket: card.ticket.id, fingerprint: card.fingerprint })) });
    json(response, started.ok ? 200 : 409, { tickets: Object.fromEntries(ids), started: started.ok ? started.tickets.map((entry) => ({ id: entry.id, state: entry.state })) : started.error });
  };

  const scriptedMachine = (url: URL, response: ServerResponse): void => {
    const machine = url.searchParams.get("machine") ?? "";
    const to = url.searchParams.get("to");
    if (to !== "offline" && to !== "online") {
      json(response, 400, { error: "give machine= (one of the scripted machines) and to=offline or to=online", machines: options.scripted.names });
      return;
    }
    const done = to === "offline" ? options.scripted.offline(machine) : options.scripted.online(machine);
    json(response, done ? 200 : 409, { machine, to, done });
  };

  const forceAllowance = (url: URL, response: ServerResponse): void => {
    for (const program of allowancePrograms) {
      const given = url.searchParams.get(program);
      if (given === null) {
        continue;
      }
      const state = AllowanceState.safeParse(given);
      if (given !== "read" && !state.success) {
        json(response, 400, { error: "give codex=, claude= or antigravity= as available, exhausted, unknown, or read to use the real reading" });
        return;
      }
      options.allowance.force(program, state.success ? state.data : null);
    }
    options.hub.waiting.refresh();
    const subscriptions = options.hub.defaults.subscriptions();
    json(response, 200, { forced: options.allowance.forced(), subscriptions: allowancePrograms.map((program) => subscriptions[program]) });
  };

  const newDevice = async (response: ServerResponse): Promise<void> => {
    const publicKey = options.hub.push?.publicKey;
    if (publicKey === undefined) {
      json(response, 409, { error: "the hub has no VAPID keys" });
      return;
    }
    const id = randomUUID();
    const keys = createPushDevice();
    const device: Device = { id, keys, gone: false };
    devices.set(id, device);
    const endpoint = `${options.publicUrl}/__harness/push/${id}`;
    const answer = await fetch(`${options.hubUrl}/api/push/subscription`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: options.hubUrl, "cf-access-jwt-assertion": await options.assertion() },
      body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, applicationServerKey: publicKey }),
    });
    json(response, answer.ok ? 200 : 502, { id, endpoint, hub: answer.status });
  };

  return {
    handle: async (request, response, path) => {
      const url = new URL(request.url ?? "/", "http://page-dev");
      if (path === "/__harness/hold") {
        hold(url, response);
        return true;
      }
      if (path === "/__harness/ticket") {
        moveTicket(url, response);
        return true;
      }
      if (path === "/__harness/work") {
        await startWork(url, response);
        return true;
      }
      if (path === "/__harness/writing") {
        await openWriting(url, response);
        return true;
      }
      if (path === "/__harness/tool") {
        const name = url.searchParams.get("name");
        let args: unknown;
        try {
          args = JSON.parse(url.searchParams.get("args") ?? "{}");
        } catch {
          args = undefined;
        }
        if (name === null || typeof args !== "object" || args === null || Array.isArray(args)) {
          json(response, 400, { error: "give name=<tool> and args=<a JSON object>" });
          return true;
        }
        const result = await callTool(name, args as Record<string, unknown>, url.searchParams.get("conversation") ?? undefined);
        json(response, result.isError ? 409 : 200, result);
        return true;
      }
      if (path === "/__harness/loop") {
        await loopCase(url, response);
        return true;
      }
      if (path === "/__harness/deployment") {
        await declareDeployment(request, url, response);
        return true;
      }
      if (path === "/__harness/history") {
        fillHistory(url, response);
        return true;
      }
      if (path === "/__harness/deploy") {
        await arrangeDeployment(url, response);
        return true;
      }
      if (path === "/__harness/scenario") {
        await scenario(response);
        return true;
      }
      if (path === "/__harness/scripted") {
        options.scripted.connect();
        scriptedMachine(url, response);
        return true;
      }
      if (path === "/__harness/cloudflare" && options.cloudflare !== undefined) {
        const remove = url.searchParams.get("remove");
        const create = url.searchParams.get("create");
        if (remove !== null) {
          options.cloudflare.failRemove = remove === "fail";
        }
        if (create !== null) {
          options.cloudflare.failCreate = create === "fail";
        }
        json(response, 200, { create: options.cloudflare.failCreate ? "fail" : "ok", remove: options.cloudflare.failRemove ? "fail" : "ok", made: options.cloudflare.made });
        return true;
      }
      if (path === "/__harness/allowance") {
        forceAllowance(url, response);
        return true;
      }
      if (path === "/__harness/device/new") {
        await newDevice(response);
        return true;
      }
      const gone = /^\/__harness\/device\/([0-9a-f-]+)\/(gone|alive)$/.exec(path);
      if (gone?.[1] !== undefined) {
        const device = devices.get(gone[1]);
        if (device === undefined) {
          json(response, 404, { error: "unknown device" });
          return true;
        }
        device.gone = gone[2] === "gone";
        json(response, 200, { id: device.id, gone: device.gone });
        return true;
      }
      if (path === "/__harness/pushes") {
        json(response, 200, { received });
        return true;
      }
      const push = /^\/__harness\/push\/([0-9a-f-]+)$/.exec(path);
      if (push?.[1] !== undefined && request.method === "POST") {
        const body = await readBody(request);
        const device = devices.get(push[1]);
        if (device === undefined || device.gone) {
          response.writeHead(410, { "content-length": 0 });
          response.end();
          return true;
        }
        received.push({ device: device.id, text: receivePush(device.keys, body) });
        response.writeHead(201, { "content-length": 0 });
        response.end();
        return true;
      }
      return false;
    },
  };
}
