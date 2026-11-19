import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir, userInfo } from "node:os";
import { join, win32 } from "node:path";
import { homeVariable, loadConfig, readSettingsFile, type RunnerFiles } from "./config.js";
import { ensureEntry, entryFiles, installEntry } from "./entry.js";
import { type Execute, executeQuietly } from "./secret-file.js";
import { killTree } from "./shell.js";

export const windowsRunKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const windowsRunValue = "SuperAgent2Runner";
export const windowsTaskName = "SuperAgent2Runner";
export const windowsTaskMinutes = 5;
export const directFlag = "--direct";
export const macosLabel = "com.superagent2.runner";
export const supervisedVariable = "SUPERAGENT2_RUNNER_SUPERVISED";
export const restartCode = 75;

export interface InstallContext {
  readonly files: RunnerFiles;
  readonly platform: NodeJS.Platform;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly version?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly execute: Execute;
  readonly say: (line: string) => void;
  readonly launchAgents?: string;
  readonly uid?: number;
  readonly spawnSupervisor?: (context: InstallContext) => void;
  readonly pipeHeld?: (path: string) => Promise<boolean>;
  readonly lookUpProcess?: (pid: number) => ProcessLook;
  readonly stopProcess?: (pid: number) => Promise<void>;
}

export type ProcessLook = { readonly kind: "none" } | { readonly kind: "unknown" } | { readonly kind: "line"; readonly line: string };

export type ProcessIdentity = "supervisor" | "other" | "none" | "unknown";

export interface SupervisorState {
  readonly running: boolean;
  readonly pid?: number;
}

export function defaultInstallContext(files: RunnerFiles, mainPath: string, say: (line: string) => void, version?: string): InstallContext {
  return {
    files,
    platform: process.platform,
    nodePath: process.execPath,
    mainPath,
    ...(version === undefined ? {} : { version }),
    environment: process.env,
    execute: executeQuietly,
    say,
  };
}

function quote(value: string): string {
  return `"${value}"`;
}

export function entryPath(context: Pick<InstallContext, "files">): string {
  return entryFiles(context.files.home).entry;
}

export function windowsRunCommand(context: Pick<InstallContext, "nodePath" | "files">): string {
  return `${quote(context.nodePath)} ${quote(entryPath(context))} launch`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function windowsTaskCommand(context: Pick<InstallContext, "nodePath" | "files" | "environment">): { readonly command: string; readonly arguments: string } {
  const root = context.environment["SystemRoot"] ?? context.environment["SYSTEMROOT"] ?? "C:\\Windows";
  return {
    command: win32.join(root, "System32", "conhost.exe"),
    arguments: `--headless ${quote(context.nodePath)} ${quote(entryPath(context))} launch ${directFlag}`,
  };
}

export function windowsTaskXml(context: Pick<InstallContext, "nodePath" | "files" | "environment">): string {
  const action = windowsTaskCommand(context);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Starts the Super-agent2 runner whenever it is not running.</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <TimeTrigger>",
    "      <Repetition>",
    `        <Interval>PT${windowsTaskMinutes}M</Interval>`,
    "        <StopAtDurationEnd>false</StopAtDurationEnd>",
    "      </Repetition>",
    "      <StartBoundary>2026-01-01T00:00:00</StartBoundary>",
    "      <Enabled>true</Enabled>",
    "    </TimeTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>false</StartWhenAvailable>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>4</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${escapeXml(action.command)}</Command>`,
    `      <Arguments>${escapeXml(action.arguments)}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

export function windowsTaskFile(context: Pick<InstallContext, "files">): string {
  return join(context.files.home, "autostart.xml");
}

export function launchAgentPlist(context: Pick<InstallContext, "nodePath" | "files" | "environment">): string {
  const variables: Record<string, string> = { [supervisedVariable]: "1" };
  const path = context.environment["PATH"];
  if (path !== undefined && path !== "") {
    variables["PATH"] = path;
  }
  const home = context.environment[homeVariable];
  if (home !== undefined && home !== "") {
    variables[homeVariable] = home;
  }
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${string(macosLabel)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    ${string(context.nodePath)}`,
    `    ${string(entryPath(context))}`,
    `    ${string("run")}`,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(variables).flatMap(([name, value]) => [`    <key>${escapeXml(name)}</key>`, `    ${string(value)}`]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  ${string(context.files.home)}`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  ${string(context.files.log)}`,
    "  <key>StandardErrorPath</key>",
    `  ${string(context.files.log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function launchAgentsFolder(context: InstallContext): string {
  return context.launchAgents ?? join(homedir(), "Library", "LaunchAgents");
}

export function launchAgentPath(context: InstallContext): string {
  return join(launchAgentsFolder(context), `${macosLabel}.plist`);
}

function uidOf(context: InstallContext): number {
  return context.uid ?? userInfo().uid;
}

function settingsReady(context: InstallContext): boolean {
  const settings = readSettingsFile(context.files.settings);
  if (settings === undefined) {
    context.say(`There are no settings in ${context.files.settings}; run the setup first.`);
    return false;
  }
  const loaded = loadConfig(settings);
  if (!loaded.ok) {
    context.say(`The settings in ${context.files.settings} are not usable: ${loaded.problems.join("; ")}`);
    return false;
  }
  return true;
}

function tryExecute(context: InstallContext, program: string, args: readonly string[]): boolean {
  try {
    context.execute(program, args);
    return true;
  } catch {
    return false;
  }
}

export function readSupervisorPid(files: RunnerFiles): number | undefined {
  try {
    const pid = Number(readFileSync(files.supervisor, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function pipeHeld(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code !== "ENOENT"));
  });
}

export function processLookScript(pid: number): string {
  return [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -eq $p) { 'none' } elseif ($null -eq $p.CommandLine) { 'unknown' } else { 'line ' + $p.CommandLine }",
  ].join("; ");
}

export function readProcessLook(output: string): ProcessLook {
  const text = output.trim();
  if (text === "none") {
    return { kind: "none" };
  }
  return text.startsWith("line ") ? { kind: "line", line: text.slice(5) } : { kind: "unknown" };
}

function lookUpProcess(context: InstallContext, pid: number): ProcessLook {
  if (context.lookUpProcess !== undefined) {
    return context.lookUpProcess(pid);
  }
  const root = context.environment["SystemRoot"] ?? context.environment["SYSTEMROOT"] ?? "C:\\Windows";
  const shell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const output = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", processLookScript(pid)], { encoding: "utf8", windowsHide: true, timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
    return readProcessLook(output);
  } catch {
    return { kind: "unknown" };
  }
}

export function isSupervisorLine(line: string, entry: string): boolean {
  const normal = (value: string) => value.replaceAll("/", "\\").toLowerCase();
  return normal(line).includes(normal(entry)) && /\s"?supervise"?\s*$/.test(line);
}

export function identifySupervisor(context: InstallContext, pid: number): ProcessIdentity {
  if (!isAlive(pid)) {
    return "none";
  }
  if (context.platform !== "win32") {
    return "supervisor";
  }
  const look = lookUpProcess(context, pid);
  if (look.kind !== "line") {
    return look.kind;
  }
  return isSupervisorLine(look.line, entryPath(context)) ? "supervisor" : "other";
}

export async function supervisorState(context: InstallContext): Promise<SupervisorState> {
  const pid = readSupervisorPid(context.files);
  const held = context.platform === "win32" && (await (context.pipeHeld ?? pipeHeld)(supervisorPipe(context.files.home)));
  const identity = pid === undefined || held ? undefined : identifySupervisor(context, pid);
  if (identity === "supervisor" || identity === "unknown") {
    return { running: true, ...(pid === undefined ? {} : { pid }) };
  }
  if (held) {
    return { running: true, ...(pid !== undefined && isAlive(pid) ? { pid } : {}) };
  }
  return { running: false };
}

function spawnSupervisor(context: InstallContext): void {
  const child = spawn(context.nodePath, [entryPath(context), "supervise"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...context.environment },
  });
  child.unref();
}

function usesOwnHome(context: InstallContext): boolean {
  const home = context.environment[homeVariable];
  return home === undefined || home === "";
}

export function registerWindowsTask(context: InstallContext): boolean {
  const file = windowsTaskFile(context);
  mkdirSync(context.files.home, { recursive: true });
  writeFileSync(file, `﻿${windowsTaskXml(context)}`, "utf16le");
  try {
    return tryExecute(context, "schtasks", ["/create", "/tn", windowsTaskName, "/xml", file, "/f"]);
  } finally {
    rmSync(file, { force: true });
  }
}

export type Launched = "already" | "task" | "direct";

export async function launchSupervisor(context: InstallContext, direct = false): Promise<Launched> {
  if ((await supervisorState(context)).running) {
    return "already";
  }
  mkdirSync(context.files.home, { recursive: true });
  ensureEntry(context.files.home, context.mainPath, context.version);
  if (!direct && context.platform === "win32" && usesOwnHome(context) && tryExecute(context, "schtasks", ["/run", "/tn", windowsTaskName])) {
    return "task";
  }
  (context.spawnSupervisor ?? spawnSupervisor)(context);
  return "direct";
}

export type AutostartCheck = "present" | "registered" | "failed" | "not installed";

export function ensureWindowsTask(context: InstallContext): AutostartCheck {
  if (context.platform !== "win32" || !usesOwnHome(context)) {
    return "not installed";
  }
  if (tryExecute(context, "schtasks", ["/query", "/tn", windowsTaskName])) {
    return "present";
  }
  if (!tryExecute(context, "reg", ["query", windowsRunKey, "/v", windowsRunValue])) {
    return "not installed";
  }
  return registerWindowsTask(context) ? "registered" : "failed";
}

const withoutTask = "nothing starts the runner again if it stops before the next login";

export function keepAutostart(context: InstallContext, log: (line: string) => void): void {
  const check = ensureWindowsTask(context);
  if (check === "registered") {
    log(`Registered the scheduled task ${windowsTaskName}: it starts the runner again within ${windowsTaskMinutes} minutes whenever it is not running`);
  } else if (check === "failed") {
    log(`The scheduled task ${windowsTaskName} could not be registered, so ${withoutTask}`);
  }
}

export function describeAutostart(context: InstallContext): string {
  if (context.platform === "win32") {
    const login = tryExecute(context, "reg", ["query", windowsRunKey, "/v", windowsRunValue]);
    const task = tryExecute(context, "schtasks", ["/query", "/tn", windowsTaskName]);
    const atLogin = `at every login (${windowsRunKey}\\${windowsRunValue})`;
    const byTask = `within ${windowsTaskMinutes} minutes whenever it is not running (scheduled task ${windowsTaskName})`;
    if (login && task) {
      return `${atLogin} and ${byTask}`;
    }
    if (login) {
      return `${atLogin} only; the scheduled task ${windowsTaskName} is missing, so ${withoutTask}`;
    }
    return task ? `${byTask}; the start at login is missing` : "none";
  }
  if (context.platform === "darwin") {
    const plist = launchAgentPath(context);
    return existsSync(plist) ? `at every login and whenever it stops (${plist})` : "none";
  }
  return "none";
}

export async function install(context: InstallContext): Promise<boolean> {
  if (!settingsReady(context)) {
    return false;
  }
  if (context.platform === "win32" || context.platform === "darwin") {
    installEntry(context.files.home, context.mainPath, context.version);
  }
  if (context.platform === "win32") {
    context.execute("reg", ["add", windowsRunKey, "/v", windowsRunValue, "/t", "REG_SZ", "/d", windowsRunCommand(context), "/f"]);
    const registered = registerWindowsTask(context);
    const now = (await launchSupervisor(context)) === "already" ? "it is running now" : "it is starting now";
    context.say(
      registered
        ? `Installed: the runner starts at every login (${windowsRunKey}\\${windowsRunValue}), the scheduled task ${windowsTaskName} starts it again within ${windowsTaskMinutes} minutes whenever it is not running, and ${now}.`
        : `Installed: the runner starts at every login (${windowsRunKey}\\${windowsRunValue}) and ${now}. The scheduled task ${windowsTaskName} could not be registered, so ${withoutTask}.`,
    );
    return true;
  }
  if (context.platform === "darwin") {
    const plist = launchAgentPath(context);
    mkdirSync(launchAgentsFolder(context), { recursive: true });
    writeFileSync(plist, launchAgentPlist(context), { mode: 0o644 });
    const domain = `gui/${uidOf(context)}`;
    tryExecute(context, "launchctl", ["bootout", `${domain}/${macosLabel}`]);
    context.execute("launchctl", ["bootstrap", domain, plist]);
    context.say(`Installed: ${plist} starts the runner at every login and keeps it running; it is running now.`);
    return true;
  }
  context.say("The runner installs itself on Windows and macOS only.");
  return false;
}

export type Stopped = "stopped" | "none" | "unconfirmed" | "elsewhere";

export async function stopSupervisor(context: InstallContext): Promise<Stopped> {
  const pid = readSupervisorPid(context.files);
  const identity = pid === undefined ? "none" : identifySupervisor(context, pid);
  if (identity === "unknown") {
    return "unconfirmed";
  }
  if (identity === "supervisor" && pid !== undefined) {
    await (context.stopProcess ?? ((target: number) => killTree(target, context.platform)))(pid);
  }
  rmSync(context.files.supervisor, { force: true });
  if (identity === "supervisor") {
    return "stopped";
  }
  return context.platform === "win32" && (await (context.pipeHeld ?? pipeHeld)(supervisorPipe(context.files.home))) ? "elsewhere" : "none";
}

export async function uninstall(context: InstallContext, purge: boolean): Promise<boolean> {
  if (context.platform === "win32") {
    tryExecute(context, "schtasks", ["/delete", "/tn", windowsTaskName, "/f"]);
    tryExecute(context, "reg", ["delete", windowsRunKey, "/v", windowsRunValue, "/f"]);
    const stopped = await stopSupervisor(context);
    if (stopped === "unconfirmed" || stopped === "elsewhere") {
      const pid = readSupervisorPid(context.files);
      const which = stopped === "unconfirmed" && pid !== undefined ? `process ${pid}, named in ${context.files.supervisor}, could not be confirmed to be the supervisor` : "a supervisor still holds this folder but its process is not known";
      context.say(`Removed the start at login and the scheduled task ${windowsTaskName}, but did not stop the runner: ${which}. End it from Task Manager${purge ? ` and run uninstall --purge again to delete ${context.files.home}` : ""}.`);
      return false;
    }
  } else if (context.platform === "darwin") {
    tryExecute(context, "launchctl", ["bootout", `gui/${uidOf(context)}/${macosLabel}`]);
    rmSync(launchAgentPath(context), { force: true });
  } else {
    context.say("The runner installs itself on Windows and macOS only.");
    return false;
  }
  const removed = context.platform === "win32" ? `the start at login and the scheduled task ${windowsTaskName}` : "the start at login";
  if (purge) {
    rmSync(context.files.home, { recursive: true, force: true });
    context.say(`Removed ${removed}, stopped the runner and deleted ${context.files.home}.`);
  } else {
    context.say(`Removed ${removed} and stopped the runner. The settings stay in ${context.files.settings}.`);
  }
  return true;
}

export interface SupervisorOptions {
  readonly context: InstallContext;
  readonly log: (line: string) => void;
}

const maximumLogBytes = 5 * 1024 * 1024;

function rotateLog(path: string): void {
  try {
    if (statSync(path).size > maximumLogBytes) {
      rmSync(`${path}.1`, { force: true });
      renameSync(path, `${path}.1`);
    }
  } catch {
    return;
  }
}

export function supervisorPipe(home: string): string {
  return `\\\\.\\pipe\\superagent2-runner-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}`;
}

export function claimSupervisor(path: string): Promise<Server | "taken" | undefined> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (error) => resolve((error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "taken" : undefined));
    server.listen(path, () => resolve(server));
  });
}

export function supervise(options: SupervisorOptions): void {
  const { context } = options;
  mkdirSync(context.files.home, { recursive: true });
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  let quickExits = 0;
  const start = () => {
    rotateLog(context.files.log);
    const log = openSync(context.files.log, "a");
    const started = Date.now();
    child = spawn(context.nodePath, [entryPath(context), "run"], {
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...context.environment, [supervisedVariable]: "1" },
    });
    closeSync(log);
    child.once("exit", (code, signal) => {
      child = undefined;
      if (stopping) {
        return;
      }
      if (code === restartCode) {
        quickExits = 0;
        options.log("The runner restarted itself to change its version; starting it again now");
        setTimeout(start, 500);
        return;
      }
      quickExits = Date.now() - started < 60000 ? quickExits + 1 : 0;
      const delay = Math.min(60000, 2000 * 2 ** Math.min(quickExits, 5));
      options.log(`The runner exited (${code ?? signal ?? "unknown"}); starting it again in ${Math.round(delay / 1000)} s`);
      setTimeout(start, delay);
    });
  };
  const stop = () => {
    stopping = true;
    const pid = child?.pid;
    const done = pid === undefined ? Promise.resolve() : killTree(pid, context.platform);
    void done.finally(() => {
      if (readSupervisorPid(context.files) === process.pid && existsSync(context.files.supervisor)) {
        rmSync(context.files.supervisor, { force: true });
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const begin = () => {
    writeFileSync(context.files.supervisor, `${process.pid}\n`);
    start();
  };
  if (context.platform !== "win32") {
    begin();
    return;
  }
  void claimSupervisor(supervisorPipe(context.files.home)).then((claim) => {
    if (claim === "taken") {
      options.log("Another supervisor already runs here; this one stops");
      process.exit(0);
    }
    begin();
  });
}
