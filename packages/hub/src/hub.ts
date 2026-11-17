import type { AddressInfo } from "node:net";
import { createAccessVerifier, ownerOnly } from "./access.js";
import { brainTokenCheck, ensureBrainToken } from "./brain-token.js";
import { type Clock, systemClock } from "./clock.js";
import { allowEverything, type CommandGate, type CommandService, createCommandService } from "./commands.js";
import type { Config } from "./config.js";
import { type ConversationService, createConversationService } from "./conversations.js";
import { type CredentialSource, environmentCredentials } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { lockSettings } from "./irreversible.js";
import { createKeyCache, fetchKeySource, type KeySource } from "./keys.js";
import { type ConfirmationLock, createConfirmationLock } from "./lock.js";
import { pageFiles } from "./page.js";
import { createPushService, type PushService } from "./push-service.js";
import { createHubServer, type HubServer } from "./server.js";
import { createWaiting, type Waiting } from "./waiting.js";
import { createMachineStore, type MachineStore } from "./machines.js";
import { createRunners, type Runners } from "./runners.js";
import { combinedTargets, type Environment, fixedTargets, localTarget, sshTarget, type Target } from "./targets.js";
import { createToolServer } from "./tools.js";
import { commandIssueHost, createIssueFiler, type IssueHost } from "./filing.js";
import { createTicketService, type TicketService, type TicketWork } from "./tickets.js";

export interface HubOptions {
  readonly config: Config;
  readonly keySource?: KeySource;
  readonly clock?: Clock;
  readonly environment?: Environment;
  readonly targets?: readonly Target[];
  readonly credentials?: CredentialSource;
  readonly gate?: CommandGate;
  readonly pushFetch?: typeof fetch;
  readonly machinePollMilliseconds?: number;
  readonly heartbeatMilliseconds?: number;
  readonly issueHost?: IssueHost;
  readonly ticketWork?: TicketWork;
}

export function defaultTargets(config: Config, environment: Environment): Target[] {
  const targets = [localTarget({ environment })];
  if (config.nas !== undefined) {
    targets.push(sshTarget(config.nas, environment));
  }
  return targets;
}

export interface Hub {
  readonly database: HubDatabase;
  readonly commands: CommandService;
  readonly conversations: ConversationService;
  readonly lock: ConfirmationLock | undefined;
  readonly waiting: Waiting;
  readonly push: PushService | undefined;
  readonly machines: MachineStore;
  readonly runners: Runners;
  readonly tickets: TicketService;
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export async function startHub(options: HubOptions): Promise<Hub> {
  const clock = options.clock ?? systemClock;
  const { config } = options;
  const database = openDatabase({ dataDir: config.dataDir, clock });
  const environment = options.environment ?? process.env;
  const keys = createKeyCache({ source: options.keySource ?? fetchKeySource(config.accessTeam), clock });
  const verify = createAccessVerifier({ team: config.accessTeam, audience: config.accessAudience, keys, clock });
  let commands: CommandService;
  let conversations: ConversationService;
  let lock: ConfirmationLock | undefined;
  let waiting: Waiting;
  let push: PushService | undefined;
  let server: HubServer;
  const machines = createMachineStore(database, clock);
  const runners = createRunners({
    machines,
    ...(options.machinePollMilliseconds === undefined ? {} : { pollMilliseconds: options.machinePollMilliseconds }),
  });
  const tickets = createTicketService({ database, clock, ...(options.ticketWork === undefined ? {} : { work: options.ticketWork }) });
  const targets = combinedTargets(fixedTargets(options.targets ?? defaultTargets(config, environment)), runners);
  try {
    const brainToken = brainTokenCheck(ensureBrainToken(config.brainTokenFile));
    lock =
      options.gate === undefined
        ? createConfirmationLock({
            database,
            clock,
            verify,
            ownerEmail: config.ownerEmail,
            settings: lockSettings({ projectFolders: config.projectFolders, credentialPaths: config.credentialPaths }),
          })
        : undefined;
    commands = createCommandService({
      database,
      clock,
      targets,
      credentials: options.credentials ?? environmentCredentials(environment),
      gate: options.gate ?? lock?.gate ?? allowEverything,
    });
    conversations = createConversationService({ database, clock, commands });
    waiting = createWaiting({ commands, lock });
    push =
      config.vapid === undefined
        ? undefined
        : createPushService({ database, clock, settings: config.vapid, fetch: options.pushFetch ?? fetch, waiting });
    server = createHubServer({
      database,
      commands,
      verify,
      admit: ownerOnly(config.ownerEmail),
      conversations,
      waiting,
      tools: createToolServer({
        commands,
        conversations,
        targets: () => targets.names(),
        machines: () => runners.describe(),
        tickets: { tickets, filer: createIssueFiler({ host: options.issueHost ?? commandIssueHost({ commands }), tickets, database, clock }) },
      }),
      tickets,
      brainToken,
      runners,
      ...(options.heartbeatMilliseconds === undefined ? {} : { heartbeatMilliseconds: options.heartbeatMilliseconds }),
      ...(push === undefined ? {} : { push }),
      ...(lock === undefined ? {} : { lock }),
      ...(config.pageDir === undefined ? {} : { page: pageFiles(config.pageDir) }),
    });
  } catch (error) {
    runners.close();
    database.close();
    throw error;
  }
  try {
    const address = await server.listen(config.port, config.host);
    return {
      database,
      commands,
      conversations,
      lock,
      waiting,
      push,
      machines,
      runners,
      tickets,
      address,
      close: async () => {
        try {
          runners.close();
          await server.close();
        } finally {
          waiting.close();
          await push?.close();
          conversations.close();
          await commands.close();
          database.close();
        }
      },
    };
  } catch (error) {
    runners.close();
    waiting.close();
    await push?.close();
    conversations.close();
    await commands.close();
    database.close();
    throw error;
  }
}
