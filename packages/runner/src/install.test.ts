import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSettings, runnerFiles } from "./config.js";
import { bootstrapSource, entryFiles, readState } from "./entry.js";
import {
  type InstallContext,
  type ProcessLook,
  claimSupervisor,
  describeAutostart,
  ensureWindowsTask,
  identifySupervisor,
  install,
  isSupervisorLine,
  pipeHeld,
  processLookScript,
  readProcessLook,
  stopSupervisor,
  supervisorState,
  keepAutostart,
  launchAgentPath,
  launchAgentPlist,
  launchSupervisor,
  macosLabel,
  supervisedVariable,
  supervisorPipe,
  uninstall,
  windowsRunCommand,
  windowsRunKey,
  windowsRunValue,
  windowsTaskFile,
  windowsTaskMinutes,
  windowsTaskName,
  windowsTaskXml,
} from "./install.js";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "runner-install-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Fake {
  readonly settings?: boolean;
  readonly ownHome?: boolean;
  readonly missing?: readonly string[];
  readonly held?: boolean;
  readonly processes?: Readonly<Record<number, ProcessLook>>;
}

const deadPid = 999999999;

function supervisorLine(home: string): ProcessLook {
  return { kind: "line", line: `"C:\\Program Files\\nodejs\\node.exe" ${join(home, "start.mjs")} supervise` };
}

const runValue = `reg query ${windowsRunKey}`;
const task = `schtasks /query /tn ${windowsTaskName}`;
const taskRun = `schtasks /run /tn ${windowsTaskName}`;
const taskCreate = `schtasks /create /tn ${windowsTaskName}`;

function context(platform: NodeJS.Platform, fake: Fake = {}) {
  const { settings = true, ownHome = false, missing = [], held = false, processes = {} } = fake;
  const files = runnerFiles(join(folder, ".superagent2"));
  if (settings) {
    mkdirSync(files.home, { recursive: true });
    writeFileSync(
      files.settings,
      formatSettings({
        SUPERAGENT2_HUB: "https://agent.example.com",
        MACHINE_NAME: "mac-mini",
        ACCESS_CLIENT_ID: "id.access",
        ACCESS_CLIENT_SECRET: "secret",
        RUNNER_TOKEN: "r".repeat(43),
      }),
    );
  }
  const commands: string[][] = [];
  const said: string[] = [];
  const started: string[] = [];
  const registered: string[] = [];
  const looked: number[] = [];
  const stopped: number[] = [];
  const value: InstallContext = {
    files,
    platform,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    mainPath: "C:\\work\\super-agent2\\packages\\runner\\dist\\main.js",
    version: "c".repeat(40),
    environment: { PATH: "/usr/local/bin:/usr/bin:/bin", SystemRoot: "C:\\WINDOWS", ...(ownHome ? {} : { SUPERAGENT2_RUNNER_HOME: files.home }) },
    execute: (program, args) => {
      commands.push([program, ...args]);
      const line = [program, ...args].join(" ");
      if (line.startsWith(taskCreate)) {
        registered.push(readFileSync(args.at(-2) ?? "", "utf16le"));
      }
      if ((program === "launchctl" && args[0] === "bootout") || missing.some((start) => line.startsWith(start))) {
        throw new Error("not there");
      }
    },
    say: (line) => said.push(line),
    launchAgents: join(folder, "LaunchAgents"),
    uid: 501,
    spawnSupervisor: () => started.push("supervisor"),
    pipeHeld: (path) => Promise.resolve(held && path === supervisorPipe(files.home)),
    lookUpProcess: (pid) => {
      looked.push(pid);
      return processes[pid] ?? { kind: "none" };
    },
    stopProcess: (pid) => {
      stopped.push(pid);
      return Promise.resolve();
    },
  };
  const createTask = ["schtasks", "/create", "/tn", windowsTaskName, "/xml", windowsTaskFile(value), "/f"];
  return { value, commands, said, started, registered, createTask, looked, stopped };
}

describe("the Windows installer", () => {
  it("starts the runner at login through the user's Run key, registers the task that starts it again, and starts it through that task", async () => {
    const { value, commands, started, registered, said, createTask } = context("win32", { ownHome: true });
    expect(await install(value)).toBe(true);
    expect(windowsRunCommand(value)).toBe(`"C:\\Program Files\\nodejs\\node.exe" "${join(value.files.home, "start.mjs")}" launch`);
    expect(readState(entryFiles(value.files.home))).toEqual({ current: value.mainPath, currentVersion: "c".repeat(40) });
    expect(readFileSync(join(value.files.home, "start.mjs"), "utf8")).toBe(bootstrapSource(value.mainPath));
    expect(commands).toEqual([
      ["reg", "add", windowsRunKey, "/v", windowsRunValue, "/t", "REG_SZ", "/d", windowsRunCommand(value), "/f"],
      createTask,
      ["schtasks", "/run", "/tn", windowsTaskName],
    ]);
    expect(windowsRunKey.startsWith("HKCU\\")).toBe(true);
    expect(registered).toEqual([`\ufeff${windowsTaskXml(value)}`]);
    expect(existsSync(windowsTaskFile(value))).toBe(false);
    expect(started).toEqual([]);
    expect(said.join("\n")).toContain(`the scheduled task ${windowsTaskName} starts it again within ${windowsTaskMinutes} minutes`);
  });

  it("describes a task that runs the hidden direct launch as the user, at normal priority, with no time limit", () => {
    const { value } = context("win32");
    const xml = windowsTaskXml({ ...value, nodePath: "C:\\a & b\\node.exe" });
    expect(xml).toContain("<Command>C:\\WINDOWS\\System32\\conhost.exe</Command>");
    expect(xml).toContain(`<Arguments>--headless &quot;C:\\a &amp; b\\node.exe&quot; &quot;${join(value.files.home, "start.mjs")}&quot; launch --direct</Arguments>`);
    expect(xml).toContain(`<Interval>PT${windowsTaskMinutes}M</Interval>`);
    expect(xml).toContain("<StopAtDurationEnd>false</StopAtDurationEnd>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<Priority>4</Priority>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).not.toContain("secret");
  });

  it("installs with the start at login alone, and says so, when the task cannot be registered", async () => {
    const { value, commands, started, said, createTask } = context("win32", { ownHome: true, missing: [taskCreate, taskRun] });
    expect(await install(value)).toBe(true);
    expect(commands.slice(1)).toEqual([createTask, ["schtasks", "/run", "/tn", windowsTaskName]]);
    expect(started).toEqual(["supervisor"]);
    expect(said.join("\n")).toContain("could not be registered, so nothing starts the runner again if it stops before the next login");
  });

  it("starts the supervisor through the task, outside the caller's processes, unless told to start it directly", async () => {
    const { value, commands, started } = context("win32", { ownHome: true });
    expect(await launchSupervisor(value)).toBe("task");
    expect(commands).toEqual([["schtasks", "/run", "/tn", windowsTaskName]]);
    expect(started).toEqual([]);
    expect(readState(entryFiles(value.files.home))?.current).toBe(value.mainPath);
    commands.length = 0;
    expect(await launchSupervisor(value, true)).toBe("direct");
    expect(commands).toEqual([]);
    expect(started).toEqual(["supervisor"]);
  });

  it("starts the supervisor itself when there is no task to ask, or when the runner's folder is not the user's own", async () => {
    const untasked = context("win32", { ownHome: true, missing: [taskRun] });
    expect(await launchSupervisor(untasked.value)).toBe("direct");
    expect(untasked.commands).toEqual([["schtasks", "/run", "/tn", windowsTaskName]]);
    expect(untasked.started).toEqual(["supervisor"]);
    const elsewhere = context("win32");
    expect(await launchSupervisor(elsewhere.value)).toBe("direct");
    expect(elsewhere.commands).toEqual([]);
    expect(elsewhere.started).toEqual(["supervisor"]);
  });

  it("starts nothing while a supervisor holds the folder's pipe, whatever the process number file says", async () => {
    for (const pid of [undefined, deadPid, process.pid]) {
      const { value, commands, started, looked } = context("win32", { ownHome: true, held: true });
      if (pid !== undefined) {
        writeFileSync(value.files.supervisor, `${pid}\n`);
      }
      expect(await launchSupervisor(value)).toBe("already");
      expect(await launchSupervisor(value, true)).toBe("already");
      expect(commands).toEqual([]);
      expect(started).toEqual([]);
      expect(looked).toEqual([]);
    }
  });

  it("starts nothing while a supervisor from before the pipe runs under the number in the file", async () => {
    const { value, commands, started, looked } = context("win32", { ownHome: true, processes: { [process.pid]: supervisorLine(join(folder, ".superagent2")) } });
    writeFileSync(value.files.supervisor, `${process.pid}\n`);
    expect(await launchSupervisor(value)).toBe("already");
    expect(await launchSupervisor(value, true)).toBe("already");
    expect(await supervisorState(value)).toEqual({ running: true, pid: process.pid });
    expect(looked).toEqual([process.pid, process.pid, process.pid]);
    expect(commands).toEqual([]);
    expect(started).toEqual([]);
  });

  it("starts the supervisor when the number in the file now belongs to another program", async () => {
    const { value, commands, started } = context("win32", { ownHome: true, processes: { [process.pid]: { kind: "line", line: '"C:\\Windows\\System32\\notepad.exe"' } } });
    writeFileSync(value.files.supervisor, `${process.pid}\n`);
    expect(await supervisorState(value)).toEqual({ running: false });
    expect(await launchSupervisor(value)).toBe("task");
    expect(commands).toEqual([["schtasks", "/run", "/tn", windowsTaskName]]);
    const other = context("win32", { ownHome: true, processes: { [process.pid]: { kind: "line", line: `"C:\\Program Files\\nodejs\\node.exe" ${join(folder, "other", "start.mjs")} supervise` } } });
    writeFileSync(other.value.files.supervisor, `${process.pid}\n`);
    expect(await launchSupervisor(other.value, true)).toBe("direct");
    expect(other.started).toEqual(["supervisor"]);
    expect(started).toEqual([]);
  });

  it("starts the supervisor when the number in the file is gone, without asking Windows about it", async () => {
    const { value, started, looked } = context("win32", { ownHome: true });
    writeFileSync(value.files.supervisor, `${deadPid}\n`);
    expect(await launchSupervisor(value, true)).toBe("direct");
    expect(started).toEqual(["supervisor"]);
    expect(looked).toEqual([]);
  });

  it("takes a process whose program cannot be read for the supervisor rather than start a second one", async () => {
    const { value, started } = context("win32", { ownHome: true, processes: { [process.pid]: { kind: "unknown" } } });
    writeFileSync(value.files.supervisor, `${process.pid}\n`);
    expect(await launchSupervisor(value, true)).toBe("already");
    expect(started).toEqual([]);
  });

  it("reads what Windows says about a process", () => {
    expect(readProcessLook("none\r\n")).toEqual({ kind: "none" });
    expect(readProcessLook("unknown\r\n")).toEqual({ kind: "unknown" });
    expect(readProcessLook("")).toEqual({ kind: "unknown" });
    expect(readProcessLook('line "C:\\node.exe" C:\\Users\\a\\.superagent2\\start.mjs supervise\r\n')).toEqual({ kind: "line", line: '"C:\\node.exe" C:\\Users\\a\\.superagent2\\start.mjs supervise' });
    expect(processLookScript(42)).toContain("'ProcessId = 42'");
    const entry = "C:\\Users\\a\\.superagent2\\start.mjs";
    expect(isSupervisorLine('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\A\\.superagent2\\start.mjs supervise', entry)).toBe(true);
    expect(isSupervisorLine('"C:\\node.exe" "C:\\Users\\a\\.superagent2\\start.mjs" "supervise"', entry)).toBe(true);
    expect(isSupervisorLine('"C:\\node.exe" C:\\Users\\a\\.superagent2\\start.mjs run', entry)).toBe(false);
    expect(isSupervisorLine('"C:\\node.exe" C:\\Users\\b\\.superagent2\\start.mjs supervise', entry)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("asks Windows for the program of a process", () => {
    const { value } = context("win32");
    const { lookUpProcess: _fake, ...real } = value;
    expect(identifySupervisor(real, process.pid)).toBe("other");
  });

  it.skipIf(process.platform !== "win32")("sees the pipe of a running supervisor", async () => {
    const home = join(folder, ".superagent2");
    const pipe = supervisorPipe(home);
    expect(await pipeHeld(pipe)).toBe(false);
    const claim = await claimSupervisor(pipe);
    expect(await pipeHeld(pipe)).toBe(true);
    const closed = Promise.withResolvers<void>();
    (claim as Exclude<typeof claim, "taken" | undefined>).close(() => closed.resolve());
    await closed.promise;
    expect(await pipeHeld(pipe)).toBe(false);
  });

  it("adds the task to a runner that was installed before there was one", () => {
    const { value, commands, registered, createTask } = context("win32", { ownHome: true, missing: [task] });
    const logged: string[] = [];
    keepAutostart(value, (line) => logged.push(line));
    expect(commands).toEqual([
      ["schtasks", "/query", "/tn", windowsTaskName],
      ["reg", "query", windowsRunKey, "/v", windowsRunValue],
      createTask,
    ]);
    expect(registered).toEqual([`\ufeff${windowsTaskXml(value)}`]);
    expect(logged).toEqual([`Registered the scheduled task ${windowsTaskName}: it starts the runner again within ${windowsTaskMinutes} minutes whenever it is not running`]);
  });

  it("leaves the task alone when it is there, when the runner was never installed, and in a folder that is not the user's own", () => {
    const present = context("win32", { ownHome: true });
    expect(ensureWindowsTask(present.value)).toBe("present");
    expect(present.commands).toEqual([["schtasks", "/query", "/tn", windowsTaskName]]);
    const never = context("win32", { ownHome: true, missing: [task, runValue] });
    expect(ensureWindowsTask(never.value)).toBe("not installed");
    expect(never.commands.map((command) => command[0])).toEqual(["schtasks", "reg"]);
    const elsewhere = context("win32", { missing: [task] });
    expect(ensureWindowsTask(elsewhere.value)).toBe("not installed");
    expect(elsewhere.commands).toEqual([]);
    const refused = context("win32", { ownHome: true, missing: [task, taskCreate] });
    const logged: string[] = [];
    keepAutostart(refused.value, (line) => logged.push(line));
    expect(logged.join("\n")).toContain("could not be registered");
  });

  it("says what starts the runner", () => {
    expect(describeAutostart(context("win32").value)).toBe(
      `at every login (${windowsRunKey}\\${windowsRunValue}) and within ${windowsTaskMinutes} minutes whenever it is not running (scheduled task ${windowsTaskName})`,
    );
    expect(describeAutostart(context("win32", { missing: [task] }).value)).toContain(`only; the scheduled task ${windowsTaskName} is missing`);
    expect(describeAutostart(context("win32", { missing: [runValue] }).value)).toContain("the start at login is missing");
    expect(describeAutostart(context("win32", { missing: [task, runValue] }).value)).toBe("none");
  });

  it("removes the task and the Run value and stops the runner, keeping the settings unless asked", async () => {
    const { value, commands, said, stopped } = context("win32");
    writeFileSync(value.files.supervisor, `${deadPid}\n`);
    expect(await uninstall(value, false)).toBe(true);
    expect(commands).toEqual([
      ["schtasks", "/delete", "/tn", windowsTaskName, "/f"],
      ["reg", "delete", windowsRunKey, "/v", windowsRunValue, "/f"],
    ]);
    expect(said.join("\n")).toContain(`Removed the start at login and the scheduled task ${windowsTaskName}`);
    expect(existsSync(value.files.supervisor)).toBe(false);
    expect(existsSync(value.files.settings)).toBe(true);
    expect(await uninstall(value, true)).toBe(true);
    expect(existsSync(value.files.home)).toBe(false);
    expect(stopped).toEqual([]);
  });

  it("stops the supervisor named in the file, from before the pipe or after it", async () => {
    for (const held of [false, true]) {
      const { value, stopped } = context("win32", { held, processes: { [process.pid]: supervisorLine(join(folder, ".superagent2")) } });
      writeFileSync(value.files.supervisor, `${process.pid}\n`);
      expect(await stopSupervisor(value)).toBe("stopped");
      expect(stopped).toEqual([process.pid]);
      expect(existsSync(value.files.supervisor)).toBe(false);
    }
  });

  it("does not stop another program that has the number in the file", async () => {
    const { value, stopped, said } = context("win32", { processes: { [process.pid]: { kind: "line", line: '"C:\\Windows\\System32\\notepad.exe"' } } });
    writeFileSync(value.files.supervisor, `${process.pid}\n`);
    expect(await uninstall(value, false)).toBe(true);
    expect(stopped).toEqual([]);
    expect(existsSync(value.files.supervisor)).toBe(false);
    expect(said.join("\n")).toContain("and stopped the runner");
  });

  it("says so and keeps the folder when it cannot tell which process to stop", async () => {
    const unknown = context("win32", { processes: { [process.pid]: { kind: "unknown" } } });
    writeFileSync(unknown.value.files.supervisor, `${process.pid}\n`);
    expect(await uninstall(unknown.value, true)).toBe(false);
    expect(unknown.stopped).toEqual([]);
    expect(existsSync(unknown.value.files.supervisor)).toBe(true);
    expect(unknown.said.join("\n")).toContain(`process ${process.pid}, named in ${unknown.value.files.supervisor}, could not be confirmed to be the supervisor`);
    const held = context("win32", { held: true });
    expect(await uninstall(held.value, true)).toBe(false);
    expect(held.stopped).toEqual([]);
    expect(existsSync(held.value.files.home)).toBe(true);
    expect(held.said.join("\n")).toContain("a supervisor still holds this folder but its process is not known");
  });

  it("refuses to install before the setup", async () => {
    const { value, commands, said } = context("win32", { settings: false });
    expect(await install(value)).toBe(false);
    expect(commands).toEqual([]);
    expect(said.join("\n")).toContain("run the setup first");
  });

  it.skipIf(process.platform !== "win32")("lets one supervisor at a time hold a folder", async () => {
    const pipe = supervisorPipe(join(folder, ".superagent2"));
    expect(supervisorPipe(join(folder, ".SUPERAGENT2"))).toBe(pipe);
    const first = await claimSupervisor(pipe);
    expect(first).not.toBe("taken");
    expect(first).toBeDefined();
    expect(await claimSupervisor(pipe)).toBe("taken");
    const closed = Promise.withResolvers<void>();
    (first as Exclude<typeof first, "taken" | undefined>).close(() => closed.resolve());
    await closed.promise;
    const next = await claimSupervisor(pipe);
    expect(next).not.toBe("taken");
    (next as Exclude<typeof next, "taken" | undefined>).close();
  });
});

describe("the macOS installer", () => {
  it("writes a launch agent that keeps the runner alive and loads it", async () => {
    const { value, commands } = context("darwin");
    expect(await install(value)).toBe(true);
    const plist = readFileSync(launchAgentPath(value), "utf8");
    expect(plist).toBe(launchAgentPlist(value));
    expect(plist).toContain(`<string>${macosLabel}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain(`<string>${join(value.files.home, "start.mjs")}</string>`);
    expect(plist).toContain(`<key>${supervisedVariable}</key>\n    <string>1</string>`);
    expect(readState(entryFiles(value.files.home))?.current).toBe(value.mainPath);
    expect(plist).toContain("<key>PATH</key>\n    <string>/usr/local/bin:/usr/bin:/bin</string>");
    expect(plist).not.toContain("secret");
    expect(commands).toEqual([
      ["launchctl", "bootout", `gui/501/${macosLabel}`],
      ["launchctl", "bootstrap", "gui/501", launchAgentPath(value)],
    ]);
  });

  it("unloads and deletes the launch agent", async () => {
    const { value, commands, said } = context("darwin");
    await install(value);
    expect(describeAutostart(value)).toBe(`at every login and whenever it stops (${launchAgentPath(value)})`);
    commands.length = 0;
    said.length = 0;
    expect(await uninstall(value, false)).toBe(true);
    expect(commands).toEqual([["launchctl", "bootout", `gui/501/${macosLabel}`]]);
    expect(said).toEqual([`Removed the start at login and stopped the runner. The settings stay in ${value.files.settings}.`]);
    expect(existsSync(launchAgentPath(value))).toBe(false);
    expect(describeAutostart(value)).toBe("none");
  });

  it("takes any live process with the number in the file for the supervisor, as before", async () => {
    const { value, started, looked } = context("darwin");
    writeFileSync(value.files.supervisor, `${process.pid}\n`);
    expect(await launchSupervisor(value)).toBe("already");
    expect(await supervisorState(value)).toEqual({ running: true, pid: process.pid });
    writeFileSync(value.files.supervisor, `${deadPid}\n`);
    expect(await launchSupervisor(value)).toBe("direct");
    expect(started).toEqual(["supervisor"]);
    expect(looked).toEqual([]);
  });

  it("escapes what it writes into the property list", () => {
    const { value } = context("darwin");
    expect(launchAgentPlist({ ...value, nodePath: "/a & b/<node>" })).toContain("<string>/a &amp; b/&lt;node&gt;</string>");
  });
});
