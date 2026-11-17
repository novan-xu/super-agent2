import type { Hub, RunnerLink } from "@super-agent2/hub";
import { type HubToRunner, type MachinePlatform, type MachineReport, protocolVersion, type WorkEvent } from "@super-agent2/protocol";

export type Behaviour = "long" | "finish" | "fail" | "deliver";

interface Running {
  readonly ticket: number;
  readonly attempt: number;
  readonly machine: string;
  readonly behaviour: Behaviour;
  readonly repository: string | null;
  seq: number;
  step: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
}

interface ScriptedMachine {
  readonly name: string;
  readonly platform: MachinePlatform;
  link: RunnerLink | undefined;
}

export interface ScriptedRunners {
  readonly names: readonly string[];
  connect(): void;
  behave(ticket: number, behaviour: Behaviour): void;
  offline(machine: string): boolean;
  online(machine: string): boolean;
  close(): void;
}

const programs: MachineReport["programs"] = [
  {
    id: "codex",
    installed: true,
    path: "codex",
    version: "scripted",
    models: [
      { id: "gpt-6-luna", efforts: ["low", "medium"] },
      { id: "gpt-6.1-terra", efforts: ["medium", "high"] },
      { id: "gpt-6.1-sol", efforts: ["high"] },
    ],
    source: "program",
    problem: null,
  },
  {
    id: "claude",
    installed: true,
    path: "claude",
    version: "scripted",
    models: [
      { id: "claude-haiku-5-5", efforts: ["low", "medium"] },
      { id: "claude-sonnet-5-5", efforts: ["medium", "high"] },
      { id: "claude-opus-5-5", efforts: ["high", "max"] },
    ],
    source: "program",
    problem: null,
  },
  { id: "dsh", installed: true, path: "dsh", version: "scripted", models: [{ id: "deepseek-flash", efforts: ["low", "high", "max"] }], source: "program", problem: null },
  { id: "antigravity", installed: true, path: "agy", version: "scripted", models: [{ id: "gemini-3.8-flash", efforts: ["high"] }], source: "program", problem: null },
];

function report(name: string, platform: MachinePlatform, busy: number): MachineReport {
  return { hostname: name, platform, release: "scripted", arch: "x64", user: "page-dev", slots: { total: 4, free: Math.max(0, 4 - busy) }, programs, allowances: [] };
}

const words = (text: string): string[] => text.match(/[\s\S]{1,3}/gu) ?? [];

const opening = words("我读完了这几个问题和相关的代码。改动涉及解析器和它的测试，所以先从那里开始，每一步都小到可以单独检查。");

const lines = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`);

export function createScriptedRunners(hub: Hub): ScriptedRunners {
  const machines: ScriptedMachine[] = [
    { name: "studio", platform: "win32", link: undefined },
    { name: "mini", platform: "darwin", link: undefined },
  ];
  const behaviours = new Map<number, Behaviour>();
  const running = new Map<number, Running>();
  const descriptions = new Map<number, string | null>();

  const machineOf = (name: string) => machines.find((machine) => machine.name === name);

  const busyOn = (name: string) => [...running.values()].filter((work) => work.machine === name && !work.ended).length;

  const emit = (work: Running, event: WorkEvent): boolean => {
    const link = machineOf(work.machine)?.link;
    if (link === undefined) {
      return false;
    }
    work.seq += 1;
    link.receive({ type: "work.event", ticket: work.ticket, attempt: work.attempt, seq: work.seq, at: Date.now(), event });
    return true;
  };

  const later = (work: Running, delay: number, run: () => void) => {
    work.timer = setTimeout(() => {
      work.timer = undefined;
      if (work.ended) {
        return;
      }
      if (machineOf(work.machine)?.link === undefined) {
        later(work, 500, run);
        return;
      }
      run();
    }, delay);
  };

  const end = (work: Running) => {
    work.ended = true;
    if (work.timer !== undefined) {
      clearTimeout(work.timer);
      work.timer = undefined;
    }
    const machine = machineOf(work.machine);
    machine?.link?.receive({ type: "report", machine: report(machine.name, machine.platform, busyOn(machine.name)) });
  };

  const stream = (work: Running, block: string, parts: readonly string[], then: () => void) => {
    let index = 0;
    const next = () => {
      const part = parts[index];
      if (part === undefined) {
        then();
        return;
      }
      index += 1;
      emit(work, { kind: "text", block, delta: part });
      later(work, 90, next);
    };
    next();
  };

  const tool = (work: Running, call: string, command: string, output: readonly string[], ok: boolean, then: () => void) => {
    emit(work, { kind: "tool.started", call, name: "shell", input: JSON.stringify({ command }) });
    let index = 0;
    const next = () => {
      const part = output[index];
      if (part === undefined) {
        emit(work, { kind: "tool.finished", call, output: null, ok });
        later(work, 400, then);
        return;
      }
      index += 1;
      emit(work, { kind: "tool.output", call, delta: part });
      later(work, 120, next);
    };
    later(work, 300, next);
  };

  const loop = (work: Running) => {
    work.step += 1;
    const step = work.step;
    tool(work, `c${step}`, step % 2 === 0 ? `pnpm vitest run src/parser --reporter dot` : `git diff --stat`, lines(6 + (step % 5), step % 2 === 0 ? "test passed" : "src/parser.ts | changed line"), true, () =>
      stream(work, `b${step}`, words(`第 ${step} 步完成：普通输入的行为没变，新的情况也通过了。接着做下一种情况。`), () => later(work, 600, () => loop(work))),
    );
  };

  const finish = (work: Running) => {
    tool(work, "test", "pnpm test", lines(8, "ok"), true, () =>
      stream(work, "done", words("测试全部通过。PR 已经开好，交回文件也写好了。"), () => {
        const number = 100 + work.ticket;
        emit(work, {
          kind: "finished",
          pullRequest: number,
          url: `https://github.com/${work.repository ?? "novan-xu/super-agent-sandbox"}/pull/${number}`,
          report: { en: "Implemented the change and its tests.", zh: "改动和测试都写好了。" },
        });
        end(work);
      }),
    );
  };

  const fail = (work: Running) => {
    tool(work, "test", "pnpm test", ["FAIL src/parser.test.ts\n", "Error: rate limit reached for this account\n"], false, () => {
      emit(work, { kind: "failed", failure: "program", reason: "The program exited with code 1: rate limit reached for this account" });
      end(work);
    });
  };

  const deliver = (work: Running) => {
    stream(work, "draft", words("按材料起草这封信，保持原来的语气。"), () =>
      later(work, 8000, () =>
        stream(work, "final", words("正文和文件都放进输出文件夹了。"), () => {
          const letter = "Dear neighbours,\n\nThe garden gate will be repainted on Saturday morning. Please use the side entrance until noon.\n\nThank you.";
          const data = Buffer.from(`# Notice\n\n${letter}\n`, "utf8");
          emit(work, {
            kind: "delivered",
            text: letter,
            files: [{ name: "notice.md", size: data.length, mediaType: "text/markdown", data: data.toString("base64") }],
            report: { en: "Wrote the notice and a Markdown copy.", zh: "写好了通知，另附一份 Markdown。" },
          });
          end(work);
        }),
      ),
    );
  };

  const begin = (machine: string, ticket: number, attempt: number, model: string, effort: string, resumed: boolean) => {
    const previous = running.get(ticket);
    if (previous !== undefined && !previous.ended && previous.attempt === attempt) {
      return;
    }
    if (previous !== undefined) {
      end(previous);
    }
    const planned = behaviours.get(ticket) ?? "finish";
    const work: Running = { ticket, attempt, machine, behaviour: planned === "fail" && attempt > 1 ? "finish" : planned, repository: descriptions.get(ticket) ?? null, seq: 0, step: 0, timer: undefined, ended: false };
    running.set(ticket, work);
    emit(work, { kind: "phase", phase: "preparing", detail: `Preparing ticket ${ticket}` });
    later(work, 400, () => {
      emit(work, { kind: "phase", phase: resumed ? "resumed" : "started", detail: `Started with ${model} at ${effort}` });
      emit(work, { kind: "ran", model, effort });
      stream(work, "open", opening, () => {
        if (work.behaviour === "long") {
          loop(work);
        } else if (work.behaviour === "fail") {
          fail(work);
        } else if (work.behaviour === "deliver") {
          deliver(work);
        } else {
          finish(work);
        }
      });
    });
  };

  const receive = (machine: ScriptedMachine, message: HubToRunner) => {
    switch (message.type) {
      case "work.start":
        descriptions.set(message.task.ticket, message.task.repository);
        begin(machine.name, message.task.ticket, message.task.attempt, message.task.model, message.task.effort, message.task.session !== null);
        return;
      case "work.write":
        descriptions.set(message.task.ticket, null);
        begin(machine.name, message.task.ticket, message.task.attempt, message.task.model, message.task.effort, message.task.session !== null);
        return;
      case "work.message": {
        const work = running.get(message.ticket);
        if (work === undefined || work.ended || work.attempt !== message.attempt) {
          return;
        }
        emit(work, { kind: "message", id: message.id, from: message.from, text: message.text, delivery: "steered" });
        emit(work, { kind: "text", block: `reply-${message.id}`, delta: `收到：「${message.text}」。下一步会照这个做。` });
        return;
      }
      case "work.stop": {
        const work = running.get(message.ticket);
        if (work === undefined || work.machine !== machine.name || work.ended) {
          return;
        }
        emit(work, { kind: "stopped", saved: message.save, detail: message.save ? "Saved the work on the branch" : "Stopped by the hub" });
        end(work);
        return;
      }
      default:
        return;
    }
  };

  const attach = (machine: ScriptedMachine) => {
    const known = hub.machines.get(machine.name) ?? (hub.machines.add({ name: machine.name, accessClientId: `scripted-${machine.name}` }), hub.machines.get(machine.name));
    if (known === undefined) {
      return;
    }
    const link = hub.runners.attach(known, {
      send: (message) => queueMicrotask(() => receive(machine, message)),
      close: () => {
        if (machine.link === link) {
          machine.link = undefined;
        }
      },
    });
    machine.link = link;
    const works = [...running.values()]
      .filter((work) => work.machine === machine.name)
      .map((work) => ({ ticket: work.ticket, attempt: work.attempt, last: work.seq, live: !work.ended, ended: work.ended }));
    link.receive({ type: "hello", protocol: protocolVersion, machine: report(machine.name, machine.platform, busyOn(machine.name)), works });
  };

  return {
    names: machines.map((machine) => machine.name),
    connect: () => {
      for (const machine of machines) {
        if (machine.link === undefined) {
          attach(machine);
        }
      }
    },
    behave: (ticket, behaviour) => {
      behaviours.set(ticket, behaviour);
    },
    offline: (name) => {
      const machine = machineOf(name);
      const link = machine?.link;
      if (machine === undefined || link === undefined) {
        return false;
      }
      machine.link = undefined;
      link.closed();
      return true;
    },
    online: (name) => {
      const machine = machineOf(name);
      if (machine === undefined) {
        return false;
      }
      if (machine.link === undefined) {
        attach(machine);
      }
      return true;
    },
    close: () => {
      for (const work of running.values()) {
        end(work);
      }
    },
  };
}
