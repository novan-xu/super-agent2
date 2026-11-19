import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hub, type HubOptions, startHub } from "@super-agent2/hub";
import { assertion, keySet, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "@super-agent2/hub/testing";
import { testCredentials } from "@super-agent2/hub/testing";
import { startTestHub } from "@super-agent2/hub/testing";
import type { OpenOptions, ProgramEvent, ProgramHandle, ProgramListener, SteerResult, WorkerAdapter } from "@super-agent2/programs";
import type { Ticket } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSettings, runnerFiles } from "./config.js";
import { entryFiles, installEntry, readState } from "./entry.js";
import { type Connect, connectWithWs } from "./link.js";
import type { Prober } from "./programs.js";
import { type RunnerService, startRunnerService } from "./service.js";
import { outputFolder, taskPaths } from "./task.js";
import { mainIn, type UpdateSteps } from "./update.js";
import { checkoutOf, revisionFile } from "./version.js";

const versionA = "a".repeat(40);
const versionB = "b".repeat(40);

let dataDir: string;
let home: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
let service: RunnerService | undefined;
let logs: string[];
let wake: Set<() => void>;
let handles: FakeHandle[];
let restarts: number;

const clientId = String(serviceClaims()["common_name"]);

const noPrograms: Prober = { find: () => undefined, capture: async () => "" };

class FakeHandle implements ProgramHandle {
  readonly prompts: string[] = [];
  closed = false;

  constructor(
    readonly options: OpenOptions,
    readonly listener: ProgramListener,
  ) {}

  start(prompt: string): void {
    this.prompts.push(prompt);
    changed();
  }

  steer(): Promise<SteerResult> {
    return Promise.resolve("queued");
  }

  interrupt(): void {
    return;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  processId(): number | undefined {
    return undefined;
  }

  emit(event: ProgramEvent): void {
    this.listener(event);
  }
}

const adapter = (): WorkerAdapter => ({
  provider: "gpt",
  model: "gpt-6-luna",
  effort: "low",
  open: (options, listener) => {
    const handle = new FakeHandle(options, listener);
    handles.push(handle);
    changed();
    return handle;
  },
});

const steps: UpdateSteps = {
  download: async (_version, file) => {
    writeFileSync(file, "archive");
  },
  extract: async (_file, folder) => {
    mkdirSync(join(folder, "packages", "runner", "dist"), { recursive: true });
  },
  install: async (folder) => {
    writeFileSync(mainIn(folder), "built");
  },
  check: async (main) => readFileSync(join(checkoutOf(main), revisionFile), "utf8").trim(),
};

function changed(): void {
  for (const check of [...wake]) {
    check();
  }
}

function until<T>(find: () => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    const check = () => {
      const found = find();
      if (found !== undefined) {
        wake.delete(check);
        resolve(found);
      }
    };
    wake.add(check);
    check();
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "runner-e2e-hub-"));
  home = mkdtempSync(join(tmpdir(), "runner-e2e-home-"));
  clock = new TestClock(Date.now());
  key = await signingKey("key-1");
  logs = [];
  wake = new Set();
  handles = [];
  restarts = 0;
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  await hub?.close();
  hub = undefined;
  for (const folder of [dataDir, home]) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function hubOptions(port: number, version: string): HubOptions {
  return {
    config: { ...testConfig(dataDir), port, version },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [],
    credentials: testCredentials,
    machinePollMilliseconds: 10,
  };
}

function untilLog(predicate: (line: string) => boolean, after = 0): Promise<string> {
  return until(() => logs.slice(after).find(predicate));
}

async function startRunner(running: Hub, token: string, version: string): Promise<RunnerService> {
  if (!running.machines.setStorage("pc", {})) throw new Error("The test machine is missing");
  const files = runnerFiles(home);
  writeFileSync(
    files.settings,
    formatSettings({
      SUPERAGENT2_HUB: `http://127.0.0.1:${running.address.port}`,
      MACHINE_NAME: "pc",
      ACCESS_CLIENT_ID: clientId,
      ACCESS_CLIENT_SECRET: "client-secret",
      RUNNER_TOKEN: token,
    }),
  );
  const signed = await assertion({ key, clock, claims: serviceClaims() });
  const connect: Connect = (url, headers, events) => {
    const forwarded: Record<string, string> = { "cf-access-jwt-assertion": signed };
    for (const [name, value] of Object.entries(headers)) {
      if (!name.startsWith("cf-access-client-")) {
        forwarded[name] = value;
      }
    }
    return connectWithWs(url, forwarded, events);
  };
  const mainPath = join(home, "checkout", "packages", "runner", "dist", "main.js");
  installEntry(home, mainPath, version);
  const started = await startRunnerService({
    files,
    environment: process.env,
    log: (line) => {
      logs.push(line);
      changed();
    },
    prober: noPrograms,
    connect,
    retryDelay: () => 20,
    work: { adapters: adapter, findProgram: (executable) => `/programs/${executable}` },
    mainPath,
    version,
    supervised: true,
    restart: () => {
      restarts += 1;
      changed();
    },
    updateSteps: steps,
  });
  if (started === undefined) {
    throw new Error(`The runner did not start: ${logs.join("\n")}`);
  }
  service = started;
  await untilLog((line) => line.startsWith("Connected to the hub as pc"));
  return started;
}

function openTask(running: Hub): Ticket {
  const opened = running.tickets.open({
    form: "task",
    repository: null,
    issues: [],
    title: { en: "Deploy Super-agent2", zh: "部署 Super-agent2" },
    summary: { en: "Release the merged commit on the NAS", zh: "在 NAS 上发布合并后的版本" },
    kind: "operation",
    conversation: running.conversations.create().id,
    task: { task: "Release the commit on the NAS and check that the hub and the brain come back.", materials: [] },
  });
  running.tickets.change((writes) => {
    writes.choose(opened.id, { machine: "pc", engine: "codex", model: "gpt-6-luna", effort: "low", by: { machine: "owner", engine: "owner", model: "owner", effort: "owner" } });
    writes.move(opened.id, "working");
  });
  const ticket = running.tickets.get(opened.id);
  if (ticket === undefined || running.work === undefined) {
    throw new Error("setup failed");
  }
  running.work.begin(ticket);
  return ticket;
}

function handBack(ticket: number): void {
  const paths = taskPaths(home, ticket);
  mkdirSync(outputFolder(paths), { recursive: true });
  writeFileSync(paths.handback, JSON.stringify({ outcome: "done", report: { en: "Released; the hub and the brain answer.", zh: "发布好了，hub 和大脑都正常。" } }));
}

function untilState(running: Hub, ticket: number, state: Ticket["state"]): Promise<Ticket> {
  return new Promise((resolve) => {
    const check = () => {
      const found = running.tickets.get(ticket);
      if (found?.state === state) {
        unsubscribe();
        resolve(found);
      }
    };
    const unsubscribe = running.tickets.subscribe(check);
    check();
  });
}

describe("a task ticket whose work restarts the hub under it", { timeout: 30000 }, () => {
  it("keeps the worker running while the hub is replaced, delivers its hand-back to the new hub, and then moves the runner to the new hub's version", async () => {
    const first = await startTestHub(hubOptions(0, versionA));
    hub = first;
    const port = first.address.port;
    const { token } = first.machines.add({ name: "pc", accessClientId: clientId });
    await startRunner(first, token, versionA);
    const ticket = openTask(first);
    const worker = await until(() => handles.find((handle) => handle.prompts.length === 1));
    expect(worker.prompts[0]).toContain("# Guidance for a task worker");
    expect(worker.prompts[0]).toContain("may restart the hub");

    const before = logs.length;
    await first.close();
    hub = undefined;
    await untilLog((line) => line.startsWith("The connection closed"), before);
    expect(worker.closed).toBe(false);
    expect(service?.works.busy()).toBe(1);

    const second = await startHub(hubOptions(port, versionB));
    hub = second;
    await untilLog((line) => line === "Connected to the hub as pc, which runs bbbbbbb", before);
    await untilLog((line) => line === "Version bbbbbbb is ready; the runner switches to it once its 1 running piece(s) of work end", before);
    expect(restarts).toBe(0);
    expect(second.tickets.get(ticket.id)?.work).toMatchObject({ attempt: 1, unreachableSince: null });

    handBack(ticket.id);
    worker.emit({ type: "turn.finished", outcome: "completed" });
    const delivered = await untilState(second, ticket.id, "delivered");
    expect(delivered.report).toEqual({ en: "Released; the hub and the brain answer.", zh: "发布好了，hub 和大脑都正常。" });
    expect(second.work?.events(ticket.id).at(-1)?.event).toMatchObject({ kind: "delivered", outcome: "done" });
    await until(() => (restarts > 0 ? restarts : undefined));
    expect(restarts).toBe(1);
    expect(readState(entryFiles(home))).toMatchObject({ currentVersion: versionB, previousVersion: versionA, trial: 0 });
  });

  it("stays at its version when the hub's release went back, and still delivers to the hub that came back", async () => {
    const first = await startTestHub(hubOptions(0, versionA));
    hub = first;
    const port = first.address.port;
    const { token } = first.machines.add({ name: "pc", accessClientId: clientId });
    await startRunner(first, token, versionA);
    const ticket = openTask(first);
    const worker = await until(() => handles.find((handle) => handle.prompts.length === 1));

    const before = logs.length;
    await first.close();
    hub = undefined;
    const newer = await startHub(hubOptions(port, versionB));
    hub = newer;
    await untilLog((line) => line === "Version bbbbbbb is ready; the runner switches to it once its 1 running piece(s) of work end", before);
    const backAt = logs.length;
    await newer.close();
    hub = undefined;
    const previous = await startHub(hubOptions(port, versionA));
    hub = previous;
    await untilLog((line) => line === "The hub runs aaaaaaa again, the version of this runner, so it does not switch to bbbbbbb", backAt);

    handBack(ticket.id);
    worker.emit({ type: "turn.finished", outcome: "completed" });
    await untilState(previous, ticket.id, "delivered");
    await service?.works.idle();
    expect(service?.works.busy()).toBe(0);
    expect(restarts).toBe(0);
    expect(readState(entryFiles(home))).toMatchObject({ currentVersion: versionA });
  });
});
