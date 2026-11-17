import type { AddressInfo } from "node:net";
import { createAccessVerifier, ownerOnly } from "./access.js";
import { type Clock, systemClock } from "./clock.js";
import { allowEverything, type CommandGate, type CommandService, createCommandService } from "./commands.js";
import type { Config } from "./config.js";
import { type CredentialSource, environmentCredentials } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { lockSettings } from "./irreversible.js";
import { createKeyCache, fetchKeySource, type KeySource } from "./keys.js";
import { type ConfirmationLock, createConfirmationLock } from "./lock.js";
import { createHubServer } from "./server.js";
import { type Environment, localTarget, sshTarget, type Target } from "./targets.js";

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
  let lock: ConfirmationLock | undefined;
  try {
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
      targets: options.targets ?? defaultTargets(config, environment),
      credentials: options.credentials ?? environmentCredentials(environment),
      gate: options.gate ?? lock?.gate ?? allowEverything,
    });
  } catch (error) {
    database.close();
    throw error;
  }
  try {
    const server = createHubServer({ database, commands, verify, admit: ownerOnly(config.ownerEmail), ...(lock === undefined ? {} : { lock }) });
    const address = await server.listen(config.port, config.host);
    return {
      database,
      commands,
      lock,
      address,
      close: async () => {
        try {
          await server.close();
        } finally {
          await commands.close();
          database.close();
        }
      },
    };
  } catch (error) {
    await commands.close();
    database.close();
    throw error;
  }
}
