import { accessClientIdHeader, accessClientSecretHeader, type AllowanceReading, type ProgramReport, runnerTokenHeader } from "@super-agent2/protocol";
import { readAllowances } from "./allowance.js";
import { loadConfig, readSettingsFile, type RunnerFiles } from "./config.js";
import { createLedger } from "./ledger.js";
import { type Connect, createRunnerLink, type LinkEvent, type RunnerLink } from "./link.js";
import { machineReport } from "./machine.js";
import { type Prober, probePrograms, programDefinitions, systemProber } from "./programs.js";
import { runShell } from "./shell.js";
import { createUpdater, systemSteps, type Updater, type UpdateSteps } from "./update.js";
import { createWorks, type Works, type WorksOptions } from "./works.js";

export interface RunnerServiceOptions {
  readonly files: RunnerFiles;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly prober?: Prober;
  readonly connect?: Connect;
  readonly retryDelay?: (attempt: number) => number;
  readonly reprobeMilliseconds?: number;
  readonly allowanceMilliseconds?: number;
  readonly now?: () => number;
  readonly work?: Partial<Pick<WorksOptions, "adapters" | "findProgram" | "run" | "remote" | "readPullRequest">>;
  readonly mainPath?: string;
  readonly version?: string;
  readonly supervised?: boolean;
  readonly restart?: () => void;
  readonly updateSteps?: UpdateSteps;
}

export interface RunnerService {
  readonly link: RunnerLink;
  readonly works: Works;
  readonly updater: Updater | undefined;
  readonly probed: Promise<void>;
  readonly allowanceRead: Promise<void>;
  close(): Promise<void>;
}

function describe(event: LinkEvent): string {
  switch (event.type) {
    case "connecting":
      return `Connecting to ${event.url}`;
    case "connected":
      return `Connected to the hub as ${event.name}${event.version === undefined ? "" : `, which runs ${event.version.slice(0, 7)}`}`;
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
  let allowances: AllowanceReading[] = [];
  let bound: RunnerLink | undefined;
  let updater: Updater | undefined;
  const works = createWorks({
    home: files.home,
    environment: options.environment,
    send: (message) => bound?.send(message),
    ledger,
    log,
    changed: () => {
      bound?.update();
      updater?.changed();
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...options.work,
  });
  const link = createRunnerLink({
    config,
    report: () => ({ ...machineReport(config.slots, programs, process.platform, allowances, works.busy()), ...(options.version === undefined ? {} : { version: options.version }) }),
    works: () => works,
    execute: (job, sink) => runShell(job, sink, { environment: options.environment }),
    ledger,
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
    onEvent: (event) => {
      log(describe(event));
      if (event.type === "connected") {
        updater?.confirmed();
        updater?.announced(event.version);
      } else if (event.type === "ended" || event.type === "failed") {
        updater?.changed();
      }
    },
  });
  bound = link;
  const now = options.now ?? Date.now;
  if (options.mainPath !== undefined) {
    updater = createUpdater({
      home: files.home,
      mainPath: options.mainPath,
      version: options.version,
      supervised: options.supervised ?? false,
      steps:
        options.updateSteps ??
        systemSteps({
          hub: config.hub,
          headers: { [accessClientIdHeader]: config.accessClientId, [accessClientSecretHeader]: config.accessClientSecret, [runnerTokenHeader]: config.runnerToken },
          platform: process.platform,
          environment: options.environment,
          nodePath: process.execPath,
        }),
      busy: () => works.busy() + link.running().length,
      restart: options.restart ?? (() => undefined),
      log,
      now,
    });
  }
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
  let reading = false;
  const readAllowance = async () => {
    if (reading) {
      return;
    }
    reading = true;
    try {
      allowances = await readAllowances(prober, programs, now);
      log(
        `Allowance: ${allowances
          .map((entry) => (entry.state === "unknown" ? `${entry.program} unknown` : `${entry.program} ${entry.state} with ${entry.remainingPercent ?? "?"}% left`))
          .join(", ")}`,
      );
      link.update();
    } finally {
      reading = false;
    }
  };
  const allowanceRead = probed.then(readAllowance).catch((error: unknown) => log(`Could not read the allowance: ${error instanceof Error ? error.message : String(error)}`));
  const allowanceTimer = setInterval(() => {
    void readAllowance().catch(() => undefined);
  }, options.allowanceMilliseconds ?? 10 * 60 * 1000);
  allowanceTimer.unref();
  return {
    link,
    works,
    updater,
    probed,
    allowanceRead,
    close: async () => {
      clearInterval(timer);
      clearInterval(allowanceTimer);
      await works.close();
      await link.close();
    },
  };
}
