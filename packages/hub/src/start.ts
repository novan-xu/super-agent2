import type { Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { cloudflareServiceTokens, cloudflareSettings } from "./cloudflare.js";
import { type Hub, startHub } from "./hub.js";
import type { KeySource } from "./keys.js";

export interface StartOptions {
  readonly report: (line: string) => void;
  readonly keySource?: KeySource;
  readonly clock?: Clock;
}

export async function startFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: StartOptions,
): Promise<Hub | undefined> {
  const loaded = loadConfig(env);
  if (!loaded.ok) {
    options.report("The hub cannot start because its configuration is invalid:");
    for (const problem of loaded.problems) {
      options.report(`  ${problem}`);
    }
    return undefined;
  }
  const cloudflare = cloudflareSettings(env);
  const hub = await startHub({
    config: loaded.config,
    environment: env,
    report: options.report,
    ...("missing" in cloudflare ? {} : { serviceTokens: cloudflareServiceTokens(cloudflare), inboxServiceTokens: cloudflareServiceTokens(cloudflare, "inbox") }),
    ...(options.keySource === undefined ? {} : { keySource: options.keySource }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  options.report(`Hub listening on ${hub.address.address}:${hub.address.port}`);
  return hub;
}
