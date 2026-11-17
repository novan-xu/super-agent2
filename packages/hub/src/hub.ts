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
import { createHubServer, type HubServer } from "./server.js";
import { type Environment, localTarget, sshTarget, type Target } from "./targets.js";
import { createToolServer } from "./tools.js";

export interface HubOptions {
  readonly config: Config;
  readonly keySource?: KeySource;
  readonly clock?: Clock;
  readonly environment?: Environment;
  readonly targets?: readonly Target[];
  readonly credentials?: CredentialSource;
  readonly gate?: CommandGate;
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
  let server: HubServer;
  const targets = options.targets ?? defaultTargets(config, environment);
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
    server = createHubServer({
      database,
      commands,
      verify,
      admit: ownerOnly(config.ownerEmail),
      conversations,
      tools: createToolServer({ commands, conversations, targets: () => targets.map((target) => target.name) }),
      brainToken,
      ...(lock === undefined ? {} : { lock }),
    });
  } catch (error) {
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
      address,
      close: async () => {
        try {
          await server.close();
        } finally {
          conversations.close();
          await commands.close();
          database.close();
        }
      },
    };
  } catch (error) {
    conversations.close();
    await commands.close();
    database.close();
    throw error;
  }
}
