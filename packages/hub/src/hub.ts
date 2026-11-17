import type { AddressInfo } from "node:net";
import { createAccessVerifier, ownerOnly } from "./access.js";
import { type Clock, systemClock } from "./clock.js";
import type { Config } from "./config.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { createKeyCache, fetchKeySource, type KeySource } from "./keys.js";
import { createHubServer } from "./server.js";

export interface HubOptions {
  readonly config: Config;
  readonly keySource?: KeySource;
  readonly clock?: Clock;
}

export interface Hub {
  readonly database: HubDatabase;
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export async function startHub(options: HubOptions): Promise<Hub> {
  const clock = options.clock ?? systemClock;
  const { config } = options;
  const database = openDatabase({ dataDir: config.dataDir, clock });
  try {
    const keys = createKeyCache({ source: options.keySource ?? fetchKeySource(config.accessTeam), clock });
    const verify = createAccessVerifier({ team: config.accessTeam, audience: config.accessAudience, keys, clock });
    const server = createHubServer({ database, verify, admit: ownerOnly(config.ownerEmail) });
    const address = await server.listen(config.port, config.host);
    return {
      database,
      address,
      close: async () => {
        try {
          await server.close();
        } finally {
          database.close();
        }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
