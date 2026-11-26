import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, readSettingsFile, runnerFiles, runnerHome } from "./config.js";
import { protocolVersion } from "@super-agent2/protocol";
import { entryFiles, readState } from "./entry.js";
import { defaultInstallContext, describeAutostart, directFlag, install, keepAutostart, launchSupervisor, restartCode, supervise, supervisedVariable, supervisorState, uninstall } from "./install.js";
import { readAllowances } from "./allowance.js";
import { probePrograms, programDefinitions, systemProber } from "./programs.js";
import { startRunnerService } from "./service.js";
import { runSetup } from "./setup.js";
import { runnerVersion } from "./version.js";

const usage = [
  "Usage: node packages/runner/dist/main.js <command>",
  "  setup        Save the line the hub printed for this machine (asked for on standard input)",
  "  install      Start the runner at every login and now, and again whenever it stops (Windows and macOS)",
  "  uninstall    Remove what install added and stop the runner; --purge also deletes the settings folder",
  "  run          Run the runner in this terminal",
  "  status       Say whether the runner is set up and running",
  "  programs     List the command-line programs found here, with their models and efforts",
  "  allowance    Read the Codex, Claude Code and Antigravity quotas and DeepSeek balance logged in here",
  "  version      Print this runner's version and protocol",
];

const files = runnerFiles(runnerHome(process.env));
const mainPath = fileURLToPath(import.meta.url);
const say = (line: string) => process.stdout.write(`${line}\n`);
const stamp = (line: string) => `${new Date().toISOString()} ${line}\n`;

function askLines(): { ask: (question: string) => Promise<string | undefined>; close: () => void } {
  const reader = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  reader.on("line", (line) => {
    const next = waiting.shift();
    if (next === undefined) {
      lines.push(line);
    } else {
      next(line);
    }
  });
  reader.on("close", () => {
    ended = true;
    for (const next of waiting.splice(0)) {
      next(undefined);
    }
  });
  return {
    ask: (question) => {
      if (process.stdin.isTTY) {
        process.stdout.write(question);
      }
      const line = lines.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      if (ended) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => reader.close(),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const version = runnerVersion(mainPath);
  const context = defaultInstallContext(files, mainPath, say, version);
  switch (command) {
    case "setup": {
      const lines = askLines();
      try {
        return (await runSetup({ settingsFile: files.settings, ask: lines.ask, say })) ? 0 : 1;
      } finally {
        lines.close();
      }
    }
    case "install":
      return (await install(context)) ? 0 : 1;
    case "uninstall":
      return (await uninstall(context, rest.includes("--purge"))) ? 0 : 1;
    case "launch":
      await launchSupervisor(context, rest.includes(directFlag));
      return 0;
    case "supervise":
      mkdirSync(files.home, { recursive: true });
      supervise({ context, log: (line) => appendFileSync(files.log, stamp(`supervisor: ${line}`)) });
      return -1;
    case "run": {
      let stopping = false;
      let stop: (code: number) => void = () => undefined;
      const log = (line: string) => process.stdout.write(stamp(line));
      const supervised = process.env[supervisedVariable] === "1";
      let autostartKept = !supervised;
      const service = await startRunnerService({
        checkSignIn: true,
        files,
        environment: process.env,
        log,
        mainPath,
        ...(version === undefined ? {} : { version }),
        supervised,
        restart: () => stop(restartCode),
        confirmed: () => {
          if (!autostartKept) {
            autostartKept = true;
            keepAutostart(context, log);
          }
        },
      });
      if (service === undefined) {
        return 1;
      }
      stop = (code) => {
        if (stopping) {
          return;
        }
        stopping = true;
        void service.close().finally(() => process.exit(code));
      };
      process.on("SIGINT", () => stop(0));
      process.on("SIGTERM", () => stop(0));
      return -1;
    }
    case "version":
      say(JSON.stringify({ version: version ?? null, protocol: protocolVersion }));
      return 0;
    case "status": {
      const supervisor = await supervisorState(context);
      say(`Settings: ${files.settings}`);
      const state = readState(entryFiles(files.home));
      say(`Version: ${version ?? "unknown"} (${mainPath})`);
      if (state !== undefined) {
        say(`Starts: ${state.current}${state.previous === undefined ? "" : `, before it ${state.previous}`}${state.trial === undefined ? "" : ", not yet confirmed by the hub"}`);
        if (state.failed !== undefined) {
          say(`Last failed update: ${state.failed.version} at ${new Date(state.failed.at).toISOString()}: ${state.failed.reason}`);
        }
      }
      say(`Supervisor: ${supervisor.running ? (supervisor.pid === undefined ? "running" : `running as process ${supervisor.pid}`) : "not running"}`);
      say(`Autostart: ${describeAutostart(context)}`);
      return 0;
    }
    case "programs": {
      const loaded = loadConfig(readSettingsFile(files.settings) ?? {});
      const programs = await probePrograms(programDefinitions(loaded.ok ? loaded.config.models : {}),systemProber({ environment: process.env, cwd: files.probe }));
      say(JSON.stringify(programs, null, 2));
      return 0;
    }
    case "allowance": {
      const loaded = loadConfig(readSettingsFile(files.settings) ?? {});
      const prober = systemProber({ environment: process.env, cwd: files.probe });
      const programs = await probePrograms(programDefinitions(loaded.ok ? loaded.config.models : {}), prober);
      say(JSON.stringify(await readAllowances(prober, programs, Date.now), null, 2));
      return 0;
    }
    default:
      usage.forEach(say);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

const code = await main(process.argv.slice(2));
if (code >= 0) {
  process.exitCode = code;
}
