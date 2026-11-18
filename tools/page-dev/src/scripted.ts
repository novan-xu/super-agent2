import type { Hub, RunnerLink } from "@super-agent2/hub";
import { type Decision, type HubToRunner, type MachinePlatform, type MachineReport, protocolVersion, type WorkEvent } from "@super-agent2/protocol";

export type Behaviour = "long" | "finish" | "fail" | "fails" | "red-once" | "red-always" | "deliver" | "deploy";

export interface HandBack {
  readonly ticket: number;
  readonly attempt: number;
  readonly repository: string;
  readonly branch: string;
  readonly pullRequest: number;
  readonly closes: readonly number[];
  readonly behaviour: Behaviour;
}

export function pieceOf(issues: readonly number[], merged: readonly number[]): number[] {
  const open = issues.filter((issue) => !merged.includes(issue));
  return open.slice(0, Math.max(1, Math.ceil(open.length / 2)));
}

interface Running {
  readonly ticket: number;
  readonly attempt: number;
  readonly machine: string;
  readonly behaviour: Behaviour;
  readonly repository: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly planned: Behaviour;
  readonly closes: readonly number[];
  readonly piece: number;
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

const pieceDecisions: readonly Decision[] = [
  {
    chosen: { en: "Parsed dates in the local time zone of the machine that writes the note", zh: "日期按写笔记那台机器的本地时区解析" },
    why: { en: "Notes are written by one person in one place, and an evening note should stay on its day", zh: "笔记是一个人在一个地方写的，晚上写的笔记应该留在当天" },
    otherOptions: { en: "UTC everywhere, which moves evening notes to the next day; a time zone setting, which nobody asked for", zh: "统一用 UTC，晚上的笔记会跑到第二天；加一个时区设置，但没有人要求" },
  },
  {
    chosen: { en: "Showed parsed dates beside the note instead of replacing the original words", zh: "解析出的日期显示在笔记旁边，不替换原来的字" },
    why: { en: "The issue suggested replacing them, but the original wording is what the owner wrote and searches for", zh: "问题里建议替换，但原来的字是你写的，也是你会搜索的" },
    otherOptions: { en: "Replacing the words as the issue suggested; showing the date only on hover", zh: "按问题建议直接替换；只在鼠标悬停时显示日期" },
  },
];

const taskDecision: Decision = {
  chosen: { en: "Wrote the notice in a friendly, informal tone", zh: "通知用了亲切、不正式的语气" },
  why: { en: "It is for neighbours, and the material reads that way", zh: "是写给邻居的，材料本身也是这个语气" },
  otherOptions: { en: "A formal notice, as from a building management", zh: "像物业那样写成正式通知" },
};

const deployDecision: Decision = {
  chosen: { en: "Deployed without stopping the old version first", zh: "没有先停旧版本就直接部署" },
  why: { en: "The recipe switches versions in place, and a stop would have left the service down longer", zh: "配方是原地切换版本，先停会让服务停得更久" },
  otherOptions: { en: "Stopping the service first, for a cleaner switch", zh: "先停服务，切换更干净" },
};

const lines = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`);

export function createScriptedRunners(hub: Hub, handBack?: (given: HandBack) => void): ScriptedRunners {
  const machines: ScriptedMachine[] = [
    { name: "studio", platform: "win32", link: undefined },
    { name: "mini", platform: "darwin", link: undefined },
  ];
  const behaviours = new Map<number, Behaviour>();
  const running = new Map<number, Running>();
  const descriptions = new Map<number, string | null>();
  const checkouts = new Map<number, { readonly commit: string | null; readonly deploys: boolean }>();
  const branches = new Map<number, string>();
  const pieces = new Map<number, { readonly branch: string; readonly count: number; readonly closes: readonly number[] }>();
  const outputs = new Map<number, Map<string, Buffer>>();

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
        const number = 100 + work.ticket * 10 + work.piece;
        if (work.repository !== null && work.branch !== null) {
          handBack?.({ ticket: work.ticket, attempt: work.attempt, repository: work.repository, branch: work.branch, pullRequest: number, closes: work.closes, behaviour: work.planned });
        }
        emit(work, {
          kind: "finished",
          pullRequest: number,
          url: `https://github.com/${work.repository ?? "novan-xu/super-agent-sandbox"}/pull/${number}`,
          closes: [...work.closes],
          report: { en: "Implemented the change and its tests.", zh: "改动和测试都写好了。" },
          decisions: [pieceDecisions[(work.piece - 1) % pieceDecisions.length] ?? taskDecision],
        });
        end(work);
      }),
    );
  };

  const fail = (work: Running) => {
    if (work.planned === "fails") {
      tool(work, "test", "pnpm test", [`FAIL src/parser.test.ts > parses relative dates (attempt ${work.attempt})\n`, "AssertionError: expected '2026-11-18' to be '2026-11-17'\n"], false, () => {
        stream(work, "gave-up", words("测试还是不过，我没能交回 PR。"), () => {
          emit(work, { kind: "failed", failure: "no-pull-request", reason: "The program stopped without handing back a pull request" });
          end(work);
        });
      });
      return;
    }
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
          outputs.set(work.ticket, new Map([["notice.md", data]]));
          emit(work, {
            kind: "delivered",
            outcome: "done",
            text: letter,
            files: [{ name: "notice.md", size: data.length, mediaType: "text/markdown" }],
            report: { en: "Wrote the notice and a Markdown copy.", zh: "写好了通知，另附一份 Markdown。" },
            decisions: [taskDecision],
          });
          end(work);
        }),
      ),
    );
  };

  const deploy = (work: Running) => {
    const commit = work.commit ?? "unknown";
    stream(work, "recipe", words(`读了部署配方，按它在这台机器上部署 ${commit.slice(0, 7)}。`), () =>
      tool(work, "deploy", `node scripts/deploy.mjs ${commit}`, ["fetching the commit\n", "building\n", "switching to the new version\n", "the service restarted\n"], true, () =>
        tool(work, "health", "curl -fsS http://127.0.0.1:8080/health", [`{"status":"ok","version":"${commit}"}\n`], true, () =>
          stream(work, "deployed", words("新版本起来了，健康检查通过。"), () => {
            emit(work, {
              kind: "delivered",
              outcome: "done",
              ...(work.commit === null ? {} : { commit: work.commit }),
              text: null,
              files: [],
              report: { en: `Deployed ${commit.slice(0, 7)}; the health check passed.`, zh: `部署了 ${commit.slice(0, 7)}，健康检查通过。` },
              decisions: [deployDecision],
            });
            end(work);
          }),
        ),
      ),
    );
  };

  const begin = (machine: string, ticket: number, attempt: number, model: string, effort: string, resumed: boolean, note: string | null) => {
    const previous = running.get(ticket);
    if (previous !== undefined && !previous.ended && previous.attempt === attempt) {
      return;
    }
    if (previous !== undefined) {
      end(previous);
    }
    const planned = behaviours.get(ticket) ?? (checkouts.get(ticket)?.deploys === true ? "deploy" : checkouts.has(ticket) ? "deliver" : "finish");
    const behaviour: Behaviour = planned === "fail" && attempt > 1 ? "finish" : planned === "fails" ? "fail" : planned === "red-once" || planned === "red-always" ? "finish" : planned;
    const piece = pieces.get(ticket);
    const work: Running = {
      ticket,
      attempt,
      machine,
      behaviour,
      planned,
      repository: descriptions.get(ticket) ?? null,
      branch: branches.get(ticket) ?? null,
      commit: checkouts.get(ticket)?.commit ?? null,
      closes: piece?.closes ?? [],
      piece: piece?.count ?? 1,
      seq: 0,
      step: 0,
      timer: undefined,
      ended: false,
    };
    running.set(ticket, work);
    emit(work, { kind: "phase", phase: "preparing", detail: `Preparing ticket ${ticket}` });
    later(work, 400, () => {
      emit(work, { kind: "phase", phase: resumed ? "resumed" : "started", detail: `Started with ${model} at ${effort}` });
      emit(work, { kind: "ran", model, effort });
      const guided = note === null ? [] : note.startsWith("Pull request #") ? words("上一个 PR 合并了，从更新后的 main 接着做剩下的问题。") : words("收到了引导，先按它说的改，再从头检查一遍。");
      stream(work, "open", [...guided, ...opening], () => {
        if (work.behaviour === "long") {
          loop(work);
        } else if (work.behaviour === "fail") {
          fail(work);
        } else if (work.behaviour === "deliver") {
          deliver(work);
        } else if (work.behaviour === "deploy") {
          deploy(work);
        } else {
          finish(work);
        }
      });
    });
  };

  const receive = (machine: ScriptedMachine, message: HubToRunner) => {
    switch (message.type) {
      case "work.start": {
        const known = pieces.get(message.task.ticket);
        const fresh = known === undefined || known.branch !== message.task.branch;
        pieces.set(message.task.ticket, {
          branch: message.task.branch,
          count: fresh ? (known?.count ?? 0) + 1 : known.count,
          closes: pieceOf(
            message.task.issues.map((issue) => issue.number),
            message.task.merged ?? [],
          ),
        });
        descriptions.set(message.task.ticket, message.task.repository);
        branches.set(message.task.ticket, message.task.branch);
        begin(machine.name, message.task.ticket, message.task.attempt, message.task.model, message.task.effort, message.task.session !== null, message.task.note);
        return;
      }
      case "work.task":
        descriptions.set(message.task.ticket, null);
        checkouts.set(message.task.ticket, { commit: message.task.checkout?.commit ?? null, deploys: message.task.deploys });
        begin(machine.name, message.task.ticket, message.task.attempt, message.task.model, message.task.effort, message.task.session !== null, message.task.note);
        return;
      case "work.message": {
        const work = running.get(message.ticket);
        if (work === undefined || work.ended || work.attempt !== message.attempt) {
          return;
        }
        emit(work, { kind: "message", id: message.id, from: message.from, text: message.text, ...(message.attachments === undefined ? {} : { attachments: message.attachments }), delivery: "steered" });
        emit(work, { kind: "text", block: `reply-${message.id}`, delta: `收到：「${message.text}」。下一步会照这个做。` });
        return;
      }
      case "work.file": {
        const data = outputs.get(message.ticket)?.get(message.name);
        machine.link?.receive({
          type: "work.file.part",
          ticket: message.ticket,
          attempt: message.attempt,
          name: message.name,
          offset: message.offset,
          data: data === undefined ? null : data.subarray(message.offset, message.offset + message.length).toString("base64"),
          problem: data === undefined ? "The scripted worker has no such file" : null,
        });
        return;
      }
      case "work.stop": {
        const work = running.get(message.ticket);
        if (message.remove) {
          outputs.delete(message.ticket);
        }
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
