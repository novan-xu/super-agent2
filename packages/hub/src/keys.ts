import { AccessKeySet } from "@super-agent2/protocol";
import type { Clock } from "./clock.js";

export type KeySource = () => Promise<AccessKeySet>;

export function certificatesUrl(team: string): string {
  return `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

export function fetchKeySource(team: string, fetcher: typeof fetch = fetch): KeySource {
  const url = certificatesUrl(team);
  return async () => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) {
      throw new Error(`Fetching ${url} answered ${response.status}`);
    }
    return AccessKeySet.parse(await response.json());
  };
}

export interface KeyCacheOptions {
  readonly source: KeySource;
  readonly clock: Clock;
  readonly maxAgeMs?: number;
  readonly refreshCooldownMs?: number;
}

export interface KeyCache {
  keysFor(kid: string): Promise<AccessKeySet>;
}

export function createKeyCache(options: KeyCacheOptions): KeyCache {
  const maxAge = options.maxAgeMs ?? 10 * 60_000;
  const cooldown = options.refreshCooldownMs ?? 30_000;
  let cached: { readonly set: AccessKeySet; readonly at: number } | undefined;
  let pending: Promise<AccessKeySet> | undefined;

  const refresh = (): Promise<AccessKeySet> => {
    pending ??= options
      .source()
      .then((set) => {
        const parsed = AccessKeySet.parse(set);
        cached = { set: parsed, at: options.clock.now() };
        return parsed;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  return {
    async keysFor(kid) {
      const now = options.clock.now();
      if (cached === undefined || now - cached.at >= maxAge) {
        return refresh();
      }
      if (cached.set.keys.some((key) => key.kid === kid)) {
        return cached.set;
      }
      if (now - cached.at >= cooldown) {
        return refresh();
      }
      return cached.set;
    },
  };
}
