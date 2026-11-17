import { readFileSync } from "node:fs";
import { brainToolsPath } from "@super-agent2/protocol";
import { type Brain, createBrain } from "./brain.js";
import type { Clock } from "./clock.js";
import { type BrainConfig, loadBrainConfig } from "./config.js";
import { createHubLink, type HubLink } from "./link.js";
import type { ProgramAdapter } from "./program.js";
import { programAdapter } from "./programs/index.js";
import { prepareWorkspace } from "./workspace.js";

export interface RunningBrain {
  readonly brain: Brain;
  readonly link: HubLink;
  close(): Promise<void>;
}

export function startBrain(config: BrainConfig, environment: Readonly<Record<string, string | undefined>>, clock: Clock, report: (line: string) => void): RunningBrain {
  const token = readFileSync(config.tokenFile, "utf8").trim();
  prepareWorkspace(config.workspace);
  const adapters = new Map<BrainConfig["order"][number], ProgramAdapter>(
    config.order.map((provider) => [provider, programAdapter(provider, { ...config.providers[provider], environment, clock })]),
  );
  const link = createHubLink({ hubUrl: config.hubUrl, token, report });
  const brain = createBrain({
    adapters,
    order: config.order,
    transport: link,
    clock,
    tools: { url: new URL(brainToolsPath, config.hubUrl).toString(), token },
    workspace: config.workspace,
    maximumOpen: config.maximumOpen,
  });
  link.bind({ receive: (message) => brain.receive(message), running: () => brain.running() });
  link.connect();
  return {
    brain,
    link,
    close: async () => {
      await link.close();
      await brain.close();
    },
  };
}

export function startFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  clock: Clock,
  report: (line: string) => void,
): RunningBrain | undefined {
  const loaded = loadBrainConfig(environment);
  if (!loaded.ok) {
    report("The brain cannot start because its configuration is invalid:");
    for (const problem of loaded.problems) {
      report(`  ${problem}`);
    }
    return undefined;
  }
  return startBrain(loaded.config, environment, clock, report);
}
