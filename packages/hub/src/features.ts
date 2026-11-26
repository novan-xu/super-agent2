import { type AppGatewayStatus, type BrainSettings, type ExtraMcpServer, type HubFeature, type HubFeatures, type MachineStatus, programIds, programIsConfigured } from "@super-agent2/protocol";
import type { Config } from "./config.js";
import type { Environment } from "./targets.js";

interface FeatureOptions {
  readonly config: Config;
  readonly environment: Environment;
  readonly appGateway: boolean;
  readonly mailIntake: boolean;
  readonly inboxSources: boolean;
  readonly extraMcp: { readonly brain: readonly ExtraMcpServer[]; readonly workers: readonly ExtraMcpServer[] };
}

export function configuredFeatures({ config, environment, appGateway, mailIntake, inboxSources, extraMcp }: FeatureOptions) {
  const configured = {
    access: config.accessAudience !== undefined,
    inbox: config.accessInboxAudience !== undefined,
    inboxSources: config.accessInboxAudience !== undefined && inboxSources,
    oauthMcp: config.accessMcpAudience !== undefined,
    deviceTransfer: config.deviceTransfer === true,
    push: config.vapid !== undefined,
    voice: !!environment.OPENAI_API_KEY?.trim(),
    officePreviews: config.converterUrl !== undefined,
    openaiCosts: !!environment.OPENAI_ADMIN_KEY?.trim(),
    appGateway,
    agentWring: extraMcp.workers.some(({ name }) => name.toLowerCase() === "agent_wring"),
    woodpecker: !!environment.WOODPECKER_SERVER?.trim() && !!environment.WOODPECKER_TOKEN?.trim(),
    workRequests: config.workRequests !== undefined,
  } satisfies Partial<Record<HubFeature, boolean>>;
  const enabled: HubFeature[] = (Object.keys(configured) as (keyof typeof configured)[]).filter((feature) => configured[feature]);
  const names = [...new Set([...extraMcp.brain, ...extraMcp.workers].map(({ name }) => name))];

  return {
    enabled,
    snapshot(machines: readonly MachineStatus[], brain: BrainSettings, apps?: AppGatewayStatus): HubFeatures {
      const present = new Set(machines.flatMap(({ report }) => report?.programs.filter(programIsConfigured).map(({ id }) => id) ?? []));
      const mail = (apps?.mailboxes.length ?? 0) > 0;
      const live: HubFeature[] = [];
      if (mail) live.push("mail");
      if (mail && mailIntake) live.push("mailIntake");
      if (apps?.teams === true) live.push("teams");
      if (apps?.ticktick === true) live.push("ticktick");
      return { enabled: [...enabled, ...live], workerPrograms: programIds.filter((id) => present.has(id)), brainProviders: brain.providers.map(({ provider }) => provider), extraMcp: names };
    },
  };
}
