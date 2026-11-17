import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { homeVariable, loadConfig, readSettingsFile, type RunnerFiles } from "./config.js";
import { type Execute, executeQuietly } from "./secret-file.js";
import { killTree } from "./shell.js";

export const windowsRunKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const windowsRunValue = "SuperAgent2Runner";
export const macosLabel = "com.superagent2.runner";

export interface InstallContext {
  readonly files: RunnerFiles;
  readonly platform: NodeJS.Platform;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly execute: Execute;
  readonly say: (line: string) => void;
  readonly launchAgents?: string;
  readonly uid?: number;
  readonly startNow?: (context: InstallContext) => void;
}

export function defaultInstallContext(files: RunnerFiles, mainPath: string, say: (line: string) => void): InstallContext {
  return {
    files,
    platform: process.platform,
    nodePath: process.execPath,
    mainPath,
    environment: process.env,
    execute: executeQuietly,
    say,
  };
}

function quote(value: string): string {
  return `"${value}"`;
}

export function windowsRunCommand(context: Pick<InstallContext, "nodePath" | "mainPath">): string {
  return `${quote(context.nodePath)} ${quote(context.mainPath)} launch`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function launchAgentPlist(context: Pick<InstallContext, "nodePath" | "mainPath" | "files" | "environment">): string {
  const variables: Record<string, string> = {};
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
    `    ${string(context.mainPath)}`,
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

export function launchSupervisor(context: InstallContext): boolean {
  const pid = readSupervisorPid(context.files);
  if (pid !== undefined && isAlive(pid)) {
    return false;
  }
  mkdirSync(context.files.home, { recursive: true });
  const child = spawn(context.nodePath, [context.mainPath, "supervise"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...context.environment },
  });
  child.unref();
  return true;
}

export function install(context: InstallContext): boolean {
  if (!settingsReady(context)) {
    return false;
  }
  if (context.platform === "win32") {
    context.execute("reg", ["add", windowsRunKey, "/v", windowsRunValue, "/t", "REG_SZ", "/d", windowsRunCommand(context), "/f"]);
    (context.startNow ?? launchSupervisor)(context);
    context.say(`Installed: the runner starts at every login (${windowsRunKey}\\${windowsRunValue}) and is running now.`);
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

export async function stopSupervisor(context: InstallContext): Promise<void> {
  const pid = readSupervisorPid(context.files);
  if (pid !== undefined && isAlive(pid)) {
    await killTree(pid, context.platform);
  }
  rmSync(context.files.supervisor, { force: true });
}

export async function uninstall(context: InstallContext, purge: boolean): Promise<boolean> {
  if (context.platform === "win32") {
    tryExecute(context, "reg", ["delete", windowsRunKey, "/v", windowsRunValue, "/f"]);
    await stopSupervisor(context);
  } else if (context.platform === "darwin") {
    tryExecute(context, "launchctl", ["bootout", `gui/${uidOf(context)}/${macosLabel}`]);
    rmSync(launchAgentPath(context), { force: true });
  } else {
    context.say("The runner installs itself on Windows and macOS only.");
    return false;
  }
  if (purge) {
    rmSync(context.files.home, { recursive: true, force: true });
    context.say(`Removed the start at login, stopped the runner and deleted ${context.files.home}.`);
  } else {
    context.say(`Removed the start at login and stopped the runner. The settings stay in ${context.files.settings}.`);
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

export function supervise(options: SupervisorOptions): void {
  const { context } = options;
  mkdirSync(context.files.home, { recursive: true });
  writeFileSync(context.files.supervisor, `${process.pid}\n`);
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  let quickExits = 0;
  const start = () => {
    rotateLog(context.files.log);
    const log = openSync(context.files.log, "a");
    const started = Date.now();
    child = spawn(context.nodePath, [context.mainPath, "run"], {
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...context.environment },
    });
    closeSync(log);
    child.once("exit", (code, signal) => {
      child = undefined;
      if (stopping) {
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
  start();
}
