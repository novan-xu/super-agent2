import type { ProgramReport } from "@super-agent2/protocol";
import { loadConfig, readSettingsFile, type RunnerFiles } from "./config.js";
import { createLedger } from "./ledger.js";
import { type Connect, createRunnerLink, type LinkEvent, type RunnerLink } from "./link.js";
import { machineReport } from "./machine.js";
import { type Prober, probePrograms, programDefinitions, systemProber } from "./programs.js";
import { runShell } from "./shell.js";

export interface RunnerServiceOptions {
  readonly files: RunnerFiles;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly prober?: Prober;
  readonly connect?: Connect;
  readonly retryDelay?: (attempt: number) => number;
  readonly reprobeMilliseconds?: number;
}

export interface RunnerService {
  readonly link: RunnerLink;
  readonly probed: Promise<void>;
  close(): Promise<void>;
}

function describe(event: LinkEvent): string {
  switch (event.type) {
    case "connecting":
      return `Connecting to ${event.url}`;
    case "connected":
      return `Connected to the hub as ${event.name}`;
    case "refused":
      return `The hub refused the connection (HTTP ${event.status})`;
    case "closed":
      return `The connection closed (${event.code}${event.reason === "" ? "" : ` ${event.reason}`}); stopped ${event.stopped} running command(s)`;
    case "started":
      return `Command ${event.id} started${event.pid === undefined ? "" : ` as process ${event.pid}`}`;
    case "ended":
      return `Command ${event.id} ended with ${event.exitCode ?? event.signal ?? "no code"}`;
    case "failed":
      return `Command ${event.id} could not run: ${event.reason}`;
    case "retrying":
      return `Connecting again in ${Math.round(event.delay / 1000)} s`;
  }
}

export async function startRunnerService(options: RunnerServiceOptions): Promise<RunnerService | undefined> {
  const { files, log } = options;
  const settings = readSettingsFile(files.settings);
  if (settings === undefined) {
    log(`There are no settings in ${files.settings}; run the setup first.`);
    return undefined;
  }
  const loaded = loadConfig(settings);
  if (!loaded.ok) {
    log(`The settings in ${files.settings} are not usable:`);
    for (const problem of loaded.problems) {
      log(`  ${problem}`);
    }
    return undefined;
  }
  const { config } = loaded;
  const ledger = createLedger({ path: files.running });
  const leftovers = await ledger.cleanup();
  if (leftovers.length > 0) {
    log(`Stopped ${leftovers.length} process tree(s) left running by an earlier runner: ${leftovers.join(", ")}`);
  }
  let programs: ProgramReport[] = [];
  const link = createRunnerLink({
    config,
    report: () => machineReport(config.slots, programs),
    execute: (job, sink) => runShell(job, sink, { environment: options.environment }),
    ledger,
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
    onEvent: (event) => log(describe(event)),
  });
  const prober = options.prober ?? systemProber({ environment: options.environment, cwd: files.probe });
  const definitions = programDefinitions(config.models);
  const probe = async () => {
    programs = await probePrograms(definitions, prober);
    log(
      `Programs: ${programs
        .map((program) => (program.installed ? `${program.id} ${program.version ?? "?"} (${program.models.length} models from ${program.source})` : `${program.id} not installed`))
        .join(", ")}`,
    );
    link.update();
  };
  link.start();
  const probed = probe().catch((error: unknown) => log(`Could not list the programs: ${error instanceof Error ? error.message : String(error)}`));
  const timer = setInterval(() => {
    void probe().catch(() => undefined);
  }, options.reprobeMilliseconds ?? 6 * 60 * 60 * 1000);
  timer.unref();
  return {
    link,
    probed,
    close: async () => {
      clearInterval(timer);
      await link.close();
    },
  };
}
