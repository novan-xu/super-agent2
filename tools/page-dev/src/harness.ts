import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPushDevice, type Hub, type PushDevice, receivePush, type SubscriptionAdjustment, type Target } from "@super-agent2/hub";
import { AllowanceProgram, AllowanceState, allowancePrograms, brainToolsPath, ProgramId, type Subscriptions, TicketState } from "@super-agent2/protocol";

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
      const codex = forced.get("codex");
      const claude = forced.get("claude");
      return {
        codex: codex === undefined ? subscriptions.codex : { ...subscriptions.codex, state: codex, remainingPercent: codex === "exhausted" ? 0 : subscriptions.codex.remainingPercent },
        claude: claude === undefined ? subscriptions.claude : { ...subscriptions.claude, state: claude, remainingPercent: claude === "exhausted" ? 0 : subscriptions.claude.remainingPercent },
      };
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

  const callTool = async (name: string, args: Record<string, unknown>): Promise<{ readonly text: string; readonly isError: boolean }> => {
    const answer = await fetch(`${options.hubUrl}${brainToolsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.brainToken()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
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
    if (issues.length > 1) {
      const arranged = await call("arrange_chains", {
        chains: [{ name: "test", repository, issues, title: { en: `Test chain of ${issues.length} issues`, zh: `${issues.length} 个问题的测试链` }, summary: { en: "A chain of small test issues", zh: "几个小测试问题组成的链" } }],
      });
      if (arranged === undefined) {
        json(response, 409, { error: "arrange_chains failed", steps });
        return;
      }
      const pending = options.hub.tickets.list({ open: true }).find((entry) => entry.state === "pending" && entry.issues.length === issues.length && entry.repository === repository);
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

  const forceAllowance = (url: URL, response: ServerResponse): void => {
    for (const program of allowancePrograms) {
      const given = url.searchParams.get(program);
      if (given === null) {
        continue;
      }
      const state = AllowanceState.safeParse(given);
      if (given !== "read" && !state.success) {
        json(response, 400, { error: "give codex= and claude= as available, exhausted, unknown, or read to use the real reading" });
        return;
      }
      options.allowance.force(program, state.success ? state.data : null);
    }
    options.hub.waiting.refresh();
    const subscriptions = options.hub.defaults.subscriptions();
    json(response, 200, { forced: options.allowance.forced(), subscriptions: [subscriptions.codex, subscriptions.claude] });
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
