import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "@super-agent2/catalog";
import { type Hub, type HubOptions, startHub } from "@super-agent2/hub";
import { assertion, keySet, serviceClaims, signingKey, type SigningKey, staticKeySource, TestClock, testConfig } from "@super-agent2/hub/testing";
import { testCredentials, waitForState } from "@super-agent2/hub/testing";
import { startTestHub } from "@super-agent2/hub/testing";
import { brainToolsPath, type CommandRecord } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSettings, runnerFiles } from "./config.js";
import { type Connect, connectWithWs } from "./link.js";
import type { Prober } from "./programs.js";
import { type RunnerService, startRunnerService } from "./service.js";

let dataDir: string;
let workDir: string;
let home: string;
let clock: TestClock;
let key: SigningKey;
let hub: Hub | undefined;
let service: RunnerService | undefined;
let logs: string[];
let wakeLogs: Set<() => void>;

const clientId = String(serviceClaims()["common_name"]);

const noPrograms: Prober = { find: () => undefined, capture: async () => "" };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "runner-e2e-hub-"));
  workDir = mkdtempSync(join(tmpdir(), "runner-e2e-work-"));
  home = mkdtempSync(join(tmpdir(), "runner-e2e-home-"));
  clock = new TestClock(Date.now());
  key = await signingKey("key-1");
  logs = [];
  wakeLogs = new Set();
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  await hub?.close();
  hub = undefined;
  for (const folder of [dataDir, workDir, home]) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function hubOptions(port: number): HubOptions {
  return {
    config: { ...testConfig(dataDir), port, projectFolders: [workDir] },
    keySource: staticKeySource(keySet(key)),
    clock,
    targets: [],
    credentials: testCredentials,
    machinePollMilliseconds: 10,
  };
}

function untilLog(predicate: (line: string) => boolean, after = 0): Promise<string> {
  return new Promise((resolve) => {
    const check = () => {
      const found = logs.slice(after).find(predicate);
      if (found !== undefined) {
        wakeLogs.delete(check);
        resolve(found);
      }
    };
    wakeLogs.add(check);
    check();
  });
}

async function startRunner(running: Hub, token: string): Promise<RunnerService> {
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
  const started = await startRunnerService({
    files,
    environment: process.env,
    log: (line) => {
      logs.push(line);
      for (const wake of [...wakeLogs]) {
        wake();
      }
    },
    prober: noPrograms,
    connect,
    retryDelay: () => 20,
  });
  if (started === undefined) {
    throw new Error(`The runner did not start: ${logs.join("\n")}`);
  }
  service = started;
  await untilLog((line) => line === "Connected to the hub as pc");
  return started;
}

function nodeCommand(source: string): string {
  const path = join(workDir, `script-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, source);
  return `"${process.execPath}" "${path}"`;
}

function outputOf(running: Hub, id: string): string {
  return running.commands
    .output(id)
    .map((chunk) => chunk.data)
    .join("");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function untilGone(pid: number): Promise<void> {
  while (alive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function untilFile(path: string): Promise<string> {
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readFileSync(path, "utf8").trim();
}

function treeCommand(pidFile: string): string {
  const child = `setInterval(() => undefined, 1000);`;
  return nodeCommand(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore", windowsHide: true });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
console.log("started", child.pid);
setInterval(() => undefined, 1000);
`);
}

describe("a real runner against a real hub", () => {
  it("runs a command by the machine's name through the command service and through the brain's tools", async () => {
    const running = await startTestHub(hubOptions(0));
    hub = running;
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    await startRunner(running, token);
    expect(running.runners.statuses()).toEqual([expect.objectContaining({ name: "pc", online: true })]);
    const record = running.commands.start({ target: "pc", command: nodeCommand(`console.log("hello from " + (process.env.GH_TOKEN ? "a machine with a token" : "nowhere"))`), cwd: workDir });
    expect(await running.commands.finished(record.id)).toMatchObject({ state: "exited", exitCode: 0 });
    expect(outputOf(running, record.id)).toContain("hello from a machine with a token");

    const brainToken = readFileSync(join(dataDir, "brain.token"), "utf8").trim();
    const answer = await fetch(`http://127.0.0.1:${running.address.port}${brainToolsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${brainToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_command", arguments: { target: "pc", command: nodeCommand(`console.log("through the tools")`) } },
      }),
    });
    const body = (await answer.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(body.result.isError ?? false).toBe(false);
    expect(body.result.content.map((part) => part.text).join("")).toContain("through the tools");
  });

  it("stops a long command together with the processes it started", async () => {
    const running = await startTestHub(hubOptions(0));
    hub = running;
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    await startRunner(running, token);
    const pidFile = join(workDir, "grandchild.pid");
    const record = running.commands.start({ target: "pc", command: treeCommand(pidFile) });
    const grandchild = Number(await untilFile(pidFile));
    expect(alive(grandchild)).toBe(true);
    running.commands.stop(record.id);
    expect(await running.commands.finished(record.id)).toMatchObject({ state: "stopped" });
    await untilGone(grandchild);
    expect(alive(grandchild)).toBe(false);
  });

  it("holds a command on the lock's list for the machine as for any other target", async () => {
    const running = await startTestHub(hubOptions(0));
    hub = running;
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    await startRunner(running, token);
    const record = running.commands.start({ target: "pc", command: "gh repo delete novan-xu/old-experiments --yes" });
    const held: CommandRecord = await waitForState(running.commands, record.id, "held");
    expect(held.target).toBe("pc");
    expect(running.lock?.waiting().map((hold) => hold.command)).toEqual([record.id]);
    expect(logs.some((line) => line.startsWith("Command "))).toBe(false);
  });

  it("comes back by itself after the hub restarts, and leaves the interrupted command truthfully recorded", async () => {
    const first = await startTestHub(hubOptions(0));
    hub = first;
    const port = first.address.port;
    const { token } = first.machines.add({ name: "pc", accessClientId: clientId });
    await startRunner(first, token);
    const pidFile = join(workDir, "grandchild.pid");
    const record = first.commands.start({ target: "pc", command: treeCommand(pidFile) });
    const grandchild = Number(await untilFile(pidFile));
    const before = logs.length;
    await first.close();
    hub = undefined;
    await untilLog((line) => line.startsWith("The connection closed"), before);
    await untilGone(grandchild);
    const second = await startHub(hubOptions(port));
    hub = second;
    expect(second.commands.get(record.id)).toMatchObject({ state: "interrupted", reason: text("command.reason.interrupted") });
    await untilLog((line) => line === "Connected to the hub as pc", before);
    const again = second.commands.start({ target: "pc", command: nodeCommand(`console.log("back again")`) });
    expect(await second.commands.finished(again.id)).toMatchObject({ state: "exited" });
    expect(outputOf(second, again.id)).toContain("back again");
  });

  it("is refused once revoked, and its running command is interrupted", async () => {
    const running = await startTestHub(hubOptions(0));
    hub = running;
    const { token } = running.machines.add({ name: "pc", accessClientId: clientId });
    await startRunner(running, token);
    const pidFile = join(workDir, "grandchild.pid");
    const record = running.commands.start({ target: "pc", command: treeCommand(pidFile) });
    const grandchild = Number(await untilFile(pidFile));
    const before = logs.length;
    running.runners.revoke("pc");
    expect(await running.commands.finished(record.id)).toMatchObject({
      state: "interrupted",
      reason: text("command.reason.machineLost", { target: "pc" }),
    });
    await untilLog((line) => line === "The hub refused the connection (HTTP 403)", before);
    await untilGone(grandchild);
    const refused = running.commands.start({ target: "pc", command: "echo no" });
    expect(await running.commands.finished(refused.id)).toMatchObject({ state: "failed" });
  });
});
