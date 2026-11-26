import { readFileSync } from "node:fs";
import { brainToolsPath, type Provider, providers } from "@super-agent2/protocol";
import { type Brain, createBrain } from "./brain.js";
import type { Clock } from "@super-agent2/programs";
import { type BrainConfig, loadBrainConfig } from "./config.js";
import { createHubLink, type HubLink } from "./link.js";
import type { ProgramAdapter } from "@super-agent2/programs";
import { programAdapter } from "@super-agent2/programs";
import { startProgramUpdates } from "./program-update.js";
import { join, delimiter } from "node:path";
import { prepareWorkspace } from "./workspace.js";

export interface RunningBrain {
  readonly brain: Brain;
  readonly link: HubLink;
  close(): Promise<void>;
}

export function startBrain(config: BrainConfig, environment: Readonly<Record<string, string | undefined>>, clock: Clock, report: (line: string) => void, available: readonly Provider[] = providers): RunningBrain {
  const token = readFileSync(config.tokenFile, "utf8").trim();
  prepareWorkspace(config.workspace);
  const programDir = environment.BRAIN_PROGRAM_DIR;
  const programEnvironment = programDir === undefined ? environment : { ...environment, PATH: `${join(programDir, "bin")}${delimiter}${environment.PATH ?? ""}` };
  const adapters = new Map<BrainConfig["order"][number], ProgramAdapter>(
    available.map((provider) => [provider, programAdapter(provider, { ...config.providers[provider], environment: programEnvironment, clock })]),
  );
  const link = createHubLink({ hubUrl: config.hubUrl, token, report });
  const brain = createBrain({
    adapters,
    order: config.order,
    transport: link,
    clock,
    tools: { url: new URL(brainToolsPath, config.hubUrl).toString(), token },
    workspace: config.workspace,
    attachments: config.attachments,
    maximumOpen: config.maximumOpen,
    idleMilliseconds: config.idleMilliseconds,
    seedSoftShare: config.seedSoftShare,
    inputCapacity: config.inputCapacity,
  });
  const stopUpdates = programDir === undefined ? () => undefined : startProgramUpdates(brain, programDir, report);
  link.bind({ receive: (message) => brain.receive(message), running: () => brain.running(), status: () => brain.status() });
  link.connect();
  return {
    brain,
    link,
    close: async () => {
      stopUpdates();
      await link.close();
      await brain.close();
    },
  };
}

export function startFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  clock: Clock,
  report: (line: string) => void,
  available?: readonly Provider[],
): RunningBrain | undefined {
  const loaded = loadBrainConfig(environment);
  if (!loaded.ok) {
    report("The brain cannot start because its configuration is invalid:");
    for (const problem of loaded.problems) {
      report(`  ${problem}`);
    }
    return undefined;
  }
  return startBrain(loaded.config, environment, clock, report, available);
}
