import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "@super-agent2/catalog";
import type { CommandRecord } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandGate, type CommandService, createCommandService, interruptedReason } from "./commands.js";
import { environmentCredentials } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { TestClock } from "./testing/access.js";
import {
  nodeScript,
  recordingTarget,
  scriptFile,
  testCredentials,
  testEnvironment,
  testTokens,
  textOf,
  waitForFile,
  waitForOutput,
  waitForState,
} from "./testing/commands.js";

let dataDir: string;
let workDir: string;
let clock: TestClock;
let database: HubDatabase;
let service: CommandService | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-commands-"));
  workDir = mkdtempSync(join(tmpdir(), "hub-work-"));
  clock = new TestClock();
  database = openDatabase({ dataDir, clock });
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function create(gate?: CommandGate) {
  const environment = testEnvironment();
  const hubTarget = recordingTarget("hub", environment);
  const nasTarget = recordingTarget("nas", {});
  service = createCommandService({
    database,
    clock,
    targets: [hubTarget, nasTarget],
    credentials: environmentCredentials(environment),
    ...(gate === undefined ? {} : { gate }),
  });
  return { service, hubTarget, nasTarget };
}

async function finished(running: CommandService, id: string): Promise<CommandRecord> {
  const record = await running.finished(id);
  if (record === undefined) {
    throw new Error(`Command ${id} is unknown`);
  }
  return record;
}

const envProbe = `
const env = process.env;
console.log(JSON.stringify({
  gh: env.GH_TOKEN ?? null,
  github: env.GITHUB_TOKEN ?? null,
  novan: env.GITHUB_TOKEN_NOVAN_XU ?? null,
  island: env.GITHUB_TOKEN_NUOFAN_ISLAND ?? null,
}));
`;

describe("running a command", () => {
  it("runs a program the code has never heard of and returns its output and exit code", async () => {
    const { service: running } = create();
    const marker = randomUUID();
    const command = nodeScript(workDir, `console.log(${JSON.stringify(marker)}); process.exit(7);`, `${randomUUID()}.mjs`);
    const started = running.start({ target: "hub", command });
    expect(started.state).toBe("pending");
    const record = await finished(running, started.id);
    expect(record).toMatchObject({ state: "exited", exitCode: 7, signal: null, target: "hub", command, account: "novan-xu" });
    expect(record.startedAt).not.toBeNull();
    expect(record.endedAt).not.toBeNull();
    expect(textOf(running.output(started.id), "stdout").trim()).toBe(marker);
  });

  it("runs on the NAS target as well", async () => {
    const { service: running, nasTarget } = create();
    const command = nodeScript(workDir, `process.stderr.write("from the nas"); process.exit(2);`);
    const record = await finished(running, running.start({ target: "nas", command }).id);
    expect(record).toMatchObject({ state: "exited", exitCode: 2, target: "nas" });
    expect(textOf(running.output(record.id), "stderr")).toBe("from the nas");
    expect(nasTarget.jobs.map((job) => job.command)).toEqual([command]);
  });

  it("runs in the requested folder", async () => {
    const { service: running } = create();
    const command = nodeScript(workDir, `console.log(process.cwd());`);
    const record = await finished(running, running.start({ target: "hub", command, cwd: workDir }).id);
    expect(record.cwd).toBe(workDir);
    const printed = realpathSync.native(textOf(running.output(record.id)).trim());
    expect(printed.toLowerCase()).toBe(realpathSync.native(workDir).toLowerCase());
  });

  it("gives the command the chosen account's token and not the other's", async () => {
    const { service: running, nasTarget } = create();
    const command = nodeScript(workDir, envProbe);
    for (const account of ["novan-xu", "nuofan-island"] as const) {
      const record = await finished(running, running.start({ target: "hub", command, account }).id);
      expect(record.account).toBe(account);
      expect(JSON.parse(textOf(running.output(record.id)))).toEqual({
        gh: testTokens[account],
        github: testTokens[account],
        novan: null,
        island: null,
      });
    }
    await finished(running, running.start({ target: "nas", command, account: "nuofan-island" }).id);
    expect(nasTarget.jobs[0]?.credentials["GH_TOKEN"]).toBe(testTokens["nuofan-island"]);
  });

  it("gives the command the environment it was started with, keeps it on the record, and refuses a credential's name", async () => {
    const { service: running, nasTarget } = create();
    const command = nodeScript(workDir, `console.log(JSON.stringify({ commit: process.env.SUPERAGENT2_COMMIT ?? null, gh: process.env.GH_TOKEN ?? null }));`);
    const record = await finished(running, running.start({ target: "hub", command, environment: { SUPERAGENT2_COMMIT: "abc1234" } }).id);
    expect(record.environment).toEqual({ SUPERAGENT2_COMMIT: "abc1234" });
    expect(JSON.parse(textOf(running.output(record.id)))).toEqual({ commit: "abc1234", gh: testTokens["novan-xu"] });
    for (const name of ["GH_TOKEN", "github_token", "GITHUB_TOKEN_NUOFAN_ISLAND", "WOODPECKER_TOKEN", "Cloudflare_Api_Token"]) {
      expect(() => running.start({ target: "hub", command, environment: { [name]: "not-a-token" } })).toThrow(/credentials are given by the hub alone/);
    }
    expect(running.list().every((entry) => Object.keys(entry.environment).every((name) => name.startsWith("SUPERAGENT2_")))).toBe(true);
    await finished(running, running.start({ target: "nas", command: "true", environment: { SUPERAGENT2_COMMIT: "abc1234" } }).id);
    expect(nasTarget.jobs[0]?.credentials["SUPERAGENT2_COMMIT"]).toBe("abc1234");
    expect(() => running.start({ target: "hub", command, environment: { "NOT A NAME": "x" } })).toThrow();
  });

  it("streams output in order while the command is still running", async () => {
    const { service: running } = create();
    const first = join(workDir, "first");
    const second = join(workDir, "second");
    const command = nodeScript(
      workDir,
      `${waitForFile}
process.stdout.write("one\\n");
await until(${JSON.stringify(first)});
process.stderr.write("two\\n");
await until(${JSON.stringify(second)});
process.stdout.write("three\\n");
process.exit(3);
`,
    );
    const live: string[] = [];
    running.subscribe((event) => {
      if (event.type === "output") {
        live.push(event.chunk.data);
      }
    });
    const { id } = running.start({ target: "hub", command });
    await waitForOutput(running, id, "one");
    expect(running.get(id)?.state).toBe("running");
    writeFileSync(first, "");
    await waitForOutput(running, id, "two");
    expect(running.get(id)?.state).toBe("running");
    writeFileSync(second, "");
    const record = await finished(running, id);
    expect(record).toMatchObject({ state: "exited", exitCode: 3 });
    const chunks = running.output(id);
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index + 1));
    expect(chunks.map((chunk) => [chunk.stream, chunk.data])).toEqual([
      ["stdout", "one\n"],
      ["stderr", "two\n"],
      ["stdout", "three\n"],
    ]);
    expect(live.join("")).toBe("one\ntwo\nthree\n");
    expect(running.output(id, 2).map((chunk) => chunk.data)).toEqual(["three\n"]);
  });

  it("stops a running command together with the processes it started", async () => {
    const { service: running } = create();
    const child = scriptFile(workDir, `console.log("grandchild ready"); setInterval(() => undefined, 1000);`);
    const command = nodeScript(
      workDir,
      `
import { spawn } from "node:child_process";
spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(child)}], { stdio: "inherit" });
console.log("parent ready");
setInterval(() => undefined, 1000);
`,
    );
    const { id } = running.start({ target: "hub", command });
    await waitForOutput(running, id, "grandchild ready");
    expect(running.stop(id)?.state).toBe("running");
    const record = await finished(running, id);
    expect(record.state).toBe("stopped");
    expect(record.endedAt).not.toBeNull();
    expect(running.get(id)?.state).toBe("stopped");
  });

  it("records a command that cannot start as failed", async () => {
    const { service: running } = create();
    const record = await finished(running, running.start({ target: "hub", command: "anything", cwd: join(workDir, "missing") }).id);
    expect(record.state).toBe("failed");
    expect(record.reason).not.toBeNull();
  });

  it("records an unknown target as failed", async () => {
    const { service: running } = create();
    const record = await finished(running, running.start({ target: "elsewhere", command: "anything" }).id);
    expect(record).toMatchObject({ state: "failed", reason: text("command.reason.noTarget", { target: "elsewhere" }) });
  });

  it("refuses to run without the chosen account's token and names the missing variable only", async () => {
    service = createCommandService({
      database,
      clock,
      targets: [recordingTarget("hub", {})],
      credentials: environmentCredentials({ GITHUB_TOKEN_NOVAN_XU: testTokens["novan-xu"] }),
    });
    const record = await finished(service, service.start({ target: "hub", command: "anything", account: "nuofan-island" }).id);
    expect(record.state).toBe("failed");
    expect(record.reason).toContain("GITHUB_TOKEN_NUOFAN_ISLAND");
    expect(record.reason).not.toContain(testTokens["novan-xu"]);
  });

  it("rejects a request that is not a command", () => {
    const { service: running } = create();
    expect(() => running.start({ target: "hub", command: "" })).toThrow();
    expect(() => running.start({ target: "Hub Machine", command: "x" })).toThrow();
    expect(running.list()).toEqual([]);
  });

  it("lists commands newest first", async () => {
    const { service: running } = create();
    const command = nodeScript(workDir, "");
    const first = running.start({ target: "hub", command });
    const second = running.start({ target: "hub", command });
    await finished(running, first.id);
    await finished(running, second.id);
    expect(running.list().map((record) => record.id)).toEqual([second.id, first.id]);
    expect(running.list(1).map((record) => record.id)).toEqual([second.id]);
  });
});

describe("the gate", () => {
  it("sees every command before it starts", async () => {
    const seen: CommandRecord[] = [];
    const { service: running } = create((command) => {
      seen.push(command);
      return { kind: "allow" };
    });
    const command = nodeScript(workDir, "");
    const record = await finished(running, running.start({ target: "hub", command }).id);
    expect(record.state).toBe("exited");
    expect(seen.map((entry) => [entry.id, entry.state, entry.command])).toEqual([[record.id, "pending", command]]);
  });

  it("can hold a command and later release it", async () => {
    let release: () => void = () => undefined;
    const { service: running, hubTarget } = create(async (_command, control) => {
      control.hold("waiting for the owner");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { kind: "allow" };
    });
    const { id } = running.start({ target: "hub", command: nodeScript(workDir, `console.log("released");`) });
    const held = await waitForState(running, id, "held");
    expect(held.reason).toBe("waiting for the owner");
    expect(hubTarget.jobs).toEqual([]);
    release();
    const record = await finished(running, id);
    expect(record).toMatchObject({ state: "exited", exitCode: 0, reason: null });
    expect(textOf(running.output(id)).trim()).toBe("released");
  });

  it("can hold a command and later drop it", async () => {
    let drop: () => void = () => undefined;
    const { service: running, hubTarget } = create(async (_command, control) => {
      control.hold("waiting for the owner");
      await new Promise<void>((resolve) => {
        drop = resolve;
      });
      return { kind: "drop", reason: "the owner declined" };
    });
    const { id } = running.start({ target: "hub", command: "anything" });
    await waitForState(running, id, "held");
    drop();
    const record = await finished(running, id);
    expect(record).toMatchObject({ state: "dropped", reason: "the owner declined", startedAt: null, exitCode: null });
    expect(hubTarget.jobs).toEqual([]);
  });

  it("lets a held command be stopped, and tells the gate", async () => {
    let aborted = false;
    const { service: running, hubTarget } = create(
      (_command, control) =>
        new Promise((resolve) => {
          control.hold("waiting for the owner");
          control.stopped.addEventListener("abort", () => {
            aborted = true;
            resolve({ kind: "allow" });
          });
        }),
    );
    const { id } = running.start({ target: "hub", command: "anything" });
    await waitForState(running, id, "held");
    expect(running.stop(id)?.state).toBe("stopped");
    const record = await finished(running, id);
    expect(record.state).toBe("stopped");
    expect(aborted).toBe(true);
    expect(hubTarget.jobs).toEqual([]);
  });

  it("records a gate that fails as a failed command", async () => {
    const { service: running } = create(() => {
      throw new Error("the gate broke");
    });
    const record = await finished(running, running.start({ target: "hub", command: "anything" }).id);
    expect(record).toMatchObject({ state: "failed", reason: "the gate broke" });
  });
});

describe("the end of the hub", () => {
  it("stops running commands when it closes and records them as interrupted", async () => {
    const { service: running } = create();
    const command = nodeScript(workDir, `console.log("ready"); setInterval(() => undefined, 1000);`);
    const { id } = running.start({ target: "hub", command });
    await waitForOutput(running, id, "ready");
    await running.close();
    service = undefined;
    expect(running.get(id)).toMatchObject({ state: "interrupted", reason: interruptedReason });
    expect(() => running.start({ target: "hub", command })).toThrow();
  });

  it("marks commands left running by a hub that died as interrupted, and asks the gate again about held ones", async () => {
    const insert = database.connection.prepare(
      "INSERT INTO commands (id, target, command, account, state, created_at) VALUES (?, 'hub', 'x', 'novan-xu', ?, ?)",
    );
    insert.run("pending-one", "pending", clock.now());
    insert.run("running-one", "running", clock.now());
    insert.run("held-one", "held", clock.now());
    insert.run("done-one", "exited", clock.now());
    clock.advance(60_000);
    const seen: CommandRecord[] = [];
    let drop: (reason: string) => void = () => undefined;
    service = createCommandService({
      database,
      clock,
      targets: [],
      credentials: testCredentials,
      gate: (command) => {
        seen.push(command);
        return new Promise((resolve) => {
          drop = (reason) => resolve({ kind: "drop", reason });
        });
      },
    });
    expect(service.get("pending-one")).toMatchObject({ state: "interrupted", endedAt: clock.now(), reason: interruptedReason });
    expect(service.get("running-one")).toMatchObject({ state: "interrupted", endedAt: clock.now(), reason: interruptedReason });
    expect(service.get("done-one")?.state).toBe("exited");
    expect(service.get("held-one")?.state).toBe("held");
    expect(seen.map((command) => [command.id, command.state])).toEqual([["held-one", "held"]]);
    drop("refused");
    expect(await service.finished("held-one")).toMatchObject({ state: "dropped", reason: "refused" });
  });

  it("leaves a held command held when it closes", async () => {
    const { service: running } = create((_command, control) => {
      control.hold("waiting for the owner");
      return new Promise(() => undefined);
    });
    const { id } = running.start({ target: "hub", command: "anything" });
    await waitForState(running, id, "held");
    await running.close();
    service = undefined;
    expect(running.get(id)).toMatchObject({ state: "held", reason: "waiting for the owner", endedAt: null });
  });
});
