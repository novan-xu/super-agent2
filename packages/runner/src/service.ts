import { accessClientIdHeader, accessClientSecretHeader, type AllowanceReading, type MachineLoad, programIsConfigured, type ProgramReport, runnerTokenHeader } from "@super-agent2/protocol";
import { readAllowances } from "./allowance.js";
import { createChecks } from "./checks.js";
import { programSignedIn } from "./sign-in.js";
import { loadConfig, readSettingsFile, type RunnerFiles } from "./config.js";
import { createLedger } from "./ledger.js";
import { type Connect, createRunnerLink, type LinkEvent, type RunnerLink } from "./link.js";
import { machineReport } from "./machine.js";
import { createLoadSampler, loadChanged, loadSampleInterval } from "./machine-load.js";
import { type Prober, probePrograms, programDefinitions, systemProber } from "./programs.js";
import { createProgramUpdater, systemProgramUpdateSteps, type ProgramUpdateSteps } from "./program-update.js";
import { createUpdater, systemSteps, type Updater, type UpdateSteps } from "./update.js";
import { MachineStorage } from "./storage.js";
import { createWorks, type WorkMessage, type Works, type WorksOptions } from "./works.js";

export interface RunnerServiceOptions {
  readonly checkSignIn?: boolean;
  readonly tokenOnly?: boolean;
  readonly files: RunnerFiles;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly prober?: Prober;
  readonly platform?: NodeJS.Platform;
  readonly connect?: Connect;
  readonly retryDelay?: (attempt: number) => number;
  readonly reprobeMilliseconds?: number;
  readonly allowanceMilliseconds?: number;
  readonly sampleLoad?: () => Promise<MachineLoad>;
  readonly now?: () => number;
  readonly work?: Partial<Pick<WorksOptions, "adapters" | "findProgram" | "run" | "remote" | "readPullRequest">>;
  readonly mainPath?: string;
  readonly version?: string;
  readonly supervised?: boolean;
  readonly restart?: () => void;
  readonly confirmed?: () => void;
  readonly updateSteps?: UpdateSteps;
  readonly programUpdateSteps?: ProgramUpdateSteps;
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
      return `The connection closed (${event.code}${event.reason === "" ? "" : ` ${event.reason}`}); work goes on, and is synced again when the hub is back`;
    case "ignored":
      return `The hub sent a message of a kind this runner does not know (${event.kind}); it is ignored until the runner moves to the hub's version`;
    case "retrying":
      return `Connecting again in ${Math.round(event.delay / 1000)} s`;
  }
}

export async function startRunnerService(options: RunnerServiceOptions): Promise<RunnerService | undefined> {
  const { files, log } = options;
  const platform = options.platform ?? process.platform;
  const settings = readSettingsFile(files.settings);
  if (settings === undefined) {
    log(`There are no settings in ${files.settings}; run the setup first.`);
    return undefined;
  }
  const loaded = loadConfig(settings, options.tokenOnly);
  if (!loaded.ok) {
    log(`The settings in ${files.settings} are not usable:`);
    for (const problem of loaded.problems) {
      log(`  ${problem}`);
    }
    return undefined;
  }
  const { config } = loaded;
  const storage = new MachineStorage(files.home, config.storage ?? {}, process.platform, log);
  let storageReport = storage.initialReport();
  let storageReading = 0;
  const refreshStorage = () => {
    const reading = ++storageReading;
    void storage.report().then((current) => {
      if (reading === storageReading && JSON.stringify(current) !== JSON.stringify(storageReport)) {
        storageReport = current;
        bound?.update();
      }
    });
  };
  const ledger = createLedger({ path: files.running });
  const leftovers = await ledger.cleanup();
  if (leftovers.length > 0) {
    log(`Stopped ${leftovers.length} process tree(s) left running by an earlier runner: ${leftovers.join(", ")}`);
  }
  let programs: ProgramReport[] = [];
  let allowances: AllowanceReading[] = [];
  let bound: RunnerLink | undefined;
  let updater: Updater | undefined;
  let programUpdater: ReturnType<typeof createProgramUpdater> | undefined;
  let updatingPrograms = false;
  let load: MachineLoad = { cpuPercent: null, ownCpuPercent: null, gpuPercent: null, sampledAt: Date.now() };
  const queued: WorkMessage[] = [];
  const works = createWorks({
    home: files.home,
    environment: options.environment,
    send: (message) => bound?.send(message),
    ledger,
    log,
    machine: config.name,
    storage: () => storage.selection(),
    changed: () => {
      bound?.update();
      updater?.changed();
      programUpdater?.changed();
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...options.work,
  });
  const busy = () => works.busy() + checks.busy();
  const checks = createChecks({
    home: files.home, environment: options.environment, storage: () => storage.selection(), ledger, log,
    available: () => !updatingPrograms && busy() < config.slots,
    send: (reply) => bound?.send(reply),
    changed: () => { bound?.update(); updater?.changed(); programUpdater?.changed(); },
  });
  let requestAllowance: () => void = () => undefined;
  let setAllowanceMode: (read: boolean) => void = () => undefined;
  let requestPrograms: (id: string) => void = () => undefined;
  const report = () => ({
    ...machineReport(config.slots, programs, platform, allowances, updatingPrograms ? config.slots : busy()),
    repositoryChecks: true as const,
    updatingPrograms,
    storage: storageReport,
    load,
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  const link = createRunnerLink({
    config,
    setStorage: (settings) => { storage.apply(settings); refreshStorage(); },
    refreshAllowance: () => requestAllowance(),
    allowanceMode: (read) => setAllowanceMode(read),
    refreshPrograms: (id) => requestPrograms(id),
    report,
    check: checks.receive,
    works: () => ({ ...works, receive: (message) => { if (updatingPrograms) queued.push(message); else works.receive(message); } }),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
    onEvent: (event) => {
      log(describe(event));
      if (event.type === "connected") {
        updater?.confirmed();
        options.confirmed?.();
        updater?.announced(event.version);
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
      busy: () => busy() + (updatingPrograms ? 1 : 0),
      restart: options.restart ?? (() => undefined),
      log,
      now,
    });
  }
  const prober = options.prober ?? systemProber({ environment: options.environment, cwd: files.probe });
  const definitions = programDefinitions(config.models);
  let probing = false;
  const checkSignIn = options.checkSignIn
    ? (id: ProgramReport["id"], path: string, version: string | null) => programSignedIn(id, path, version, options.environment, prober)
    : undefined;
  const probe = async () => {
    const previous = programs;
    programs = (await probePrograms(definitions, prober, checkSignIn)).map((program) => {
      const prior = previous.find((entry) => entry.id === program.id && entry.installed && program.installed && entry.path === program.path);
      return prior?.update === undefined ? program : { ...program, update: prior.update };
    });
    log(
      `Programs: ${programs.filter(programIsConfigured)
        .map((program) => `${program.id} ${program.version ?? "?"} (${program.models.length} models from ${program.source})`)
        .join(", ") || "none signed in"}`,
    );
    link.update();
  };
  let flushPrograms: () => void = () => undefined;
  if (options.environment.SUPERAGENT2_PROGRAM_AUTO_UPDATE !== "0") {
    programUpdater = createProgramUpdater({
      steps: options.programUpdateSteps ?? systemProgramUpdateSteps(prober),
      busy: () => busy() + (probing ? 1 : 0),
      report: () => programs,
      publish: (reports) => { programs = reports; link.update(); },
      reprobe: probe,
      lock: (active) => {
        updatingPrograms = active;
        link.update();
        if (!active) for (const message of queued.splice(0)) works.receive(message);
        if (!active) { updater?.changed(); flushPrograms(); }
      },
      log,
    });
  }
  link.start();
  const sampleLoad = options.sampleLoad ?? createLoadSampler({ platform });
  let readingLoad = false;
  let closed = false;
  const refreshLoad = () => {
    if (readingLoad) return;
    readingLoad = true;
    void sampleLoad().then((reading) => {
      if (!closed && loadChanged(load, reading)) {
        load = reading;
        link.update();
      }
    }).catch(() => undefined).finally(() => { readingLoad = false; });
  };
  refreshLoad();
  const loadTimer = setInterval(refreshLoad, loadSampleInterval);
  loadTimer.unref();
  refreshStorage();
  const storageTimer = setInterval(refreshStorage, 30000);
  storageTimer.unref();
  const probed = probe().then(() => programUpdater?.check()).catch((error: unknown) => log(`Could not list the programs: ${error instanceof Error ? error.message : String(error)}`));
  const timer = setInterval(() => {
    if (!updatingPrograms && !probing) {
      probing = true;
      void probe().then(() => programUpdater?.check()).catch(() => undefined).finally(() => {
        probing = false;
        flushPrograms();
        programUpdater?.changed();
      });
    }
  }, options.reprobeMilliseconds ?? 6 * 60 * 60 * 1000);
  timer.unref();
  let reading: Promise<void> | undefined;
  let readsAllowance = platform !== "win32";
  let lastAllowanceRead: number | undefined;
  const readAllowance = (): Promise<void> => {
    if (!readsAllowance) return Promise.resolve();
    if (reading !== undefined) return reading;
    reading = (async () => {
      try {
        lastAllowanceRead = now();
        allowances = await readAllowances(prober, programs, now);
        log(
          `Allowance: ${allowances
            .map((entry) => (entry.program === "dsh" ? `dsh ${entry.available === null ? "unknown" : "read"}` : entry.state === "unknown" ? `${entry.program} unknown` : `${entry.program} ${entry.state} with ${entry.remainingPercent ?? "?"}% left`))
            .join(", ")}`,
        );
        link.update();
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };
  const pendingPrograms: string[] = [];
  flushPrograms = () => {
    if (updatingPrograms || probing || pendingPrograms.length === 0) return;
    probing = true;
    void (async () => {
      const ids = pendingPrograms.splice(0);
      try {
        await probed;
        if (updatingPrograms) { pendingPrograms.unshift(...ids); return; }
        await probe();
        if (reading !== undefined) await reading;
        await readAllowance();
        for (const id of ids) link.send({ type: "report", machine: report(), refreshId: id });
      } catch (error) {
        log(`Could not recheck the programs: ${String(error)}`);
      } finally {
        probing = false;
        flushPrograms();
        programUpdater?.changed();
      }
    })();
  };
  requestPrograms = (id) => { pendingPrograms.push(id); flushPrograms(); };
  requestAllowance = () => { void probed.then(readAllowance).catch(() => undefined); };
  const allowanceRead = probed.then(readAllowance).catch((error: unknown) => log(`Could not read the allowance: ${error instanceof Error ? error.message : String(error)}`));
  const allowanceInterval = options.allowanceMilliseconds ?? 10 * 60 * 1000;
  let allowanceTimer: ReturnType<typeof setInterval> | undefined;
  const scheduleAllowance = () => {
    clearInterval(allowanceTimer);
    allowanceTimer = undefined;
    if (!readsAllowance || closed) return;
    allowanceTimer = setInterval(() => {
      void readAllowance().catch(() => undefined);
    }, allowanceInterval);
    allowanceTimer.unref();
  };
  scheduleAllowance();
  setAllowanceMode = (read) => {
    if (platform !== "win32" || read === readsAllowance || closed) return;
    readsAllowance = read;
    log(read
      ? "No macOS or Linux runner is online, so this Windows runner reads the allowance"
      : "A macOS or Linux runner is online, so this Windows runner stops reading the allowance");
    scheduleAllowance();
    if (read && (lastAllowanceRead === undefined || now() - lastAllowanceRead >= allowanceInterval)) requestAllowance();
  };
  return {
    link,
    works,
    updater,
    probed,
    allowanceRead,
    close: async () => {
      closed = true;
      clearInterval(loadTimer);
      clearInterval(timer);
      clearInterval(allowanceTimer);
      clearInterval(storageTimer);
      await programUpdater?.close();
      await checks.close();
      await works.close();
      await link.close();
    },
  };
}
