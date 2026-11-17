import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, readSettingsFile, runnerFiles, runnerHome } from "./config.js";
import { defaultInstallContext, install, isAlive, launchSupervisor, readSupervisorPid, supervise, uninstall } from "./install.js";
import { probePrograms, programDefinitions, systemProber } from "./programs.js";
import { startRunnerService } from "./service.js";
import { runSetup } from "./setup.js";

const usage = [
  "Usage: node packages/runner/dist/main.js <command>",
  "  setup        Save the line the hub printed for this machine (asked for on standard input)",
  "  install      Start the runner at every login and now (Windows and macOS)",
  "  uninstall    Remove the start at login and stop the runner; --purge also deletes the settings folder",
  "  run          Run the runner in this terminal",
  "  status       Say whether the runner is set up and running",
  "  programs     List the command-line programs found here, with their models and efforts",
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
  const context = defaultInstallContext(files, mainPath, say);
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
      return install(context) ? 0 : 1;
    case "uninstall":
      return (await uninstall(context, rest.includes("--purge"))) ? 0 : 1;
    case "launch":
      launchSupervisor(context);
      return 0;
    case "supervise":
      mkdirSync(files.home, { recursive: true });
      supervise({ context, log: (line) => appendFileSync(files.log, stamp(`supervisor: ${line}`)) });
      return -1;
    case "run": {
      const service = await startRunnerService({ files, environment: process.env, log: (line) => process.stdout.write(stamp(line)) });
      if (service === undefined) {
        return 1;
      }
      let stopping = false;
      const stop = () => {
        if (stopping) {
          return;
        }
        stopping = true;
        void service.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return -1;
    }
    case "status": {
      const pid = readSupervisorPid(files);
      say(`Settings: ${files.settings}`);
      say(`Supervisor: ${pid !== undefined && isAlive(pid) ? `running as process ${pid}` : "not running"}`);
      return 0;
    }
    case "programs": {
      const loaded = loadConfig(readSettingsFile(files.settings) ?? {});
      const programs = await probePrograms(programDefinitions(loaded.ok ? loaded.config.models : {}),systemProber({ environment: process.env, cwd: files.probe }));
      say(JSON.stringify(programs, null, 2));
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
