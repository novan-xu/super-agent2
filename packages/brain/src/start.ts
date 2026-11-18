import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { brainToolsPath, providers, startingEngineTable } from "@super-agent2/protocol";
import { type Brain, createBrain } from "./brain.js";
import type { Clock } from "@super-agent2/programs";
import { type BrainConfig, loadBrainConfig } from "./config.js";
import { createHubLink, type HubLink } from "./link.js";
import type { ProgramAdapter } from "@super-agent2/programs";
import { conversationVariable, programAdapter, toolTokenVariable, turnVariable } from "@super-agent2/programs";
import { startProgramUpdates } from "./program-update.js";
import { join, delimiter } from "node:path";
import { prepareWorkspace } from "./workspace.js";

export interface RunningBrain {
  readonly brain: Brain;
  readonly link: HubLink;
  close(): Promise<void>;
}

export function startBrain(config: BrainConfig, environment: Readonly<Record<string, string | undefined>>, clock: Clock, report: (line: string) => void): RunningBrain {
  const token = readFileSync(config.tokenFile, "utf8").trim();
  prepareWorkspace(config.workspace);
  const programDir = environment.BRAIN_PROGRAM_DIR;
  const programEnvironment = programDir === undefined ? environment : { ...environment, PATH: `${join(programDir, "bin")}${delimiter}${environment.PATH ?? ""}` };
  const adapters = new Map<BrainConfig["order"][number], ProgramAdapter>(
    providers.map((provider) => [provider, programAdapter(provider, { ...config.providers[provider], environment: programEnvironment, clock })]),
  );
  const routerWorkspace = mkdtempSync(join(tmpdir(), "super-agent2-router-"));
  const routerEnvironment = { ...programEnvironment };
  delete routerEnvironment[toolTokenVariable];
  delete routerEnvironment[conversationVariable];
  delete routerEnvironment[turnVariable];
  const routerModels = {
    claude: startingEngineTable.claude.mechanical.model,
    gpt: startingEngineTable.codex.mechanical.model,
    deepseek: startingEngineTable.dsh.mechanical.model,
  };
  const routerAdapters = new Map<BrainConfig["order"][number], ProgramAdapter>(
    providers.map((provider) => [provider, programAdapter(provider, {
      ...config.providers[provider], model: routerModels[provider], effort: "low", environment: routerEnvironment, clock, processTree: true,
    })]),
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
    router: { adapters: routerAdapters, workspace: routerWorkspace },
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
      try {
        await brain.close();
      } finally {
        rmSync(routerWorkspace, { recursive: true, force: true });
      }
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
