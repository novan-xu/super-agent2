import type { Provider } from "@super-agent2/protocol";
import type { Clock } from "@super-agent2/programs";

export interface Unavailability {
  readonly reason: string;
  readonly until: number | null;
}

export interface ProviderChoice {
  candidates(): Provider[];
  markUnavailable(provider: Provider, reason: string, until: number | null): void;
  markAvailable(provider: Provider): void;
  reasons(): ReadonlyMap<Provider, Unavailability>;
}

export function providerOrder(preferred: readonly Provider[], fallback: Provider): Provider[] {
  const order = preferred.filter((provider, index) => provider !== fallback && preferred.indexOf(provider) === index);
  return [...order, fallback];
}

export function createProviderChoice(order: readonly Provider[], clock: Clock): ProviderChoice {
  const unavailable = new Map<Provider, Unavailability>();
  return {
    candidates: () =>
      order.filter((provider) => {
        const state = unavailable.get(provider);
        return state === undefined || state.until === null || state.until <= clock.now();
      }),
    markUnavailable: (provider, reason, until) => {
      unavailable.set(provider, { reason, until });
    },
    markAvailable: (provider) => {
      unavailable.delete(provider);
    },
    reasons: () => unavailable,
  };
}
