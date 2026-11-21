import type { Provider } from "@super-agent2/protocol";
import type { Clock } from "@super-agent2/programs";

export interface Unavailability {
  readonly reason: string;
  readonly until: number | null;
}

export interface ProviderChoice {
  order(): Provider[];
  setOrder(order: readonly Provider[]): boolean;
  candidates(): Provider[];
  markUnavailable(provider: Provider, reason: string, until: number | null): void;
  markAvailable(provider: Provider): void;
  reasons(): ReadonlyMap<Provider, Unavailability>;
}

export function createProviderChoice(initial: readonly Provider[], clock: Clock): ProviderChoice {
  const unavailable = new Map<Provider, Unavailability>();
  let order: readonly Provider[] = [...initial];
  return {
    order: () => [...order],
    setOrder: (next) => {
      const unique = next.filter((provider, index) => next.indexOf(provider) === index);
      if (unique.length === 0 || (unique.length === order.length && unique.every((provider, index) => order[index] === provider))) {
        return false;
      }
      order = unique;
      return true;
    },
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
