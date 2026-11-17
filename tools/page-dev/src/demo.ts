import { randomUUID } from "node:crypto";
import type { OpenOptions, ProgramAdapter, ProgramHandle, ProgramListener, SteerResult } from "@super-agent2/brain";

type Step = { readonly kind: "text"; readonly block: string; readonly text: string } | { readonly kind: "tool"; readonly call: string; readonly command: string; readonly lines: readonly string[] };

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
  ) {
    listener({ type: "session", session: session ?? randomUUID() });
  }

  start(prompt: string): void {
    this.turns += 1;
    this.running = true;
    this.queue = plan(lastParagraph(prompt), this.turns);
    this.next();
  }

  steer(text: string): Promise<SteerResult> {
    if (!this.running) {
      return Promise.resolve("queued");
    }
    this.steers += 1;
    this.queue.push({ kind: "text", block: `steer-${this.turns}-${this.steers}`, text: `收到你刚补充的：「${text.trim()}」，已经算进这一轮里。` });
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
    open: (_options: OpenOptions, listener: ProgramListener) => new DemoHandle(listener, _options.session),
  };
}
