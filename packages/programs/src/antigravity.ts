import { z } from "zod";
import type { OpenOptions, ProgramAdapter, ProgramEvent, ProgramHandle, ProgramListener } from "./program.js";
import { exitReason, invocationOf, type LineProcess, spawnLines } from "./process.js";
import type { ProgramSettings } from "./settings.js";

export function antigravityArguments(settings: ProgramSettings, session: string | null): string[] {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    settings.model,
    "--effort",
    settings.effort,
    "--disable-slash-commands",
    ...(session === null ? [] : ["--conversation", session]),
    "--print=",
  ];
}

const Output = z.looseObject({ event: z.string() });

const Init = z.looseObject({
  conversation_id: z.string().optional(),
  init: z.looseObject({ model: z.string().optional() }).optional(),
});

const Step = z.looseObject({
  step_update: z.looseObject({
    conversation_id: z.string().optional(),
    step_index: z.number(),
    state: z.string(),
    step_type: z.string(),
    text_delta: z.string().optional(),
    tool_name: z.string().optional(),
    tool_info: z.looseObject({ name: z.string().optional(), parameters: z.unknown().optional(), output: z.unknown().optional() }).optional(),
  }),
});

const Result = z.looseObject({
  result: z.looseObject({
    conversation_id: z.string().optional(),
    status: z.string(),
    error: z.string().optional(),
    finished_reason: z.string().optional(),
  }),
});

const limitWords = /quota|rate.?limit|resource.?exhausted|credits|spend.?cap|balance|too many requests|\b429\b|capacity/i;

const accessWords = /not signed in|sign in|sign-in|log in|login|authenticat|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i;

export function antigravityFailure(reason: string): ProgramEvent {
  if (/conversation .* not found/i.test(reason)) {
    return { type: "failed", reason, lostSession: true };
  }
  if (limitWords.test(reason) || accessWords.test(reason)) {
    return { type: "unavailable", reason, until: null, category: /capacity/i.test(reason) ? "overload" : limitWords.test(reason) ? "limit" : "problem" };
  }
  return { type: "failed", reason, lostSession: false };
}

export function antigravityResult(status: string, error: string | undefined, finishedReason: string | undefined): ProgramEvent {
  if (finishedReason === "interrupted") {
    return { type: "turn.finished", outcome: "interrupted" };
  }
  if (status === "SUCCESS" && finishedReason === undefined) {
    return { type: "turn.finished", outcome: "completed" };
  }
  const reason = error !== undefined && error !== "" ? error : `Antigravity ended the turn with ${finishedReason ?? status}`;
  return antigravityFailure(reason);
}

function toolFailed(state: string): boolean {
  return /err|fail|cancel|denied|reject/i.test(state);
}

function textOf(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function antigravityAdapter(settings: ProgramSettings): ProgramAdapter<"antigravity"> {
  return {
    provider: "antigravity",
    model: settings.model,
    effort: settings.effort,
    open: (options, listener) => openAntigravity(settings, options, listener),
  };
}

function openAntigravity(settings: ProgramSettings, options: OpenOptions, listener: ProgramListener): ProgramHandle {
  if (options.tools !== null) {
    throw new Error("Antigravity is not given the hub's tools");
  }
  let session = options.session;
  let current: LineProcess | undefined;
  let running = false;
  let stopping = false;
  let closed = false;
  let reportedModel = false;
  const begun = new Set<string>();

  const fail = (event: ProgramEvent) => {
    if (closed || !running) {
      return;
    }
    running = false;
    listener(event);
  };

  const onOutput = (child: LineProcess, raw: unknown) => {
    if (current !== child) {
      return;
    }
    const base = Output.safeParse(raw);
    if (!base.success) {
      return;
    }
    switch (base.data.event) {
      case "init": {
        const init = Init.safeParse(raw);
        if (!init.success) {
          return;
        }
        const id = init.data.conversation_id;
        if (session !== null && id !== undefined && id !== session) {
          stopping = true;
          child.kill();
          fail({ type: "failed", reason: `Antigravity could not find the conversation ${session} to resume`, lostSession: true });
          return;
        }
        if (session === null && id !== undefined && id !== "") {
          session = id;
          listener({ type: "session", session: id });
        }
        const model = init.data.init?.model;
        if (model !== undefined && !reportedModel) {
          reportedModel = true;
          listener({ type: "model", model, effort: null });
        }
        return;
      }
      case "step_update": {
        if (!running) {
          return;
        }
        const step = Step.safeParse(raw);
        if (!step.success) {
          return;
        }
        const update = step.data.step_update;
        const where = update.conversation_id ?? session ?? "agy";
        if (update.step_type === "agent_response" && update.text_delta !== undefined && update.text_delta !== "") {
          listener({ type: "text", block: `${where}:${update.step_index}`, delta: update.text_delta });
          return;
        }
        if (update.step_type !== "tool") {
          return;
        }
        const call = `${where}:${update.step_index}`;
        const info = update.tool_info;
        if (!begun.has(call)) {
          begun.add(call);
          listener({
            type: "tool.started",
            call,
            name: update.tool_name ?? info?.name ?? "tool",
            input: JSON.stringify(info?.parameters ?? {}),
          });
        }
        if (update.state === "DONE" || toolFailed(update.state)) {
          listener({ type: "tool.finished", call, output: textOf(info?.output), ok: update.state === "DONE" });
        }
        return;
      }
      case "result": {
        if (!running) {
          return;
        }
        const result = Result.safeParse(raw);
        if (!result.success) {
          return;
        }
        const { status, error, finished_reason: finishedReason } = result.data.result;
        const event = antigravityResult(status, error, finishedReason);
        running = false;
        listener(event);
        return;
      }
    }
  };

  const launch = (): LineProcess => {
    let child: LineProcess | undefined;
    const started = spawnLines(invocationOf(settings.program, antigravityArguments(settings, session)), {
      cwd: options.workspace,
      env: settings.environment,
      onMessage: (message) => {
        if (child !== undefined) {
          onOutput(child, message);
        }
      },
      tree: settings.processTree === true,
    });
    child = started;
    current = started;
    void started.exited.then((exit) => {
      if (current === started) {
        current = undefined;
      }
      if (closed) {
        return;
      }
      if (stopping) {
        stopping = false;
        if (running) {
          running = false;
          listener({ type: "turn.finished", outcome: "interrupted" });
        }
        return;
      }
      fail({ type: "failed", reason: exitReason("antigravity", exit, started.stderr()), lostSession: false });
    });
    return started;
  };

  launch();

  return {
    start: (prompt) => {
      running = true;
      stopping = false;
      (current ?? launch()).write({ event: "user", message: { content: prompt } });
    },
    steer: () => Promise.resolve("queued"),
    interrupt: () => {
      if (!running || current === undefined) {
        return;
      }
      stopping = true;
      current.kill();
    },
    close: async () => {
      closed = true;
      const child = current;
      current = undefined;
      if (child !== undefined) {
        child.end();
        child.kill();
        await child.exited;
      }
    },
    processId: () => current?.pid,
  };
}
