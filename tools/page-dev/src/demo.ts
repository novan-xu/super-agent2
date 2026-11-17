import { randomUUID } from "node:crypto";
import type { OpenOptions, ProgramAdapter, ProgramHandle, ProgramListener, SteerResult } from "@super-agent2/brain";
import { conversationHeader } from "@super-agent2/protocol";

type ToolEndpoint = NonNullable<OpenOptions["tools"]>;

type Step =
  | { readonly kind: "text"; readonly block: string; readonly text: string }
  | { readonly kind: "tool"; readonly call: string; readonly command: string; readonly lines: readonly string[] }
  | { readonly kind: "hub"; readonly call: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> };

const pace = 45;
const lineGap = 600;

function chunks(text: string): string[] {
  const parts: string[] = [];
  const characters = [...text];
  for (let index = 0; index < characters.length; index += 3) {
    parts.push(characters.slice(index, index + 3).join(""));
  }
  return parts;
}

function lastParagraph(prompt: string): string {
  const paragraphs = prompt.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== "");
  return (paragraphs.at(-1) ?? prompt).trim();
}

function lastHubMessage(prompt: string): string | undefined {
  const at = prompt.lastIndexOf("[hub] ");
  return at < 0 ? undefined : prompt.slice(at);
}

function deployPlan(hub: string, turn: number): Step[] | undefined {
  const merged = /^\[hub\] Ticket (\d+) .* in (\S+) was merged/.exec(hub);
  const mergeCommit = /Deploy it with deploy_repository at (\S+) unless/.exec(hub)?.[1];
  if (merged !== null && mergeCommit !== undefined) {
    const repository = merged[2] ?? "";
    return [
      { kind: "hub", call: `deploy-${turn}`, name: "deploy_repository", args: { repository, commit: mergeCommit } },
      { kind: "text", block: `deploy-${turn}`, text: `工单 ${merged[1] ?? ""} 已合并，这次改动需要部署。我已经开始部署 ${repository} 的 ${mergeCommit.slice(0, 7)}，结果出来后告诉你。` },
    ];
  }
  const result = /^\[hub\] Deployment (\d+) of (\S+) at commit (\S+) on target \S+ (succeeded|failed and was rolled back to (\S+?);|[^\n]*)/.exec(hub);
  if (result === null) {
    return undefined;
  }
  const repository = result[2] ?? "";
  const commit = (result[3] ?? "").slice(0, 7);
  const said =
    result[4] === "succeeded"
      ? `部署 ${result[1] ?? ""} 完成：${repository} 已经在跑 ${commit}，健康检查通过。`
      : result[5] !== undefined
        ? `部署 ${result[1] ?? ""} 没有成功：${repository} 的 ${commit} 没通过健康检查，hub 已经回滚到 ${result[5].slice(0, 7)}，旧版本又能正常访问了。我会先查清原因再部署。`
        : `部署 ${result[1] ?? ""} 没有成功（${repository} 的 ${commit}），我先去确认服务现在的状态。`;
  return [{ kind: "text", block: `deployed-${turn}`, text: said }];
}

function loopPlan(hub: string, turn: number): Step[] | undefined {
  const ticket = Number(/ticket (\d+) \(/.exec(hub)?.[1] ?? Number.NaN);
  if (!Number.isInteger(ticket)) {
    return undefined;
  }
  if (hub.includes("call describe_stuck")) {
    const rounds = /after (\d+) guided rounds/.exec(hub)?.[1] ?? "3";
    return [
      {
        kind: "hub",
        call: `stuck-${turn}`,
        name: "describe_stuck",
        args: {
          ticket,
          where: {
            en: `Demo brain: ticket ${ticket} failed the same way in each of its ${rounds} guided rounds; the worker's change does not address the failing check. Decide whether to give it more rounds or drop it.`,
            zh: `演示大脑：工单 ${ticket} 引导了 ${rounds} 轮，每轮都以同样的方式失败，工作者的改动没有解决出错的检查。请决定是再给几轮还是放弃。`,
          },
        },
      },
      { kind: "text", block: `stuck-${turn}`, text: `工单 ${ticket} 引导了 ${rounds} 轮还没通过，已经停下，等你在工作台上决定。` },
    ];
  }
  if (hub.includes("call guide_ticket")) {
    const failing = [...hub.matchAll(/(FAIL [^\n]*|AssertionError[^\n]*)/g)].at(-1)?.[1]?.trim() ?? "the failure the hub reported";
    const resumed = hub.includes("The owner resumed");
    return [
      {
        kind: "hub",
        call: `guide-${turn}`,
        name: "guide_ticket",
        args: {
          ticket,
          guidance: {
            en: `Demo brain: the last attempt failed with "${failing}". Read that check, fix the code it points at rather than the check, run the same check yourself, and hand back only when it passes.${resumed ? " The owner resumed this ticket; follow the owner's words." : ""}`,
            zh: `演示大脑：上一次失败在「${failing}」。先读这个检查，改它指向的代码而不是检查本身，自己跑一遍同样的检查，通过了再交回。${resumed ? "你让它继续了，按你的话来。" : ""}`,
          },
        },
      },
      { kind: "text", block: `guide-${turn}`, text: `工单 ${ticket} 失败了：${failing}。我已经告诉工作者该改什么，它会在同一个分支上再试一次。` },
    ];
  }
  return undefined;
}

function plan(message: string, turn: number): Step[] {
  if (message.includes("长")) {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：这是一段用来检查长对话滚动的文字，内容会一直写下去，直到写满整整四十段为止。`);
    return [{ kind: "text", block: `long-${turn}`, text: paragraphs.join("\n\n") }];
  }
  return [
    { kind: "text", block: `intro-${turn}`, text: `好的，我来处理：「${message}」。先看一下仓库现在的状态。` },
    {
      kind: "tool",
      call: `call-${turn}`,
      command: "git log --oneline -6 && pnpm check",
      lines: ["52e5a03 Add the brain's session", "5f9afdd Add the Chinese presentation", "58e1626 Add the confirmation lock", "> pnpm typecheck", "> pnpm test", "Tests  412 passed (412)"],
    },
    {
      kind: "text",
      block: `outro-${turn}`,
      text: "检查完了，结果如下：\n\n- 最近的提交都在 `main` 上\n- **测试全部通过**\n\n```sh\npnpm check\n```\n\n<b>这一行是原样显示的 HTML</b>，不会被当成标记。",
    },
  ];
}

class DemoHandle implements ProgramHandle {
  private timers = new Set<NodeJS.Timeout>();
  private queue: Step[] = [];
  private running = false;
  private turns = 0;
  private steers = 0;

  constructor(
    private readonly listener: ProgramListener,
    session: string | null,
    private readonly tools: ToolEndpoint | null,
  ) {
    listener({ type: "session", session: session ?? randomUUID() });
  }

  start(prompt: string): void {
    this.turns += 1;
    this.running = true;
    const hub = lastHubMessage(prompt);
    this.queue = (hub === undefined ? undefined : (deployPlan(hub, this.turns) ?? loopPlan(hub, this.turns))) ?? plan(lastParagraph(prompt), this.turns);
    this.next();
  }

  steer(text: string): Promise<SteerResult> {
    if (!this.running) {
      return Promise.resolve("queued");
    }
    this.steers += 1;
    const hub = lastHubMessage(text);
    const loop = hub === undefined ? undefined : (deployPlan(hub, this.turns * 1000 + this.steers) ?? loopPlan(hub, this.turns * 1000 + this.steers));
    this.queue.push(...(loop ?? [{ kind: "text", block: `steer-${this.turns}-${this.steers}`, text: `收到你刚补充的：「${text.trim()}」，已经算进这一轮里。` }]));
    return Promise.resolve("steered");
  }

  interrupt(): void {
    if (!this.running) {
      return;
    }
    this.clear();
    this.running = false;
    this.listener({ type: "turn.finished", outcome: "interrupted" });
  }

  close(): Promise<void> {
    this.clear();
    this.running = false;
    return Promise.resolve();
  }

  private clear(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.queue = [];
  }

  private async call(name: string, args: Readonly<Record<string, unknown>>): Promise<{ readonly text: string; readonly ok: boolean }> {
    if (this.tools === null) {
      return { text: "No tools", ok: false };
    }
    try {
      const response = await fetch(this.tools.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.tools.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", [conversationHeader]: this.tools.conversation },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const body = (await response.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
      return { text: (body.result?.content ?? []).map((part) => part.text ?? "").join("\n"), ok: body.result?.isError !== true };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), ok: false };
    }
  }

  private later(delay: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, delay);
    this.timers.add(timer);
  }

  private next(): void {
    const step = this.queue.shift();
    if (step === undefined) {
      this.running = false;
      this.listener({ type: "turn.finished", outcome: "completed" });
      return;
    }
    if (step.kind === "hub") {
      this.listener({ type: "tool.started", call: step.call, name: `mcp__hub__${step.name}`, input: JSON.stringify(step.args) });
      void this.call(step.name, step.args).then(({ text, ok }) => {
        this.listener({ type: "tool.finished", call: step.call, output: text, ok });
        this.later(pace * 4, () => this.next());
      });
      return;
    }
    if (step.kind === "text") {
      const parts = chunks(step.text);
      const write = (index: number) => {
        const part = parts[index];
        if (part === undefined) {
          this.later(pace * 4, () => this.next());
          return;
        }
        this.listener({ type: "text", block: step.block, delta: part });
        this.later(pace, () => write(index + 1));
      };
      write(0);
      return;
    }
    this.listener({ type: "tool.started", call: step.call, name: "mcp__hub__run_command", input: JSON.stringify({ target: "hub", command: step.command }) });
    const print = (index: number) => {
      const line = step.lines[index];
      if (line === undefined) {
        this.listener({ type: "tool.finished", call: step.call, output: null, ok: true });
        this.later(pace * 4, () => this.next());
        return;
      }
      this.listener({ type: "tool.output", call: step.call, delta: `${line}\n` });
      this.later(lineGap, () => print(index + 1));
    };
    this.later(lineGap, () => print(0));
  }
}

export function demoProgram(): ProgramAdapter {
  return {
    provider: "claude",
    model: "demo",
    effort: "high",
    open: (options: OpenOptions, listener: ProgramListener) => new DemoHandle(listener, options.session, options.tools),
  };
}
